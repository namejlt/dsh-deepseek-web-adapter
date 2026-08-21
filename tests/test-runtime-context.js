/* 单元测试：runtime context 识别与首轮上下文组装（bug 回归防线）
 * 背景 bug：DSH approval=never 时 runtime context 文案为
 *   "Approval prompts are disabled ..."（不含 "Approval policy" 字样），
 *   旧版 isRuntimeContext 三条件硬判定失配 → ctx 被误当用户消息提取 →
 *   首轮用户问题丢失（模型只回"运行环境信息已更新，请问你需要我做什么"）。
 * 用户观察到："deepseek 专家第一次请求只有上下文，然后打开新对话重新发起"。
 * 修复：多特征任一命中 + 四处提取点（first/delta/recovery/fingerprint）
 *       统一加 ctx 开头标记兜底。
 * 数据来源：真实 DSH 会话日志（session-afb7aec8）提取的确切文案。
 * 运行：node tests/test-runtime-context.js （纯离线：vm 沙箱加载网关纯函数） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GW_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

/* ---------- 沙箱：加载网关纯函数（截断到 server.listen 前） ---------- */
function loadGateway() {
  const cut = GW_SRC.indexOf('server.listen(');
  if (cut < 0) throw new Error('server.listen not found');
  const code = GW_SRC.slice(0, cut) + `
;globalThis.__x = { isRuntimeContext, buildContext, extractBaseline, sessionFingerprint, blockText };`;
  const sandbox = {
    require: (m) => {
      if (!['fs', 'path', 'http', 'crypto', 'child_process'].includes(m)) throw new Error('not allowed: ' + m);
      return require(m);
    },
    process: { argv: ['node', 'gw'], env: {}, on: () => {}, exit: () => {}, platform: process.platform },
    __dirname: __dirname,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dsweb-gateway.js' });
  return sandbox.__x;
}
const gw = loadGateway();

/* ---------- 真实数据（DSH 会话日志提取） ---------- */
/* approval=never 时的 runtime context（bug 触发文案，len=390） */
const CTX_NEVER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.\n\nApproval prompts are disabled in this session: actions that require approval are rejected automatically \u2014 do not request sandbox escalation (do not set `sandbox_permissions`).';
/* approval=ask 时的 runtime context（正常路径文案） */
const CTX_ASK = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write. Some platform temporary areas may also be writable.\n\nApproval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.';
/* 模拟 DSH 未来改文案：开头标记在、全部特征词失配（防御层测试用） */
const CTX_FUTURE = 'Current runtime context. ( redesigned wording without any known keywords )';
const SYS = 'You are an AI agent powered by DeepSeek Harness.\nUse tools to complete tasks.';
const APPROVAL_MSG = 'The approval policy changed from "ask" to "never" (changed by the user).';
const QUESTION = '请分析菜根谭，给出核心精华';

/* ---------- 1. isRuntimeContext 判定 ---------- */
check('1a approval=never 的 ctx 被识别（原 bug：失配）', gw.isRuntimeContext(CTX_NEVER) === true);
check('1b approval=ask 的 ctx 被识别（原路径不回归）', gw.isRuntimeContext(CTX_ASK) === true);
check('1c 普通用户消息不误判', gw.isRuntimeContext(QUESTION) === false);
check('1d 非字符串不误判', gw.isRuntimeContext(null) === false && gw.isRuntimeContext(undefined) === false);
check('1e 开头不对（粘贴了 ctx 中段）不误判', gw.isRuntimeContext('blah ' + CTX_ASK) === false);

/* ---------- 2. first 模式：核心 bug 场景 ---------- */
/* 真实 turn 1 结构：[system, user(approval事件), user(用户问题), user(ctx)] */
const turn1Never = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: APPROVAL_MSG },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_NEVER },
] };
const q1 = gw.buildContext(turn1Never, 'first');
check('2a1 first(approval=never) 产物含用户问题（原 bug：丢失）', q1.indexOf(QUESTION) >= 0, q1.slice(-200));
check('2a2 first(approval=never) 产物含系统设定', q1.indexOf('[系统设定]') === 0);
check('2a3 first(approval=never) ctx 进上下文段（extractBaseline 收集）', q1.indexOf('danger-full-access') > 0);
check('2a4 first(approval=never) 用户问题带 [用户] 标记', q1.indexOf('[用户]\n' + QUESTION) >= 0);

const turn1Ask = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_ASK },
] };
const q2 = gw.buildContext(turn1Ask, 'first');
check('2b1 first(approval=ask) 正常路径不回归', q2.indexOf('[用户]\n' + QUESTION) >= 0);
check('2b2 first(approval=ask) ctx 进上下文段', q2.indexOf('workspace-write') > 0);

/* 防御层：全部特征词失配的未来文案 → 开头标记兜底仍跳过 */
const turn1Future = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_FUTURE },
] };
const q3 = gw.buildContext(turn1Future, 'first');
check('2c1 特征全失配时仍取到用户问题（开头标记兜底）', q3.indexOf('[用户]\n' + QUESTION) >= 0, q3.slice(-200));
check('2c2 特征全失配时 ctx 不进上下文段（isRuntimeContext=false）', q3.indexOf('redesigned wording') < 0);

/* ---------- 3. delta 模式：轮中 ctx 更新跳过 ---------- */
const deltaNever = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_NEVER },
  { role: 'assistant', content: '好的，我来分析。' },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_NEVER }, /* 轮中更新的 ctx 排最后 */
] };
const q4 = gw.buildContext(deltaNever, 'delta');
check('3a delta(approval=never) 跳过末尾 ctx 发真实增量', q4 === '[用户]\n' + QUESTION, JSON.stringify(q4));

const deltaFuture = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: QUESTION },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '继续深入第二部分' },
  { role: 'user', content: CTX_FUTURE },
] };
const q5 = gw.buildContext(deltaFuture, 'delta');
check('3b delta(特征失配 ctx) 兜底跳过', q5 === '[用户]\n继续深入第二部分', JSON.stringify(q5));

/* delta 工具结果不受影响 */
const deltaTool = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: QUESTION },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'file content here' },
] };
const q6 = gw.buildContext(deltaTool, 'delta');
check('3c delta 工具结果正常发送', q6.indexOf('[工具结果]\nfile content here') === 0, JSON.stringify(q6));

/* ---------- 4. recovery 模式：压缩重建 ---------- */
const recoverNever = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: APPROVAL_MSG },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_NEVER },
  { role: 'assistant', content: '《菜根谭》为明代洪应明所著语录体处世哲学经典。' },
  { role: 'user', content: '继续' },
] };
const q7 = gw.buildContext(recoverNever, 'recovery');
check('4a recovery ctx 进上下文段', q7.indexOf('danger-full-access') > 0);
check('4b recovery 压缩历史含用户消息', q7.indexOf(QUESTION) > 0 && q7.indexOf('[用户]') > 0);
check('4c recovery 压缩历史含助手回复', q7.indexOf('洪应明') > 0);
check('4d recovery ctx 不重复进压缩历史', q7.indexOf('Current DSH file policy') === q7.lastIndexOf('Current DSH file policy'));

const recoverFuture = { messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_FUTURE },
  { role: 'assistant', content: '回复一。' },
  { role: 'user', content: '继续' },
] };
const q8 = gw.buildContext(recoverFuture, 'recovery');
check('4e recovery(失配 ctx) 兜底不进压缩历史', q8.indexOf('redesigned wording') < 0, q8.slice(0, 200));

/* ---------- 5. 指纹稳定性 ---------- */
/* ctx 排首位且每轮变化时，指纹必须稳定（以真实用户消息为准） */
const fpA = gw.sessionFingerprint({ messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: CTX_NEVER },
  { role: 'user', content: QUESTION },
] });
const fpB = gw.sessionFingerprint({ messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: CTX_ASK },
  { role: 'user', content: QUESTION },
] });
check('5a ctx 变化不影响指纹（firstUser=真实用户消息）', fpA.full === fpB.full && fpA.loose === fpB.loose);
const fpC = gw.sessionFingerprint({ messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: APPROVAL_MSG },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_NEVER },
] });
const fpD = gw.sessionFingerprint({ messages: [
  { role: 'system', content: SYS },
  { role: 'user', content: APPROVAL_MSG },
  { role: 'user', content: QUESTION },
  { role: 'user', content: CTX_ASK },
] });
check('5b 真实场景（approval 事件在首位）两种 ctx 指纹一致', fpC.full === fpD.full);

/* ---------- 6. blockText 容错 ---------- */
check('6a content blocks 数组格式', gw.blockText([{ type: 'text', text: QUESTION }]) === QUESTION);
check('6b 纯字符串', gw.blockText(QUESTION) === QUESTION);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
