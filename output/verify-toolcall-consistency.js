/* 验证提示词（buildToolsText）与解析执行（parseToolCalls）的一致性修复：
 * 1) driver 解析端按 schema 的 required 补全缺失必填参数（description 等）
 * 2) 网关提示词强化必填规则 + 示例优先 bash 并演示 description */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(desc, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + desc); }
  else { fail++; failures.push(desc + (detail ? ' | ' + detail : '')); console.log('  FAIL ' + desc + (detail ? ' | ' + detail : '')); }
}

/* ---------- 1. driver 解析端 ---------- */
const driverSrc = fs.readFileSync(path.join(root, 'resources', 'driver.js'), 'utf8');
const fnStart = driverSrc.indexOf('function parseToolCalls');
const fnEnd = driverSrc.indexOf('\nhandlers.streamAsk', fnStart);
eval(driverSrc.slice(fnStart, fnEnd));

/* 真实 DSH bash 工具 schema（required 含 command + description，与 DSH 校验一致） */
const dshTools = [
  { function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to run' }, description: { type: 'string', description: 'Explain what this command does and why' }, timeoutMs: { type: 'number' }, workdir: { type: 'string' }, run_in_background: { type: 'boolean' }, sandbox_permissions: { type: 'string' }, justification: { type: 'string' } }, required: ['command', 'description'] } } },
  { function: { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } } },
  { function: { name: 'write', description: 'Write file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' }, justification: { type: 'string' } }, required: ['file_path', 'content', 'justification'] } } },
  { function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

console.log('\n== driver parseToolCalls 必填补全 ==');

/* 场景 1（用户报告）：{"name":"bash","args":{"command":"pwd"}} 缺 description */
const r1 = parseToolCalls('{"name": "bash", "args": {"command": "pwd"}}', dshTools);
let a1 = null;
try { a1 = r1.length ? JSON.parse(r1[0].arguments || '{}') : null; } catch (e) { a1 = null; }
check('场景1: 缺 description 仍解析出 bash', r1.length === 1 && r1[0].name === 'bash', JSON.stringify(r1).slice(0, 200));
check('场景1: description 被补全', a1 && typeof a1.description === 'string' && a1.description.length > 0, JSON.stringify(a1));
check('场景1: command 保留', a1 && a1.command === 'pwd', JSON.stringify(a1));
check('场景1: 非必填 timeoutMs 不补', a1 && a1.timeoutMs === undefined, JSON.stringify(a1));

/* 场景 2：模型已给 description → 不被覆盖 */
const r2 = parseToolCalls('```tool_call\n{"name": "bash", "args": {"command": "ls -la", "description": "查看当前目录"}}\n```', dshTools);
let a2 = null;
try { a2 = r2.length ? JSON.parse(r2[0].arguments || '{}') : null; } catch (e) { a2 = null; }
check('场景2: 已有 description 不被覆盖', a2 && a2.description === '查看当前目录', JSON.stringify(a2));

/* 场景 3：write 缺 justification → 补全（说明型） */
const r3 = parseToolCalls('{"name": "write", "args": {"file_path": "a.txt", "content": "hi"}}', dshTools);
let a3 = null;
try { a3 = r3.length ? JSON.parse(r3[0].arguments || '{}') : null; } catch (e) { a3 = null; }
check('场景3: write 缺 justification 被补全', a3 && typeof a3.justification === 'string' && a3.justification.length > 0, JSON.stringify(a3));

/* 场景 4：args 容器 + 别名（cmd→command）同时补全 */
const r4 = parseToolCalls('{"name": "bash", "args": {"cmd": "pwd"}}', dshTools);
let a4 = null;
try { a4 = r4.length ? JSON.parse(r4[0].arguments || '{}') : null; } catch (e) { a4 = null; }
check('场景4: cmd 别名→command + description 补全', a4 && a4.command === 'pwd' && typeof a4.description === 'string' && a4.description.length > 0, JSON.stringify(a4));

/* 场景 5：required 缺失的 schema（旧测试工具集）行为不变 */
const legacyTools = [
  { function: { name: 'pwsh', parameters: { properties: { command: {}, description: {} } } } },
  { function: { name: 'write', parameters: { properties: { file_path: {}, content: {} } } } },
];
const r5 = parseToolCalls('{"name": "pwsh", "args": {"command": "echo hi"}}', legacyTools);
let a5 = null;
try { a5 = r5.length ? JSON.parse(r5[0].arguments || '{}') : null; } catch (e) { a5 = null; }
check('场景5: 无 required 的 schema 不新增键', r5.length === 1 && a5 && a5.description === undefined, JSON.stringify(a5));

/* 场景 6：工具名不在列表（幻觉）仍拒绝 */
const r6 = parseToolCalls('{"name": "fantasy_tool", "args": {"x": 1}}', dshTools);
check('场景6: 幻觉工具名仍拒绝转发', r6.length === 0, JSON.stringify(r6));

/* ---------- 2. 网关提示词 ---------- */
const gwSrc = fs.readFileSync(path.join(root, 'resources', 'dsweb-gateway.js'), 'utf8');
const gStart = gwSrc.indexOf('function buildToolsText');
const gEnd = gwSrc.indexOf('/* ---------- SSE 输出 ---------- */', gStart);
eval(gwSrc.slice(gStart, gEnd));

const prompt = buildToolsText(dshTools);
console.log('\n== gateway buildToolsText ==');
console.log('---- 提示词输出（前 1200 字符）----');
console.log(prompt.slice(0, 1200));
console.log('----------------------------------');
check('规则含必填参数强调', prompt.includes('(必填) 参数') && prompt.includes('缺少任何一个'), '');
check('示例工具为 bash', prompt.includes('"name": "bash"'), '');
check('示例含 description 键', /"description"\s*:\s*"/.test(prompt), '');
check('示例 args 含 command', /"command"\s*:\s*"/.test(prompt), '');
check('示例格式为 tool_call 代码块', prompt.includes('```tool_call'), '');

/* 无 bash 时回退逻辑：示例仍是可用工具 */
const noBash = dshTools.filter((t) => (t.function || t).name !== 'bash');
const prompt2 = buildToolsText(noBash);
check('无 bash 时示例回退正常', prompt2.includes('调用示例'), prompt2.slice(-260));

console.log('\n========== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' ==========');
if (failures.length) { console.log('失败项:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('全部通过 ✅');
