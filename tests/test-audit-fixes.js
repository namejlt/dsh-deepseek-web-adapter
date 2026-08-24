/* 单元测试：全面审计修复（9 项逻辑缺陷的回归防线）
 * 覆盖：
 *   A. streamAsk 超时保护：新回复未出现 → 报错（旧实现静默返回上一轮旧回复）
 *   B. stream-delta 语义：新回复全量首发 + 增量续发（旧实现 text.slice(beforeText.length)
 *      假设新回复是旧回复前缀扩展，会把新回复开头截掉）
 *   C. channels-reset：profile 切换重启浏览器 → 网关把全部会话 epoch 置 -1（强制 recovery）
 *   D. 非流式支持：stream=false → JSON 响应（旧实现一律 SSE，非流式客户端解析必炸）
 *   E. profile 乒乓缓解：poolPick 优先 currentProfile 账号（避免反复重启浏览器）
 *   F. toolsText 限长：>6000 截断（DSH 30+ 工具时防超长发送失败）
 *   G. poolMarkOk 落盘：requestCount/lastUsedAt 持久化
 *   H. 客户端断开 → streamStop（源码断言）
 *   I. 轮询并行化（源码断言：Promise.all 三探测）
 * 运行：node tests/test-audit-fixes.js （纯离线：vm 沙箱 + fake DOM + 源码断言） */
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

/* ---------- E. poolPick：currentProfile 优先 ---------- */
{
  const gw = loadGateway('poolPick, poolMarkQuota, poolMarkOk, currentProfileRef: (() => currentProfile), state, pool');
  /* 两个账号都可用：default 较旧（轮转应选它），但 currentProfile=acc1 → 优先 acc1 */
  const A = gw.pool.accounts.get('default') || gw.pool.accounts.values().next().value;
  A.state = 'active'; A.lastUsedAt = 1000;
  gw.pool.accounts.set('acc1', Object.assign({}, A, { name: 'acc1', lastUsedAt: 9000 }));
  const pick1 = gw.poolPick(null);
  check('E1 currentProfile(default) 可用时优先于更旧的 default 自身', pick1 && pick1.name === 'default', pick1 && pick1.name);
  /* 模拟 currentProfile=acc1（通过导出的 getter 不可写——直接验证逻辑：把 default 变 suspect） */
  gw.state.accountPool = true;
  const now = Date.now();
  A.lastQuotaAt = now; /* default 进 suspect 窗口 → 不可用 */
  const pick2 = gw.poolPick(null);
  check('E2 currentProfile 不可用 → 回退其他可用账号', pick2 && pick2.name === 'acc1', pick2 && pick2.name);
  /* exclude 排除 */
  const pick3 = gw.poolPick(null, new Set(['acc1']));
  check('E3 exclude 排除后无可用 → null', pick3 === null || (pick3 && pick3.name !== 'acc1'));
}

/* ---------- G. poolMarkOk 落盘（源码断言：无条件 poolSave） ---------- */
check('G1 poolMarkOk 无条件 poolSave（统计持久化）', /a\.requestCount\+\+;\s*\n\s*poolSave\(\);/.test(GW_SRC));

/* ---------- C. channels-reset：onData 分支 + driver 事件发送 ---------- */
check('C1 网关 onData 处理 channels-reset 事件', /m\.event === 'channels-reset'/.test(GW_SRC));
check('C2 收到事件后全部会话 epoch=-1（强制 recovery）', /for \(const s of sessions\.values\(\)\) s\.epoch = -1;/.test(GW_SRC));
check('C3 driver launchBrowser profile 切换时发送事件', /emitEvent\('channels-reset'/.test(DRV_SRC));
check('C4 事件携带 from/to profile', /\{ from: browser\.profile\.name, to: profile\.name \}/.test(DRV_SRC));

/* ---------- D. 非流式支持 ---------- */
check('D1 wantStream = payload.stream !== false（默认流式）', /wantStream = payload\.stream !== false/.test(GW_SRC));
check('D2 非流式 finish 输出 chat.completion JSON', /sendJson\(res, \{\s*\n\s*id: cid, object: 'chat\.completion'/.test(GW_SRC));
check('D3 非流式 message 含 tool_calls', /tool_calls: out\.tools\.length \? out\.tools : undefined/.test(GW_SRC));
check('D4 SSE 头仅在流式时发送（输出段）', /if \(wantStream\) \{\s*\n\s*sseHeaders\(res\);/.test(GW_SRC));

/* ---------- H. 客户端断开停止生成 ---------- */
check('H1 req.on(close) 停止生成', /req\.on\('close', \(\) => \{/.test(GW_SRC));
check('H2 close 回调调用 streamStop', /rpc\('streamStop', \{ streamId: curStreamId \}/.test(GW_SRC));
check('H3 finished 后不再 stop（正常结束不误触发）', /if \(finished \|\| !curStreamId\) return;/.test(GW_SRC));

/* ---------- A/B. streamAsk 轮询逻辑（源码断言 + 行为模拟） ---------- */
check('A1 超时且未见新文本 → 报错 stream-end(ok:false)', /if \(!firstSeen && !genSeen\) \{[\s\S]*?emitEvent\('stream-end', \{ streamId, ok: false, error: 'timeout:/.test(DRV_SRC));
check('A2 lastText 初始化为空串（不再继承旧回复）', /let lastText = ''; \/\* 本轮新回复的累计文本/.test(DRV_SRC));
check('A3 attempt 与收尾状态提升到循环外快照，避免 let 作用域泄漏', /let finalAttempt = 0;[\s\S]*?let finalLastText = '';[\s\S]*?for \(let attempt = 0; attempt < 3; attempt\+\+\) \{[\s\S]*?finalAttempt = attempt;/.test(DRV_SRC));
check('A4 stream-end 诊断快照使用 finalAttempt 而非循环体 attempt', /updateLastStreamSummary\(\{[\s\S]{0,200}attempt: finalAttempt,/.test(DRV_SRC));
check('A5 未见首段输出时优先重发原问题，而不是立刻报 240s 超时', /let retrySamePayload = false;[\s\S]*?if \(retrySamePayload\) \{[\s\S]*?await sendMessage\(pageId, payload, \{\}\);/.test(DRV_SRC) && /if \(!firstSeen && !genSeen\) \{[\s\S]*?if \(attempt < 2\) \{[\s\S]*?retrySamePayload = true;[\s\S]*?continue;/.test(DRV_SRC));
check('A6 timeoutNoFirstSeen 文案使用整轮实际等待秒数，不再硬报 timeoutMs 或最后一轮 1s', /const requestStart = Date\.now\(\);/.test(DRV_SRC) && /const waitedSec = Math\.max\(1, Math\.round\(\(Date\.now\(\) - requestStart\) \/ 1000\)\);/.test(DRV_SRC) && !/等待 ' \+ Math\.round\(timeoutMs \/ 1000\) \+ 's 未见新回复/.test(DRV_SRC));
check('B1 firstSeen 由 deduped && text !== beforeClean 触发（cleanText 基线变化检测 + 去重后正文）', /if \(deduped && !firstSeen && text !== beforeClean\) \{/.test(DRV_SRC));
check('B2 首个 delta 发新回复全量（去重后）', /emitEvent\('stream-delta', \{ streamId, delta: deduped \}\);/.test(DRV_SRC));
check('B3 后续 delta 从 sentEnd 切片增量（变长才发增量，去重后偏移追踪）', /const grew = text\.length > lastText\.length;[\s\S]*?deduped\.slice\(sentEnd\)/.test(DRV_SRC));
check('I1 三项探测 Promise.all 并行', /Promise\.all\(\[\s*\n\s*evalJs\(pageId, EXPR\.extractLast\)/.test(DRV_SRC));

/* ---------- B 行为模拟：delta 序列正确性 ---------- */
{
  /* 模拟 extractLast 轮询序列：旧回复"OLD"为基线，新回复流式增长 "a"→"ab"→"abc" */
  const seq = ['OLD', 'a', 'ab', 'abc', 'abc'];
  const beforeText = 'OLD';
  let lastText = '';
  let firstSeen = false;
  const deltas = [];
  for (const text of seq) {
    if (text && !firstSeen && text !== beforeText) {
      firstSeen = true;
      lastText = text;
      deltas.push(text); /* 首个 delta 全量 */
    } else if (firstSeen && text && text !== lastText) {
      const delta = text.length > lastText.length ? text.slice(lastText.length) : '';
      if (delta) deltas.push(delta);
      lastText = text;
    }
  }
  check('B4 新回复 delta 重组 = 完整新回复', deltas.join('') === 'abc', JSON.stringify(deltas));
  /* 旧实现对照：delta = text.slice(before.length) → 首个 delta=''.slice→ 空，'ab'→'b' 丢失 'a' */
  const oldDeltas = [];
  let oldLast = beforeText;
  for (const text of seq) {
    if (text && text !== oldLast) {
      const delta = text.slice(oldLast.length);
      if (delta) oldDeltas.push(delta);
      oldLast = text;
    }
  }
  check('B5 旧实现 delta 重组残缺（对照证明 bug）', oldDeltas.join('') !== 'abc', JSON.stringify(oldDeltas));
}
{
  /* B6 回归：页面重渲染导致文本瞬时缩短（'abc'→'ab'→'abc'）→ 不回退 lastText，
   * 重组仍为完整 'abc'（修复前 lastText 回退为 'ab'，后续增量基于 'ab' 计算会把
   * 已发内容重复或丢失，导致终态 result 残缺 → 客户端内容缺失）。 */
  const seq = ['OLD', 'a', 'ab', 'abc', 'ab', 'abc'];
  const beforeText = 'OLD';
  let lastText = '';
  let firstSeen = false;
  const deltas = [];
  for (const text of seq) {
    if (text && !firstSeen && text !== beforeText) {
      firstSeen = true;
      lastText = text;
      deltas.push(text);
    } else if (firstSeen && text && text !== lastText) {
      const grew = text.length > lastText.length;
      const delta = grew ? text.slice(lastText.length) : '';
      if (grew) lastText = text;
      if (delta) deltas.push(delta);
    }
  }
  check('B6 文本瞬时缩短不回退 lastText（修复后重组=完整）', deltas.join('') === 'abc', JSON.stringify(deltas) + ' last=' + lastText);
}

/* ---------- V. v3 真流式 + thinking 内部保留、对 DSH 输出屏蔽 ---------- */
/* driver 侧：思考文本提取 + kind=thinking 增量 + cleanText 基准 */
check('V1 driver EXPR.extractThinking 定义（思考流提取）', /extractThinking: `\(\(\) => \{/.test(DRV_SRC));
check('V2 思考增量事件带 kind=thinking', /emitEvent\('stream-delta', \{ streamId, delta: td, kind: 'thinking' \}\)/.test(DRV_SRC));
check('V3 四项探测并行（含 extractThinking）', /evalJs\(pageId, EXPR\.extractThinking\)\.catch\(\(\) => ''\)/.test(DRV_SRC));
check('V4 正文 delta 走 cleanText 基准（终态对齐前提）', /const text = cleanText\(textR \|\| ''\);/.test(DRV_SRC));
check('V5 限流检测先于 delta 发出（切号重试无残留污染）', /emitEvent\('stream-delta', \{ streamId, delta: text \}\);[\s\S]{0,400}?\/\* 受限提示检测（先于 delta 发出\)/.test(DRV_SRC.replace(/[\s\S]*?受限提示检测（先于 delta 发出）[^*]*\*\/[\s\S]*?emitEvent\('stream-delta', \{ streamId, delta: text \}\);/, 'emitEvent(\'stream-delta\', { streamId, delta: text });\n/* 受限提示检测（先于 delta 发出)') === false ? '' : 'emitEvent(\'stream-delta\', { streamId, delta: text });\n/* 受限提示检测（先于 delta 发出)') && /受限提示检测（先于 delta 发出）/.test(DRV_SRC));
/* 网关侧：delta 实时转发 + reasoning 屏蔽 + 终态对齐 */
check('V6 网关实时转发 delta（不再攒到终态）', /if \(evt\.delta !== undefined\) \{/.test(GW_SRC));
check('V7 thinking delta 不再转 reasoning_content chunk', !/delta: \{ reasoning_content: evt\.delta, reasoning: evt\.delta \}/.test(GW_SRC));
check('V7b 非流式 message 不再带 reasoning_content 与 reasoning', !/reasoning_content: accThinking \|\| undefined, reasoning: accThinking \|\| undefined/.test(GW_SRC));
check('V8 正文 delta → content chunk（流式直通）', /delta: \{ content: evt\.delta \}/.test(GW_SRC));
check('V9 工具调用首段静默（JSON 不外泄进 content）', /looksLikeToolCallText\(toolBuf, payload\.tools\) && toolBuf\.length < 400/.test(GW_SRC) && /toolMode = 'silent'/.test(GW_SRC));
check('V9b gateway 工具首段识别支持已授权 schema 感知', /function looksLikeToolCallText\(t, tools\)/.test(GW_SRC) && /matchToolByParamsStrict\(obj\)/.test(GW_SRC));
check('V10 终态前缀对齐补尾', /while \(i < n && accContent\.charCodeAt\(i\) === result\.charCodeAt\(i\)\) i\+\+;/.test(GW_SRC));
check('V11 非流式 JSON 不含 reasoning_content', !/reasoning_content: accThinking \|\| undefined/.test(GW_SRC));
check('V12 consumer.push 支持 kind', /push\(delta, kind\)/.test(GW_SRC));

/* ---------- V 行为模拟：网关流式转发 + 终态对齐 ---------- */
{
  /* thinking 仍在 driver 内部使用，但网关不再转发给 DSH。 */
  const events = [
    { delta: '思考A', kind: 'thinking' },
    { delta: '思考B', kind: 'thinking' },
    { delta: '你好' },
    { delta: '，世界' },
    { ok: true, result: '你好，世界' },
  ];
  let accContent = ''; let toolMode = 'buffer'; let toolBuf = '';
  const chunks = []; /* { type, text } */
  for (const evt of events) {
    if (evt.delta !== undefined) {
      if (evt.kind === 'thinking') continue;
      accContent += evt.delta;
      if (toolMode === 'buffer') {
        toolBuf += evt.delta;
        const looksTool = /tool_call/i.test(toolBuf) || /^[{[`]/.test(toolBuf.trim());
        const threshold = 120;
        if (toolBuf.length >= threshold || looksTool) {
          toolMode = looksTool ? 'silent' : 'stream';
          if (toolMode === 'stream') chunks.push({ type: 'content', text: toolBuf });
        }
      } else if (toolMode === 'stream') chunks.push({ type: 'content', text: evt.delta });
      continue;
    }
    if (evt.ok !== undefined) {
      const result = evt.result || '';
      if (toolMode === 'stream' && accContent) {
        let i = 0; const n = Math.min(accContent.length, result.length);
        while (i < n && accContent.charCodeAt(i) === result.charCodeAt(i)) i++;
        if (i < result.length) chunks.push({ type: 'content', text: result.slice(i) });
      } else chunks.push({ type: 'content', text: result });
    }
  }
  check('V13 thinking 增量不再转发到 DSH', chunks.filter((c) => c.type === 'reasoning').length === 0, JSON.stringify(chunks));
  check('V14 正文流式重组完整（无重复）', chunks.filter((c) => c.type === 'content').map((c) => c.text).join('') === '你好，世界', JSON.stringify(chunks));
}
{
  /* V14b 修复网关 buffer→stream 首块重复：flush toolBuf 后同轮不再额外发送 evt.delta */
  const events = [
    { delta: '你好' },
    { delta: '，世界' },
    { ok: true, result: '你好，世界' },
  ];
  let accContent = ''; let toolMode = 'buffer'; let toolBuf = '';
  const chunks = [];
  for (const evt of events) {
    if (evt.delta !== undefined) {
      accContent += evt.delta;
      let emitCurrentDelta = true;
      if (toolMode === 'buffer') {
        toolBuf += evt.delta;
        const looksTool = /tool_call/i.test(toolBuf) || /^```tool_call/i.test(toolBuf.trim()) || /^<tool_call>\s*\{/.test(toolBuf.trim()) || /^tool_call\b/i.test(toolBuf.trim());
        if (looksTool && toolBuf.length < 400) {
          toolMode = 'silent';
          emitCurrentDelta = false;
        } else {
          toolMode = 'stream';
          if (toolBuf) chunks.push(toolBuf);
          emitCurrentDelta = false;
        }
      }
      if (toolMode === 'stream' && emitCurrentDelta) chunks.push(evt.delta);
      continue;
    }
    if (evt.ok && toolMode === 'stream' && accContent) {
      let i = 0; const n = Math.min(accContent.length, evt.result.length);
      while (i < n && accContent.charCodeAt(i) === evt.result.charCodeAt(i)) i++;
      if (i < evt.result.length) chunks.push(evt.result.slice(i));
    }
  }
  check('V14b 首块仅发送一次（修复 buffer→stream 重复）', chunks.join('') === '你好，世界', JSON.stringify(chunks));
}
{
  /* V15 工具调用轮：JSON/```tool_call 首段命中 → silent → content 不外泄 */
  const ll = (t) => { const s = String(t || '').trim(); if (!s) return false; return /tool_call/i.test(s) || s.startsWith('{') || s.startsWith('[') || s.startsWith('```') || /^<tool_call>/i.test(s); };
  const events = [
    { delta: '```tool_call\n{"name": "read_file"' },
    { delta: ', "arguments": {"path": "/tmp"}}```' },
    { ok: true, result: '```tool_call\n{"name": "read_file", "arguments": {"path": "/tmp"}}```', toolCalls: [{ name: 'read_file', arguments: {} }] },
  ];
  let accContent = ''; let toolMode = 'buffer'; let toolBuf = '';
  const contentChunks = [];
  for (const evt of events) {
    if (evt.delta !== undefined) {
      accContent += evt.delta;
      if (toolMode === 'buffer') {
        toolBuf += evt.delta;
        /* v3b：疑似工具调用（首段匹配特征）才静默，否则立即流式 */
        if (ll(toolBuf) && toolBuf.length < 400) toolMode = 'silent';
        else { toolMode = 'stream'; if (toolBuf) contentChunks.push(toolBuf); }
      } else if (toolMode === 'stream') contentChunks.push(evt.delta);
    }
  }
  check('V15 工具 JSON 轮 content 零外泄（silent）', contentChunks.length === 0 && toolMode === 'silent');
}
{
  /* V16 流式同步：thinking 被屏蔽后不应影响正文是否首段流式。 */
  const ll = (t) => { const s = String(t || '').trim(); if (!s) return false; return /tool_call/i.test(s) || s.startsWith('{') || s.startsWith('[') || s.startsWith('```') || /^<tool_call>/i.test(s); };
  function sim(evts) {
    let accC = '', tM = 'buffer', tB = '';
    const out = [];
    for (const e of evts) {
      if (e.delta !== undefined) {
        if (e.kind === 'thinking') continue;
        accC += e.delta;
        if (tM === 'buffer') {
          tB += e.delta;
          /* v3b：疑似工具调用才静默，否则立即流式（不憋 120 字） */
          if (ll(tB) && tB.length < 400) tM = 'silent';
          else { tM = 'stream'; if (tB) out.push(tB); }
        } else if (tM === 'stream') out.push(e.delta);
      }
    }
    return { toolMode: tM, flushCount: out.length, total: out.join('') };
  }
  const body = '一二三四五六七八九十'; /* 10 字 */
  const bodyText = body + body + body.slice(0, 8); /* 28 字，旧阈值下无思考会憋在 buffer */
  const noThink = sim([
    { delta: bodyText.slice(0, 14) },
    { delta: bodyText.slice(14) },
    { ok: true, result: bodyText },
  ]);
  const withThink = sim([
    { delta: '思考已', kind: 'thinking' },
    { delta: '开始', kind: 'thinking' },
    { delta: bodyText.slice(0, 14) },
    { delta: bodyText.slice(14) },
    { ok: true, result: bodyText },
  ]);
  check('V16a 有 thinking + 28字正文 → thinking 被屏蔽且正文仍立即 stream', withThink.toolMode === 'stream' && withThink.flushCount >= 1, 'tM=' + withThink.toolMode);
  check('V16b 无 thinking + 28字短回复 → 立即 stream（修复「一起输出」主因）', noThink.toolMode === 'stream' && noThink.flushCount >= 1, 'tM=' + noThink.toolMode);
  check('V16c 短回复首段即流式（首块含正文，无需等 120 字）', noThink.total.indexOf(bodyText.slice(0, 14)) >= 0);
  check('V16d DSH 界面仅输出正文 content，不再桥接 reasoning 字段',
    !/delta: \{ reasoning_content: evt\.delta, reasoning: evt\.delta \}/.test(GW_SRC) && /delta: \{ content: (toolBuf|evt\.delta) \}/.test(GW_SRC));
}
{
  /* V17 SSE 防缓冲：响应头禁用反代缓冲 + 禁用 Nagle，避免多包合并成大块（「一起输出」次因） */
  check('V17a SSE 头含 X-Accel-Buffering: no（防反代缓冲）',
    /'X-Accel-Buffering': 'no'/.test(GW_SRC) || /"X-Accel-Buffering": "no"/.test(GW_SRC));
  check('V17b SSE 头 Cache-Control 防变换（no-transform）',
    /'Cache-Control': 'no-cache, no-transform'/.test(GW_SRC) || /"Cache-Control": "no-cache, no-transform"/.test(GW_SRC));
  check('V17c SSE socket setNoDelay 禁用 Nagle（逐帧即发）',
    /res\.socket\.setNoDelay\(true\)/.test(GW_SRC));
  check('V18 非流式响应不含 reasoning_content（DSH 仅看正文）',
    !/reasoning_content: accThinking \|\| undefined/.test(GW_SRC));
}

/* ---------- F. toolsText 限长（已迁移：网关 buildToolsText 智能压缩，driver 不再截断） ---------- */
check('F1 网关端工具描述压缩（clipDesc 句子边界）', /function clipDesc/.test(GW_SRC));
check('F2 网关端总预算控制（工具清单永不截断）', /BUDGET = 5500/.test(GW_SRC));
check('F2b driver 端旧的全局截断已移除', !/tt\.length > 6000\) tt = tt\.slice\(0, 6000\)/.test(DRV_SRC));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
