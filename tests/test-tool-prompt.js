/* 单元测试：工具提示词优化（buildToolsText 重写 + buildContext 位置调整）
 * 旧版六个缺陷：
 *   1. 参数只有名字（无类型/枚举）——模型猜不到值类型
 *   2. 示例硬编码 "write" 工具 + Windows 路径——不在工具列表 = 邀请幻觉调用
 *   3. 描述不裁剪 → driver 端全局截断 → 尾部工具整体丢失（模型不知道它们存在）
 *   4. 未说明 [工具结果] 回传标签——模型需自己猜 delta 轮的标记含义
 *   5. 缺"无需工具直接回答"分支——过度调用工具
 *   6. 工具块由 driver 前置到最顶部——离回复点最远，格式遵守率打折
 * 运行：node tests/test-tool-prompt.js （纯离线：vm 沙箱加载网关纯函数） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GW_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');
const DRV_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'driver.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

/* ---------- 沙箱加载网关纯函数 ---------- */
function loadGateway(exports) {
  const cut = GW_SRC.indexOf('server.listen(');
  if (cut < 0) throw new Error('server.listen not found');
  const code = GW_SRC.slice(0, cut) + `
;globalThis.__x = { ${exports} };`;
  const sandbox = {
    require: (m) => {
      if (m === './provider-registry') return require(path.join(ROOT, 'resources', 'provider-registry'));
      if (m === './state-store') return require(path.join(ROOT, 'resources', 'state-store'));
      if (!['fs', 'path', 'http', 'crypto', 'child_process'].includes(m)) throw new Error('not allowed: ' + m);
      return require(m);
    },
    process: { argv: ['node', 'gw'], env: {}, on: () => {}, exit: () => {}, platform: process.platform },
    __dirname: path.join(ROOT, 'resources'),
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dsweb-gateway.js' });
  return sandbox.__x;
}
const gw = loadGateway('buildToolsText, buildContext, extractBaseline, clipText, blockText, isRuntimeContext');

/* ---------- 测试工具集 ---------- */
const TOOLS = [
  { type: 'function', function: {
    name: 'read_file',
    description: '读取指定路径的文件内容。这是一个用于读取文件的工具，支持文本文件。',
    parameters: { type: 'object', properties: {
      file_path: { type: 'string', description: '文件路径' },
      encoding: { type: 'string', enum: ['utf8', 'base64'] },
    }, required: ['file_path'] },
  } },
  { type: 'function', function: {
    name: 'run_command',
    description: '在终端执行 shell 命令并返回输出。',
    parameters: { type: 'object', properties: {
      cmd: { type: 'string' },
      timeout: { type: 'integer' },
    }, required: ['cmd'] },
  } },
];

/* ---------- 1. 参数类型与枚举 ---------- */
{
  const t = gw.buildToolsText(TOOLS);
  check('1a 必填参数带类型标注', /\(必填,string\)/.test(t), t.match(/参数[^\n]*/));
  check('1b 可选参数带类型标注', /\(string:utf8\|base64\)/.test(t), t.match(/参数[^\n]*/));
  check('1c integer 类型标注', /\(integer\)/.test(t), t.match(/参数[^\n]*/));
}

/* ---------- 2. 示例来自真实工具 ---------- */
{
  const t = gw.buildToolsText(TOOLS);
  /* 示例必须是 read_file 或 run_command 之一（read_file 必填参数最少 → 应选它） */
  check('2a 示例用真实工具（read_file，必填参数最少）', /"name": "read_file"/.test(t), t.slice(-300));
  check('2b 示例不含幻觉工具名 write', !/"name": "write"/.test(t));
  check('2c 示例不含 Windows 硬编码路径', !/C:\\\\Users/.test(t) && !/C:\\Users/.test(t));
  check('2d 示例只含必填参数（最小化）且值用参数描述', /"file_path": "文件路径"/.test(t) && !/"encoding"/.test(t.slice(t.indexOf('调用示例'))), t.slice(-300));
}

/* ---------- 3. 描述压缩（防尾部工具截断丢失） ---------- */
{
  /* 30 个工具 × 500 字符描述 = ~15KB 原始——旧版 driver 截断到 6000 会丢 ~2/3 工具 */
  const many = [];
  for (let i = 1; i <= 30; i++) {
    many.push({ type: 'function', function: {
      name: 'tool_' + String(i).padStart(2, '0'),
      description: '工具 ' + i + ' 的超长描述。' + ('细节补充说明文字。'.repeat(40)),
      parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    } });
  }
  const t = gw.buildToolsText(many);
  const names = many.map((x) => x.function.name);
  const allVisible = names.every((n) => t.indexOf(n) >= 0);
  check('3a 30 个工具全部可见（尾部工具不丢失）', allVisible, names.filter((n) => t.indexOf(n) < 0).join(','));
  check('3b 描述已压缩（长度受控）', t.length < 8000, 'len=' + t.length);
  check('3c 压缩在句子边界（以…结尾）', /…/.test(t));
  check('3d 超预算时砍示例保清单', /工具说明已达长度上限/.test(t) || t.indexOf('调用示例') >= 0);
}

/* ---------- 4. [工具结果] 标签说明 ---------- */
{
  const t = gw.buildToolsText(TOOLS);
  check('4a 说明 [工具结果] 回传标签', t.indexOf('[工具结果]') >= 0);
  check('4b 无需工具直接回答分支', /不需要工具时直接用纯文本回答/.test(t));
  check('4c 一次一个工具规则保留', /一次只调用一个工具/.test(t));
  check('4d tool_call 代码块格式保留', /```tool_call/.test(t));
}

/* ---------- 5. buildContext 位置：工具块在 [用户] 之前 ---------- */
{
  const payload = {
    messages: [
      { role: 'system', content: '你是助手。' },
      { role: 'user', content: '帮我读文件' },
    ],
  };
  const toolsText = gw.buildToolsText(TOOLS);
  const q = gw.buildContext(payload, 'first', toolsText);
  const iSys = q.indexOf('[系统设定]');
  const iTool = q.indexOf('你可以调用工具');
  const iUser = q.indexOf('[用户]');
  check('5a 顺序 sys → tools → user', iSys >= 0 && iTool > iSys && iUser > iTool, [iSys, iTool, iUser].join(','));
  /* 无工具时不注入 */
  const q2 = gw.buildContext(payload, 'first', '');
  check('5b 无工具块时不注入', q2.indexOf('你可以调用工具') < 0);
  /* delta 轮不重复携带 */
  const q3 = gw.buildContext({ messages: [
    { role: 'system', content: '你是助手。' },
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '```tool_call{...}```' },
    { role: 'tool', content: '文件内容...' },
  ] }, 'delta', toolsText);
  check('5c delta 轮不携带工具块', q3.indexOf('你可以调用工具') < 0);
  /* recovery：历史 → 工具（工具最后） */
  const q4 = gw.buildContext({ messages: [
    { role: 'system', content: '你是助手。' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ] }, 'recovery', toolsText);
  const iHist = q4.indexOf('此前的对话');
  const iTool4 = q4.indexOf('你可以调用工具');
  check('5d recovery 顺序 历史 → 工具（工具紧邻回复点）', iHist >= 0 && iTool4 > iHist);
  /* 无用户消息时工具块正常收尾（splice 边界） */
  const q5 = gw.buildContext({ messages: [{ role: 'system', content: '你是助手。' }] }, 'first', toolsText);
  check('5e 无用户消息时工具块正常注入（边界）', q5.indexOf('你可以调用工具') >= 0);
}

/* ---------- 6. driver 端拼接移除（源码断言） ---------- */
check('6a driver 不再前置拼接 toolsText', !/payload = tt \+ '\\n\\n' \+ payload/.test(DRV_SRC));
check('6b 网关 rpc 不再单独传 toolsText 参数', !/toolsText,/.test(GW_SRC.slice(GW_SRC.indexOf('const askOnce'))));

/* ---------- 7. 空工具边界 ---------- */
check('7a 无工具返回空串', gw.buildToolsText([]) === '' && gw.buildToolsText(null) === '');
{
  /* 无必填参数的工具：示例 args 为空对象 */
  const t = gw.buildToolsText([{ type: 'function', function: { name: 'list_files', description: '列出文件', parameters: { type: 'object', properties: {} } } }]);
  check('7b 无必填参数示例 args 为空对象', /"args": \{\}/.test(t), t.slice(-200));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
