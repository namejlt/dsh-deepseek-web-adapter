'use strict';
/* dsweb-gateway.js — DeepSeek 网页版网关（v3 重写）
 * 把 chat.deepseek.com 伪装成正常的 OpenAI 兼容模型提供方。
 * DSH 通过 settings.yaml 配置 provider=dsweb → pi-ai → 本网关 → driver → 网页版。
 *
 * API:
 *   POST /v1/chat/completions    OpenAI 兼容（流式 SSE，支持 tool_calls）
 *   GET  /v1/models              模型列表（deepseek-chat/reasoner/vision）
 *   GET  /login                  有头登录（自动检测完成）
 *   GET  /login-status           登录状态
 *   POST /calibrate/record       开始校准（有头窗口 + 录制点击）
 *   POST /calibrate/collect      收集录制结果
 *   POST /calibrate/close        关闭校准窗口
 *   POST /calibrate/save         保存校准（按模型 key）
 *   POST /calibrate/apply        回放校准
 *   GET  /calibrate/list         校准列表
 *   POST /config                 读写配置（headless/maxConcurrent）
 *
 * 设计原则（来自 deepseek-browser-agent 的教训）：
 *   1. 单一常驻浏览器：绝不因 headless 差异重建 Chrome（重建 = 会话 cookie 丢失）
 *   2. 登录 = 有头窗口 + 自动轮询检测（url/body/password）
 *   3. 工具调用 = 提示工程（tool_call 格式）→ 网页版输出 → DSH 执行 → 结果回传
 *   4. 并发 = 每请求独立 page + 信号量
 * 用法: node dsweb-gateway.js [--port 5688] [--base <dir>]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

/* ---------- 配置 ---------- */
const args = process.argv.slice(2);
function argVal(name) {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}
const PORT = parseInt(argVal('--port') || '5688', 10) || 5688;
const BASE_DIR = argVal('--base') || path.join(__dirname, '.gw');
const DRIVER_PATH = argVal('--driver') || path.join(BASE_DIR, 'driver.js');
const DRIVER_MARKER = 'deepseek-web-driver.js';
const CALIB_FILE = path.join(BASE_DIR, 'calibration.json');
const state = { headless: false, maxConcurrent: 2, maxTurnsPerChat: 50 };

const MODELS = {
  'deepseek-chat': { name: 'DeepSeek 快速', mode: 'quick', deepThink: false },
  'deepseek-reasoner': { name: 'DeepSeek 专家', mode: 'expert', deepThink: true },
  'deepseek-vision': { name: 'DeepSeek 识图', mode: 'vision', deepThink: false },
};

function log(...a) { console.log('[' + new Date().toISOString().slice(11, 19) + '][gw]', ...a); }

/* ---------- driver 生命周期（单一常驻） ---------- */
let D = null;
let driverPromise = null;
let terminating = false;

function ensureDriver() {
  if (!driverPromise) driverPromise = spawnDriver().catch((e) => { driverPromise = null; throw e; });
  return driverPromise;
}

function spawnDriver() {
  const src = fs.readFileSync(DRIVER_PATH, 'utf8');
  if (src.indexOf(DRIVER_MARKER) < 0) throw new Error('driver invalid: ' + DRIVER_PATH);
  try { fs.mkdirSync(BASE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const cp = spawn(process.execPath, [DRIVER_PATH], {
    cwd: BASE_DIR, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { DS_WEB_BASE: BASE_DIR, DS_WEB_CHROME: '' }),
  });
  const d = { cp, ready: false, seq: 0, pending: new Map(), buffer: '', errTail: '', consumers: new Map() };
  D = d;
  cp.stdout.setEncoding('utf8');
  cp.stdout.on('data', (c) => onData(d, c));
  cp.stderr.setEncoding('utf8');
  cp.stderr.on('data', (c) => {
    d.errTail = (d.errTail + c).slice(-4000);
    /* 转发 driver 日志（driver 的 log 用 console.error → stderr） */
    const lines = c.split('\n').filter((l) => l.trim());
    for (const l of lines) log('[driver] ' + l.trim());
  });
  cp.on('close', (code, signal) => {
    if (terminating) return;
    log('driver exited code=' + code + ' — respawn in 1.5s');
    for (const p of d.pending.values()) p.j(new Error('driver exited'));
    d.pending.clear();
    for (const c of d.consumers.values()) c.end({ ok: false, error: 'driver exited' });
    d.consumers.clear();
    D = null; driverPromise = null;
    setTimeout(() => { ensureDriver().catch(() => {}); }, 1500);
  });
  return waitReady(d, 20000).then(() => { log('driver ready pid=' + cp.pid); return d; });
}

function onData(d, chunk) {
  d.buffer += chunk;
  let i;
  while ((i = d.buffer.indexOf('\n')) >= 0) {
    const line = d.buffer.slice(0, i);
    d.buffer = d.buffer.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id !== undefined && d.pending.has(m.id)) {
      const p = d.pending.get(m.id);
      d.pending.delete(m.id);
      m.ok ? p.r(m.result) : p.j(new Error(m.error || 'driver error'));
    } else if (m.event === 'ready') {
      d.ready = true;
    } else if (m.event === 'stream-delta' && m.streamId) {
      const c = d.consumers.get(m.streamId);
      if (c) c.push(m.delta || '');
    } else if (m.event === 'stream-end' && m.streamId) {
      const c = d.consumers.get(m.streamId);
      if (c) c.end({ ok: !!m.ok, error: m.error, result: m.result, toolCalls: m.toolCalls });
    }
  }
}

function waitReady(d, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (d.ready) return resolve();
    const t = setTimeout(() => reject(new Error('driver not ready: ' + (d.errTail || '').slice(-300))), timeoutMs);
    const iv = setInterval(() => { if (d.ready) { clearTimeout(t); clearInterval(iv); resolve(); } }, 200);
  });
}

function rpc(method, params, timeoutMs) {
  return ensureDriver().then((d) => new Promise((resolve, reject) => {
    const id = ++d.seq;
    const t = setTimeout(() => { d.pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, timeoutMs || 120000);
    d.pending.set(id, { r: resolve, j: reject, t });
    try { d.cp.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n'); }
    catch (e) { d.pending.delete(id); clearTimeout(t); reject(e); }
  }));
}

function makeConsumer(d, streamId) {
  const c = {
    q: [], w: [], ended: false, endInfo: null,
    push(delta) { if (this.ended) return; const w = this.w.shift(); if (w) w({ delta }); else this.q.push({ delta }); },
    end(info) { if (this.ended) return; this.ended = true; this.endInfo = info; const w = this.w.shift(); if (w) w(info); },
    next() { if (this.q.length) return Promise.resolve(this.q.shift()); if (this.ended) return Promise.resolve(this.endInfo || { ok: false }); return new Promise((r) => this.w.push(r)); },
  };
  d.consumers.set(streamId, c);
  return c;
}

/* ---------- 并发信号量 ---------- */
let semActive = 0;
const semQueue = [];
function acquireSem() {
  if (semActive < state.maxConcurrent) { semActive++; return Promise.resolve(() => { semActive--; const n = semQueue.shift(); if (n) n(); }); }
  return new Promise((resolve) => semQueue.push(() => { semActive++; resolve(() => { semActive--; const n = semQueue.shift(); if (n) n(); }); }));
}

/* ---------- 提示词组装 ---------- */
function blockText(b) {
  if (typeof b === 'string') return b;
  if (Array.isArray(b)) return b.map(blockText).filter(Boolean).join('\n');
  if (b && typeof b === 'object') {
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool-call') return '[调用工具 ' + (b.name || '?') + ']';
    if (b.type === 'tool-result') return '[工具结果] ' + String(blockText(b.content) || '').slice(0, 2000);
    return '';
  }
  return '';
}

function buildContext(payload) {
  const msgs = payload.messages || [];
  const parts = [];
  /* 单页模式下网页版页面自己保留历史 → 只发增量（最后一条：user 或 tool 结果），
   * 绝不把 DSH 完整历史灌进网页版（超长会发送失败）。 */
  const recent = msgs.slice(-1);
  for (const m of recent) {
    const text = blockText(m.content);
    if (!text && m.role !== 'tool') continue;
    switch (m.role) {
      case 'user': parts.push('[用户]\n' + text); break;
      case 'assistant': if (text) parts.push('[助手]\n' + text); break;
      case 'tool': parts.push('[工具结果]\n' + text); break;
      case 'system': parts.push('[系统指令]\n' + text); break;
      default: parts.push('[' + m.role + ']\n' + text);
    }
  }
  if (!parts.length) return '(no message)';
  return parts.join('\n\n');
}

/* 工具循环中（messages 含 tool 结果）→ 保持网页版页面历史（不 newChat），只发增量；
 * 纯对话首轮 → 新会话（newChat 清历史，发最后 user 消息）。 */
function shouldResetChat(payload) {
  const msgs = payload.messages || [];
  const lastRoles = msgs.slice(-3).map((m) => m.role);
  return !lastRoles.includes('tool');
}

function buildToolsText(tools) {
  if (!tools || !tools.length) return '';
  const FENCE = '```';
  const lines = [
    '你可以调用工具来完成用户任务。工具会自动执行，不需要担心权限问题——直接调用即可。',
    '',
    '当你需要调用工具时，你的整个回复必须 ONLY 是一个 tool_call 代码块——前后不要有任何文字、解释或标点：',
    '',
    FENCE + 'tool_call',
    '{',
    '  "name": "工具名",',
    '  "args": {',
    '    "参数1": "值1"',
    '  }',
    '}',
    FENCE,
    '',
    '关键规则：',
    '- 调用工具时整个回复 ONLY 代码块（无散文）。任务完成后才用纯文本回答。',
    '- 一次只调用一个工具。',
    '- 必须包含 "name" 和 "args" 两个键。',
    '- 收到工具结果后，继续调用下一个工具或给出最终回答。',
    '',
    '可用工具：',
  ];
  for (const t of tools) {
    const fn = t.function || t;
    lines.push('- ' + (fn.name || '?') + ': ' + (fn.description || ''));
    if (fn.parameters && fn.parameters.properties) {
      try {
        const props = fn.parameters.properties;
        const req = (fn.parameters.required) || [];
        lines.push('  参数: ' + Object.keys(props).map((k) => k + (req.includes(k) ? '(必填)' : '')).join(', '));
      } catch (e) { /* ignore */ }
    }
  }
  lines.push('', '示例（写桌面文件）：' + FENCE + 'tool_call\n{"name": "write", "args": {"file_path": "C:\\\\Users\\\\hp\\\\Desktop\\\\test.txt", "content": "你好"}}\n' + FENCE);
  return lines.join('\n');
}

/* ---------- SSE 输出 ---------- */
function sseHeaders(res) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
}
function sseChunk(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

/* ---------- 核心：一次模型调用 ---------- */
async function handleChatCompletion(req, res, payload) {
  const model = payload.model || 'deepseek-chat';
  const cfg = MODELS[model] || MODELS['deepseek-chat'];
  const created = Math.floor(Date.now() / 1000);
  const cid = 'chatcmpl-' + created;
  const release = await acquireSem();
  const sendChunk = (obj) => sseChunk(res, obj);
  try {
    const question = buildContext(payload);
    const toolsText = buildToolsText(payload.tools);
    const d = await ensureDriver();
    /* 模型联动：driver 在 newChat 后自动应用校准（calibKey=model），
     * 因为 DeepSeek 模型选择是会话级的，新会话会重置为默认。 */
    const { streamId } = await rpc('streamAsk', {
      question, mode: cfg.mode, deepThink: cfg.deepThink, search: false,
      headless: state.headless, toolsText, tools: payload.tools,
      reset: 'auto', calibKey: model, maxTurnsPerChat: state.maxTurnsPerChat,
    }, 30000);
    const consumer = makeConsumer(d, streamId);
    sseHeaders(res);
    sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    let evt;
    let full = '';
    for (;;) {
      evt = await consumer.next();
      if (evt.delta) full += evt.delta;
      if (evt.ok !== undefined || evt.error !== undefined || evt.toolCalls !== undefined) break;
    }
    if (evt.toolCalls && evt.toolCalls.length) {
      evt.toolCalls.forEach((tc, i) => {
        const callId = 'call_gw_' + i + '_' + Date.now().toString(36);
        const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {});
        sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: callId, type: 'function', function: { name: tc.name, arguments: '' } }] }, finish_reason: null }] });
        for (let k = 0; k < argsStr.length; k += 60) {
          sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: argsStr.slice(k, k + 60) } }] }, finish_reason: null }] });
        }
      });
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (evt.ok) {
      /* driver 返回完整 result（非流式）→ 一次性输出 */
      const text = evt.result || full;
      for (let k = 0; k < text.length; k += 120) {
        sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text.slice(k, k + 120) }, finish_reason: null }] });
      }
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else {
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: '[错误] ' + (evt.error || 'unknown') }, finish_reason: null }] });
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    d.consumers.delete(streamId);
  } catch (e) {
    try {
      sseHeaders(res);
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: '[错误] ' + String(e.message || e) }, finish_reason: null }] });
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e2) { /* ignore */ }
  } finally {
    release();
  }
}

/* ---------- WorkBuddy 落盘模式（workbuddy-agent / localproxy，注册驱动用） ---------- */
const WB_REQ_DIR = path.join(__dirname, 'mock-api', 'requests');
const WB_RES_DIR = path.join(__dirname, 'mock-api', 'responses');
for (const d of [WB_REQ_DIR, WB_RES_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ } }
let wbSeq = 0;
function wbWaitResponse(seqId, timeoutMs) {
  const file = path.join(WB_RES_DIR, seqId + '.json');
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        clearInterval(iv); resolve(r);
      } catch (e) {
        if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('response timeout for ' + seqId)); }
      }
    }, 800);
  });
}
async function handleWorkBuddy(req, res, payload) {
  /* 唯一 seqId（时间戳 + 计数器），避免撞历史遗留文件 */
  const seqId = 'req-' + Date.now().toString(36) + '-' + (++wbSeq);
  fs.writeFileSync(path.join(WB_REQ_DIR, seqId + '.json'), JSON.stringify(payload, null, 2));
  log('WorkBuddy 模式: ' + seqId + ' 已落盘，等待回应');
  const response = await wbWaitResponse(seqId, 900000);
  const model = payload.model || 'workbuddy-agent';
  const created = Math.floor(Date.now() / 1000);
  const cid = 'chatcmpl-' + created;
  const toolCalls = (response.tool_calls || []).map((tc) => {
    const fn = tc.function || {};
    const name = fn.name || tc.name || '';
    const rawArgs = fn.arguments !== undefined ? fn.arguments : tc.arguments;
    const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
    return { id: tc.id || 'call_' + created, type: 'function', function: { name, arguments: argsStr } };
  });
  if (payload.stream) {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const chunk = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    chunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    toolCalls.forEach((tc, i) => {
      chunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] });
      const argStr = tc.function.arguments || '';
      for (let k = 0; k < argStr.length; k += 60) {
        chunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: argStr.slice(k, k + 60) } }] }, finish_reason: null }] });
      }
    });
    const content = response.content || '';
    for (let k = 0; k < content.length; k += 60) {
      chunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: content.slice(k, k + 60) }, finish_reason: null }] });
    }
    chunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    sendJson(res, {
      id: cid, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: response.content || null, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

/* ---------- HTTP 服务 ---------- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJson(res, obj) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += String(c); if (s.length > 8 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  try {
    /* 模型列表 */
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      return sendJson(res, { object: 'list', data: Object.entries(MODELS).map(([id, m]) => ({ id, object: 'model', owned_by: 'dsweb', name: m.name })) });
    }
    /* OpenAI chat completions */
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      const payload = JSON.parse((await readBody(req)) || '{}');
      log('请求: model=' + (payload.model || '?') + ' msgs=' + (payload.messages || []).length + ' tools=' + ((payload.tools || []).length));
      /* 诊断：记录工具名列表（首次记录到 baseDir/tools.log） */
      try {
        const tlog = path.join(BASE_DIR, 'tools.log');
        if (!fs.existsSync(tlog)) {
          const names = (payload.tools || []).map((t) => {
            const fn = t.function || t;
            const props = (fn.parameters && fn.parameters.properties) || {};
            return fn.name + '(' + Object.keys(props).join(',') + ')';
          });
          fs.writeFileSync(tlog, '[' + (payload.model || '?') + '] ' + names.join(' | '));
          log('工具列表已记录: ' + tlog);
        }
      } catch (e) { /* ignore */ }
      if (payload.model === 'workbuddy-agent') {
        return handleWorkBuddy(req, res, payload);
      }
      return handleChatCompletion(req, res, payload);
    }
    /* 登录 */
    if (req.method === 'GET' && (p === '/login')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#17181c;color:#ddd"><h2>DeepSeek 网页版登录</h2><p>已打开浏览器窗口，请在其中登录 chat.deepseek.com。登录完成后会自动检测。</p><p><a href="/login-status">查看登录状态</a></p></body></html>');
      const d = await ensureDriver();
      rpc('login', { profile: 'default', timeoutMs: 300000 }, 330000)
        .then((r) => log('登录结果:', JSON.stringify(r).slice(0, 160)))
        .catch((e) => log('登录失败:', e.message));
      return;
    }
    if (req.method === 'GET' && (p === '/login-status')) {
      let st = { needsLogin: true };
      try {
        const insp = await rpc('inspect', {}, 8000);
        st = (insp && insp.login) || { needsLogin: true };
      } catch (e) { /* no page */ }
      return sendJson(res, { ok: true, login: st });
    }
    /* 校准 */
    if (p === '/calibrate/list') { let c = {}; try { c = JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch (e) { /* none */ } return sendJson(res, { ok: true, calibration: c }); }
    if (p === '/calibrate/record') { return sendJson(res, await rpc('calibrateRecord', {}, 20000)); }
    if (p === '/calibrate/collect') { const b = JSON.parse((await readBody(req)) || '{}'); return sendJson(res, await rpc('calibrateCollect', { pageId: b.pageId }, 15000)); }
    if (p === '/calibrate/close') { const b = JSON.parse((await readBody(req)) || '{}'); return sendJson(res, await rpc('calibrateClose', { pageId: b.pageId }, 10000)); }
    if (p === '/calibrate/save') { const b = JSON.parse((await readBody(req)) || '{}'); return sendJson(res, await rpc('calibrateSave', { key: b.key, clicks: b.clicks }, 10000)); }
    if (p === '/calibrate/apply') { const b = JSON.parse((await readBody(req)) || '{}'); return sendJson(res, await rpc('calibrateApply', { key: b.key, headless: state.headless }, 30000)); }
    /* 调试：thePage 的 DOM 结构（模型选择器诊断） */
    if (p === '/debug') {
      const insp = await rpc('inspect', {}, 10000).catch((e) => ({ error: e.message }));
      return sendJson(res, { ok: true, inspect: insp });
    }
    /* 配置 */
    if (p === '/config') {
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        let note = '';
        if (b.headless !== undefined && b.headless !== state.headless) {
          note = '（headless 变更需重启网关并重新登录，会话将重置）';
        }
        if (b.headless !== undefined) state.headless = !!b.headless;
        if (b.maxConcurrent !== undefined) state.maxConcurrent = Math.max(1, Math.min(5, parseInt(b.maxConcurrent, 10) || 2));
        if (b.maxTurnsPerChat !== undefined) state.maxTurnsPerChat = Math.max(2, Math.min(500, parseInt(b.maxTurnsPerChat, 10) || 50));
        return sendJson(res, { ok: true, config: { headless: state.headless, maxConcurrent: state.maxConcurrent, maxTurnsPerChat: state.maxTurnsPerChat }, note });
      }
      return sendJson(res, { ok: true, config: { headless: state.headless, maxConcurrent: state.maxConcurrent, maxTurnsPerChat: state.maxTurnsPerChat } });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found: ' + p } }));
  } catch (e) {
    try { sendJson(res, { ok: false, error: String(e.message || e) }); } catch (e2) { /* ignore */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('DeepSeek 网页版网关已监听 http://127.0.0.1:' + PORT + '/v1/');
  log('driver: ' + DRIVER_PATH + ' | baseDir: ' + BASE_DIR);
  log('模型: ' + Object.keys(MODELS).join(', '));
  log('配置: headless=' + state.headless + ' maxConcurrent=' + state.maxConcurrent + ' maxTurnsPerChat=' + state.maxTurnsPerChat);
  ensureDriver().catch((e) => log('driver 启动失败: ' + e.message));
});

process.on('SIGINT', () => { terminating = true; if (D && D.cp) { try { execSync('taskkill /pid ' + D.cp.pid + ' /T /F', { stdio: 'ignore', timeout: 8000 }); } catch (e) { try { D.cp.kill(); } catch (e2) {} } } process.exit(0); });
process.on('SIGTERM', () => { terminating = true; if (D && D.cp) { try { D.cp.kill(); } catch (e) {} } process.exit(0); });
