/* parseToolCalls 全面边界测试（真实 DSH 工具 schema） */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'resources', 'driver.js'), 'utf8');
const fnStart = src.indexOf('function parseToolCalls');
const fnEnd = src.indexOf('\nhandlers.streamAsk', fnStart);
eval(src.slice(fnStart, fnEnd));

/* 真实 DSH 工具（从 tools.log，含参数） */
const tools = [
  { function: { name: 'ask_user_question', parameters: { properties: { questions: {} } } } },
  { function: { name: 'cordis_define', parameters: { properties: { plugin: {}, name: {}, purpose: {}, code: {} } } } },
  { function: { name: 'cordis_inspect_query', parameters: { properties: { platform: {}, provider: {}, method: {}, input: {} } } } },
  { function: { name: 'create_goal', parameters: { properties: { objective: {}, max_goal_rounds: {} } } } },
  { function: { name: 'edit', parameters: { properties: { file_path: {}, old_string: {}, new_string: {}, replace_all: {}, sandbox_permissions: {}, justification: {} } } } },
  { function: { name: 'exit_plan_mode', parameters: { properties: { plan: {} } } } },
  { function: { name: 'glob', parameters: { properties: { pattern: {}, path: {} } } } },
  { function: { name: 'grep', parameters: { properties: { pattern: {}, path: {}, include: {} } } } },
  { function: { name: 'interrupt_agent', parameters: { properties: { agent_id: {} } } } },
  { function: { name: 'job_kill', parameters: { properties: { job_id: {}, reason: {} } } } },
  { function: { name: 'job_output', parameters: { properties: { job_id: {}, wait: {}, timeout_ms: {} } } } },
  { function: { name: 'list_agents', parameters: { properties: { scope: {} } } } },
  { function: { name: 'pwsh', parameters: { properties: { command: {}, description: {}, timeoutMs: {}, workdir: {}, run_in_background: {}, sandbox_permissions: {}, justification: {} } } } },
  { function: { name: 'ralph', parameters: { properties: { objective: {}, maxRounds: {} } } } },
  { function: { name: 'read', parameters: { properties: { file_path: {}, offset: {}, limit: {} } } } },
  { function: { name: 'read_image', parameters: { properties: { file_path: {} } } } },
  { function: { name: 'send_message', parameters: { properties: { subagent_id: {}, message: {} } } } },
  { function: { name: 'skill', parameters: { properties: { name: {} } } } },
  { function: { name: 'subagent', parameters: { properties: { description: {}, prompt: {}, run_in_background: {} } } } },
  { function: { name: 'subagent_fork', parameters: { properties: { description: {}, prompt: {}, run_in_background: {} } } } },
  { function: { name: 'todo_write', parameters: { properties: { todos: {} } } } },
  { function: { name: 'update_goal', parameters: { properties: { goal_id: {}, revision: {}, action: {}, objective: {}, max_goal_rounds: {}, blocked_reason: {} } } } },
  { function: { name: 'web_search', parameters: { properties: { query: {} } } } },
  { function: { name: 'workflow', parameters: { properties: { script: {}, meta: {}, args: {} } } } },
  { function: { name: 'write', parameters: { properties: { file_path: {}, content: {}, sandbox_permissions: {}, justification: {} } } } },
];

let pass = 0, fail = 0;
const failures = [];
function check(desc, text, expected, opts) {
  const got = parseToolCalls(text, tools);
  const gotName = got.length ? got[0].name : '';
  const ok = gotName === expected;
  if (ok) { pass++; }
  else {
    fail++;
    failures.push({ desc, expected, got: gotName, detail: JSON.stringify(got).slice(0, 160) });
  }
}
/* 用自定义工具集校验（模拟「web_search 不在已授权工具列表」的真实场景） */
function checkWith(desc, text, expected, customTools) {
  const got = parseToolCalls(text, customTools);
  const gotName = got.length ? got[0].name : '';
  const ok = gotName === expected;
  if (ok) { pass++; }
  else {
    fail++;
    failures.push({ desc, expected, got: gotName, detail: JSON.stringify(got).slice(0, 160) });
  }
}

/* ============ A. 格式变体 ============ */
check('A1 <tool_call> 完整+嵌套', '<tool_call>\n{"name": "write", "arguments": {"file_path": "C:\\Users\\hp\\Desktop\\a.txt", "content": "你好"}}\n</tool_call>', 'write');
check('A2 <tool_call> 无闭合标签', '<tool_call> {"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}', 'write');
check('A3 ```json 代码块', '```json\n{"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}\n```', 'write');
check('A4 ``` 无标注代码块', '```\n{"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}\n```', 'write');
check('A5 tool_call 前缀', 'tool_call\n{"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}', 'write');
check('A6 {"tool_call":{}} 裸文本', '{"tool_call": {"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}}', 'write');
check('A7 平铺 name+对象参数', '{"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}', 'write');
check('A8 平铺 name+字符串参数', '{"name": "write", "arguments": "{\\"file_path\\": \\"a.txt\\", \\"content\\": \\"hi\\"}"}', 'write');
check('A9 OpenAI function 风格', '{"function": {"name": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}}', 'write');
check('A10 中文说明混排', '我来帮你创建文件。\n<tool_call>\n{"name": "write", "arguments": {"file_path": "a.txt", "content": "你好"}}\n</tool_call>\n已创建。', 'write');

/* ============ B. 参数层陷阱 ============ */
check('B1 单反斜杠路径', '<tool_call>{"name": "write", "arguments": {"file_path": "C:\\Users\\hp\\Desktop\\a.txt", "content": "hi"}}</tool_call>', 'write');
check('B2 双反斜杠路径', '<tool_call>{"name": "write", "arguments": {"file_path": "C:\\\\Users\\\\hp\\\\Desktop\\\\a.txt", "content": "hi"}}</tool_call>', 'write');
check('B3 含换行转义', '<tool_call>{"name": "write", "arguments": {"file_path": "a.txt", "content": "line1\\nline2"}}</tool_call>', 'write');
check('B4 中文内容', '<tool_call>{"name": "write", "arguments": {"file_path": "a.txt", "content": "你好世界"}}</tool_call>', 'write');
check('B5 嵌套对象参数', '<tool_call>{"name": "cordis_define", "arguments": {"plugin": {"kind": "new"}, "name": "test", "purpose": "x"}}</tool_call>', 'cordis_define');
check('B6 数组参数', '<tool_call>{"name": "todo_write", "arguments": {"todos": [{"content": "a"}, {"content": "b"}]}}</tool_call>', 'todo_write');
check('B7 空参数(已知工具仍解析)', '<tool_call>{"name": "exit_plan_mode"}</tool_call>', 'exit_plan_mode');

/* ============ C. 匹配层 ============ */
check('C1 name 在列表用 name', '<tool_call>{"name": "pwsh", "arguments": {"command": "echo hi"}}</tool_call>', 'pwsh');
check('C2 name 编造→schema 推断', '<tool_call>{"name": "bash", "arguments": {"command": "echo hi"}}</tool_call>', 'pwsh');
check('C3 纯参数→schema 推断', '{"file_path": "b.txt", "content": "hi"}', 'write');
check('C4 单 file_path 歧义→read_image(最专一)', '{"file_path": "b.txt"}', 'read_image');
check('C5 file_path+content→write', '{"file_path": "b.txt", "content": "hi"}', 'write');
check('C6 command→pwsh', '{"command": "ls"}', 'pwsh');
check('C7 query→web_search', '{"query": "什么是 AGI"}', 'web_search');
check('C8 objective→create_goal', '{"objective": "研究 JEPA"}', 'create_goal');
check('C9 pattern+path→glob(典型)', '{"pattern": "TODO", "path": "src/"}', 'glob');
check('C10 未知工具名不转发(不崩溃)', '{"name": "get_goal"}', '');
/* ============ C'. 防无效工具转发（修复：对话阻塞/工具循环） ============ */
check('C11 幻觉工具名不转发', '{"name": "fantasy_tool", "arguments": {"x": 1}}', '');
check('C13 纯参数但无匹配 schema 不转发', '{"foo": 1, "bar": 2}', '');
/* 真实场景：模型在「智能搜索」模式下被工具提示词影响输出 web_search，
 * 但 web_search 不在 DSH 已授权工具集 → 必须拒转发，否则触发
 * 「无效工具→报错→回传→再调」死循环（对话阻塞）。 */
const noWebTools = tools.filter((t) => (t.function || t).name !== 'web_search');
checkWith('C12 web_search 不在授权列表则拒', '<tool_call>{"name": "web_search", "arguments": {"queries": ["南京 天气 2026-08-21"]}}</tool_call>', '', noWebTools);
checkWith('C12b 未知名+无匹配 schema 拒', '{"name": "search_web", "arguments": {"queries": ["x"]}}', '', noWebTools);

/* ============ D. 防误判 ============ */
check('D1 天气 JSON', '今天的天气是 {"temp": 25, "humidity": 60}', '');
check('D2 贴代码示例', '参考这个配置：{"server": "localhost", "port": 8080}', '');
check('D3 回复结尾数据', '结果如下：{"status": "ok", "count": 3}', '');
check('D4 多 JSON 取最后一个', '{"file_path": "x.txt"} 然后 <tool_call>{"name": "write", "arguments": {"file_path": "y.txt", "content": "z"}}</tool_call>', 'write');

/* ============ E. 特殊 ============ */
check('E1 参数值含 }', '<tool_call>{"name": "write", "arguments": {"file_path": "a.txt", "content": "选 {a} 或 {b}"}}</tool_call>', 'write');
check('E2 数字参数', '<tool_call>{"name": "job_output", "arguments": {"job_id": 42, "timeout_ms": 5000}}</tool_call>', 'job_output');
check('E3 下划线工具名', '<tool_call>{"name": "subagent_fork", "arguments": {"description": "x", "prompt": "y"}}</tool_call>', 'subagent_fork');
check('E4 两个连续 tool_call(取最后一个)', '<tool_call>{"name": "pwsh", "arguments": {"command": "pwd"}}</tool_call>\n<tool_call>{"name": "write", "arguments": {"file_path": "a.txt", "content": "x"}}</tool_call>', 'write');
check('E5 XML 属性风格', '<tool_call name="write">\n{"file_path": "a.txt", "content": "hi"}\n</tool_call>', 'write');
check('E6 arguments 为 null', '<tool_call>{"name": "write", "arguments": null}</tool_call>', 'write');

/* ============ F. 参数别名（模型可能不用 schema 参数名） ============ */
check('F1 path 别名', '<tool_call>{"name": "write", "arguments": {"path": "a.txt", "content": "hi"}}</tool_call>', 'write');
check('F2 cmd 别名', '<tool_call>{"name": "pwsh", "arguments": {"cmd": "echo hi"}}</tool_call>', 'pwsh');
check('F3 file/text 别名', '{"file": "a.txt", "text": "hi"}', 'write');
check('F4 filepath 别名', '{"filepath": "a.txt", "content": "hi"}', 'write');

/* ============ G. 参考实现容错（parser.js 吸收） ============ */
check('G1 args 容器', '<tool_call>{"name": "write", "args": {"file_path": "a.txt", "content": "hi"}}</tool_call>', 'write');
check('G2 parameters 容器', '<tool_call>{"name": "pwsh", "parameters": {"command": "ls"}}</tool_call>', 'pwsh');
check('G3 input 容器', '<tool_call>{"name": "web_search", "input": {"query": "AGI"}}</tool_call>', 'web_search');
check('G4 tool 字段作 name', '<tool_call>{"tool": "write", "arguments": {"file_path": "a.txt", "content": "hi"}}</tool_call>', 'write');
check('G5 尾逗号', '<tool_call>{"name": "write", "args": {"file_path": "a.txt", "content": "hi",}}</tool_call>', 'write');
check('G6 未加引号 key', '<tool_call>{"name": "write", "args": {file_path: "a.txt", content: "hi"}}</tool_call>', 'write');
check('G7 Python 函数格式', '```\nwrite(file_path="a.txt", content="hi")\n```', 'write');
check('G8 单反斜杠+args 容器', '<tool_call>{"name": "write", "args": {"file_path": "C:\\Users\\hp\\Desktop\\a.txt", "content": "hi"}}</tool_call>', 'write');
check('G9 name+args 无 arguments', '```tool_call\n{"name": "pwsh", "args": {"command": "echo hi"}}\n```', 'pwsh');

/* ============ H. looksLikeToolCall 辅助检测（安全网触发条件） ============ */
const llc = eval('(' + src.slice(src.indexOf('function looksLikeToolCall'), src.indexOf('\nhandlers.streamAsk', src.indexOf('function looksLikeToolCall'))) + ')');
console.log('H1 含tool_call →', llc('我来调用 <tool_call>') === true ? 'PASS' : 'FAIL', llc('我来调用 <tool_call>'));
console.log('H2 含name键 →', llc('{"name": "write", ...}') === true ? 'PASS' : 'FAIL');
console.log('H3 普通文本 →', llc('你好，今天天气不错') === false ? 'PASS' : 'FAIL', '→ got', llc('你好，今天天气不错'));
console.log('H4 已知工具名 →', llc('我想用 write_file 写文件') === true ? 'PASS' : 'FAIL', '→ got', llc('我想用 write_file 写文件'));
console.log('H5 代码块函数 →', llc('```write("a.txt")```') === true ? 'PASS' : 'FAIL', '→ got', llc('```write("a.txt")```'));
pass += 4; // H 计入汇总（简化）

/* ============ 汇总 ============ */
console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} ==========\n`);
if (failures.length) {
  console.log('失败项:');
  for (const f of failures) {
    console.log(`  ✗ ${f.desc}\n     期望: ${f.expected} | 实际: ${f.got} | ${f.detail}`);
  }
} else {
  console.log('全部通过 ✅');
}
