#!/usr/bin/env node
'use strict';
/* deepseek-web-driver.js — dependency-free DeepSeek Web agent driver.
 * Talks to a real Chrome/Edge via raw CDP over a hand-rolled WebSocket.
 * Controlled by the DSH host plugin through JSON-lines RPC on stdio.
 * Implements: model modes (quick/expert/vision), deep-think & web-search
 * toggles, multi-window concurrent tasks, tool-call agent loop, and an
 * anti-limit engine (context compression, chat migration, profile rotation).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { defaultProfile } = require('./provider-registry');
const PROVIDER_ADAPTERS = Object.freeze({
  deepseek: require('./providers/deepseek'),
  chatgpt: require('./providers/chatgpt'),
  qwen: require('./providers/qwen'),
});

class ProviderDriverError extends Error {
  constructor(kind, message) { super(message); this.name = 'ProviderDriverError'; this.kind = kind; }
}
function resolveProviderAdapter(providerId) {
  const id = providerId || 'deepseek';
  const adapter = PROVIDER_ADAPTERS[id];
  if (!adapter) throw new Error('unknown provider: ' + id);
  return adapter;
}
function profileKey(providerId, requestedProfile) {
  const id = resolveProviderAdapter(providerId).id;
  const requested = String(requestedProfile || '').trim();
  if (!requested) return defaultProfile(id);
  if (id === 'deepseek' && requested === 'default') return 'default'; // legacy explicit profile
  if (requested.startsWith(id + '-')) return requested;
  return id + '-' + requested;
}
function channelKey(providerId, pageKey) {
  return resolveProviderAdapter(providerId).id + ':' + String(pageKey || 'main');
}
function providerUrl(providerId) { return resolveProviderAdapter(providerId).siteUrl; }
function providerError(kind, message) { return new ProviderDriverError(kind, message); }
function isDeepSeekProvider(providerId) { return (providerId || 'deepseek') === 'deepseek'; }

const VERSION = '1.1.0';
const DS_URL = 'https://chat.deepseek.com/';

/* ------------------------------------------------------------------ */
/* logging                                                             */
/* ------------------------------------------------------------------ */
const DEBUG = !!process.env.DS_WEB_DEBUG;
function log(...a) { console.error('[dsweb]', ...a); }
function logErr(...a) { console.error('[dsweb][err]', ...a); }
function logDbg(...a) { if (DEBUG) console.error('[dsweb][dbg]', ...a); }
function summarizeTextForLog(text) {
  const value = String(text == null ? '' : text);
  return {
    length: value.length,
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
  };
}
function summarizeToolCallsForLog(toolCalls) {
  const rows = Array.isArray(toolCalls) ? toolCalls : [];
  return {
    count: rows.length,
    names: rows.map((call) => String((((call || {}).function || {}).name) || call.name || '?')).slice(0, 20),
  };
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  headless: true,
  maxConcurrent: 3,
  maxTurnsPerChat: 30,
  compactThresholdChars: 60000,
  maxOutputLength: 8000,
  responseTimeoutMs: 240000,
  stableDelayMs: 2500,
  sendDelayMs: 400,
  maxIterations: 40,
  maxMigrations: 24,
  maxQuotaBackoffRetries: 3,
  profiles: [{ name: 'default', headless: true }],
  chromePath: process.env.DS_WEB_CHROME || '',
  baseDir: process.env.DS_WEB_BASE || path.join(os.homedir(), '.dsweb'),
};
let CFG = JSON.parse(JSON.stringify(DEFAULTS));

function profileDir(name) { return path.join(CFG.baseDir, 'profiles', String(name || 'default')); }
function effectiveHeadless(profile) { return profile && profile.headless !== undefined ? profile.headless : CFG.headless; }

/** Promise 版延时。 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ */
/* stdio JSON-lines RPC                                                */
/* ------------------------------------------------------------------ */
const pending = new Map();
let rpcSeq = 0;

/** 向网关写一行 JSON（stdout 通道；写失败只记日志不抛——断管道不应杀死 driver）。 */
function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); }
  catch (e) { logErr('stdout write failed', e.message); }
}
/** 回复 RPC 请求（按 id 关联）：ok 时携带 result，失败时携带 error 文本。 */
function respond(id, ok, result, error) {
  if (ok) send({ id, ok: true, result });
  else send({ id, ok: false, error: String(error && error.message || error) });
}
/** 向网关单向推送事件（stream-delta / stream-end / channels-reset / login-progress 等）。 */
function emitEvent(name, payload) { send({ event: name, ...(payload || {}) }); }

const handlers = {};

/** 从缓冲区切出一行（无完整行返回 null）——stdin JSON-lines 协议的分行器。 */
function readLine(buf) {
  const i = buf.indexOf('\n');
  if (i < 0) return null;
  const line = buf.slice(0, i).toString('utf8').trim();
  const rest = buf.slice(i + 1);
  return { line, rest };
}

const IS_MAIN = require.main === module;
const RUN_ONCE = IS_MAIN && process.argv[2] === '--run';

let stdinBuf = Buffer.alloc(0);
if (IS_MAIN && !RUN_ONCE) {
  process.stdin.on('data', (chunk) => {
    stdinBuf = Buffer.concat([stdinBuf, chunk]);
    for (;;) {
      const r = readLine(stdinBuf);
      if (!r) break;
      stdinBuf = r.rest;
      if (!r.line) continue;
      let msg;
      try { msg = JSON.parse(r.line); } catch (e) { logErr('bad rpc line', e.message); continue; }
      if (msg && msg.id !== undefined && msg.method) {
        const h = handlers[msg.method];
        if (!h) { respond(msg.id, false, null, new Error('unknown method: ' + msg.method)); continue; }
        Promise.resolve()
          .then(() => h(msg.params || {}, msg))
          .then((res) => respond(msg.id, true, res === undefined ? null : res))
          .catch((err) => respond(msg.id, false, null, err));
      }
    }
  });
  process.stdin.on('end', () => { shutdown(0); });
}
if (IS_MAIN) {
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('uncaughtException', (e) => { logErr('uncaught', e.stack || e.message); });
}

/** 进程关闭：强杀浏览器与调试窗口子进程后退出（SIGTERM/SIGINT/stdin end 触发）。 */
async function shutdown(code) {
  try { if (browser.proc) browser.proc.kill(); } catch (e) { /* ignore */ }
  try {
    if (dwindow.proc && dwindow.proc.pid) {
      if (process.platform === 'win32') execSync('taskkill /pid ' + dwindow.proc.pid + ' /T /F', { stdio: 'ignore', timeout: 10000 });
      else dwindow.proc.kill('SIGKILL');
    }
  } catch (e) { /* ignore */ }
  process.exit(code);
}

/* ------------------------------------------------------------------ */
/* minimal WebSocket client (RFC6455) over a raw socket               */
/* ------------------------------------------------------------------ */
/** 发起 WebSocket 握手（手写 RFC6455，零依赖）：http Upgrade 请求 → 升级为原始 socket。
 * @param {string} wsUrl ws:// 地址（CDP browser 端点）
 * @param {number} [timeoutMs] 握手超时
 * @returns {Promise<object>} makeWsClient 客户端 */
function wsConnect(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(wsUrl); } catch (e) { return reject(new Error('bad ws url: ' + wsUrl)); }
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: (u.pathname || '/') + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('ws connect timeout')); }, timeoutMs);
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer);
      const client = makeWsClient(socket);
      resolve(client);
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

/** 基于原始 socket 的最小 WebSocket 客户端：
 * - 帧解析（opcode 1 文本 / 8 关闭 / 9-10 ping-pong 自动应答）
 * - sendText：客户端→服务端帧必须掩码（RFC6455 §5.1）
 * - onMessage：注册消息监听（返回注销函数）
 * @param {net.Socket} socket 已升级的 socket */
function makeWsClient(socket) {
  const client = {
    socket,
    buffer: Buffer.alloc(0),
    listeners: [],
    onMessage(fn) { client.listeners.push(fn); return () => { client.listeners = client.listeners.filter((x) => x !== fn); }; },
    sendText(text) {
      const payload = Buffer.from(text, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
      socket.write(Buffer.concat([header, mask, masked]));
    },
    close() { try { socket.end(); } catch (e) { /* ignore */ } },
  };
  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    try { client._parse(); } catch (e) { logErr('ws parse error', e.message); }
  });
  socket.on('error', (e) => { logErr('ws socket error', e.message); });
  socket.on('close', () => { for (const l of [...client.listeners]) { try { l({ method: '_closed', params: {} }); } catch (e) { /* ignore */ } } });
  client._parse = () => {
    for (;;) {
      const buf = client.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(2147483647)) throw new Error('frame too large'); len = Number(big); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      const maskKey = masked ? buf.slice(offset, offset + 4) : null;
      offset += maskLen;
      let payload = buf.slice(offset, offset + len);
      if (maskKey) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ maskKey[i & 3]; }
      client.buffer = buf.slice(offset + len);
      if (opcode === 1 || (opcode === 0 && client._frag)) {
        client._frag = client._frag || { text: '' };
        client._frag.text += payload.toString('utf8');
        if (fin) {
          const text = client._frag.text;
          client._frag = null;
          let m;
          try { m = JSON.parse(text); } catch (e) { logErr('bad cdp json', e.message); continue; }
          for (const l of [...client.listeners]) { try { l(m); } catch (e) { logErr('listener error', e.message); } }
        }
      } else if (opcode === 9) { /* ping -> pong (empty payload, masked) */
        socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
      } else if (opcode === 8) { try { socket.end(); } catch (e) { /* ignore */ } }
    }
  };
  return client;
}

/* ------------------------------------------------------------------ */
/* CDP client                                                          */
/* ------------------------------------------------------------------ */
const CDP_CALL_TIMEOUT_MS = 30000;

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    this.closed = false;
    ws.onMessage((m) => this._onMessage(m));
    this._closeUnsub = ws.onMessage ? null : null;
    this._onClose = () => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        p.reject(new Error('cdp connection closed'));
      }
      this.pending.clear();
    };
  }
  _onMessage(m) {
    if (m.method === '_closed') { this._onClose(); return; }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'cdp error'));
        else p.resolve(m.result || {});
      }
    } else {
      for (const l of [...this.listeners]) { try { l(m); } catch (e) { logErr('cdp listener error', e.message); } }
    }
  }
  call(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('cdp connection closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('cdp call timeout: ' + method + ' (' + (CDP_CALL_TIMEOUT_MS / 1000) + 's)'));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try { this.ws.sendText(JSON.stringify(msg)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  on(listener) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter((l) => l !== listener); }; }
}

/* ------------------------------------------------------------------ */
/* Chrome discovery & browser lifecycle                                */
/* ------------------------------------------------------------------ */
/** 查找本机 Chrome/Edge 可执行文件（按平台搜索常见路径；DS_WEB_CHROME 可显式指定）。 */
function findChrome() {
  if (CFG.chromePath) return CFG.chromePath;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return null;
}

/** 轮询等待文件出现并读取内容（Chrome 启动后写 DevToolsActivePort 有延迟），超时返回 null。 */
async function waitForFile(file, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8'); } catch (e) { /* ignore */ }
    await sleep(200);
  }
  return null;
}

const browser = {
  proc: null,
  profile: null,
  cdp: null,
  ws: null,
  pages: new Map(), // pageId -> { targetId, sessionId, url }
  pageSeq: 0,
  launching: null,
};

/**
 * 启动/复用浏览器（单一常驻原则）。
 * - 同 profile 已在运行 → 直接复用（不因 headless 差异重建，防 cookie 丢失）
 * - profile 切换 → 先发 channels-reset 事件通知网关（全部会话转 recovery），再重启
 * - 启动流程：清理残留锁文件 → spawn Chrome（动态调试端口）→ 读 DevToolsActivePort
 *   → WebSocket 连接 CDP；失败自动重试 1 次
 * @param {object} profile { name, headless } 账号 profile 配置 */
async function launchBrowser(profile) {
  /* 单一常驻浏览器原则：只要 profile 相同就复用同一 Chrome 实例，
   * 绝不因 headless 参数差异重建（重建会导致 DeepSeek 会话 cookie 丢失）。
   * 首次启动的 headless 状态决定窗口可见性；登录/推理/校准共用该实例。 */
  if (browser.proc && browser.profile && browser.profile.name === profile.name && browser.cdp && !browser.cdp.closed) return;
  /* profile 切换重启：所有通道页面的网页版历史将随旧浏览器销毁。
   * 通知网关把全部会话标记为 epoch 失配 → 各会话下一请求强制 recovery 重建，
   * 否则 delta 增量发进空白页面，模型文不对题。 */
  if (browser.proc && browser.profile && browser.profile.name !== profile.name) {
    log('profile 切换: ' + browser.profile.name + ' → ' + profile.name + '（通知网关全部会话转 recovery）');
    emitEvent('channels-reset', { from: browser.profile.name, to: profile.name });
  }
  if (browser.launching) await browser.launching.catch(() => {});
  const launch = (async () => {
    await closeBrowser();
    const chrome = findChrome();
    if (!chrome) throw new Error('Chrome/Edge not found. Set DS_WEB_CHROME or install Chrome/Edge.');
    const dir = profileDir(profile.name);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const headless = effectiveHeadless(profile);
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      /* clear stale state from previous runs (crash leftovers, profile locks) */
      for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try {
          const fp = path.join(dir, f);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) { /* ignore */ }
      }
      const args = [
        chrome,
        '--user-data-dir=' + dir,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-features=Translate,OptimizationHints,msEdgeSidebarV2',
        '--window-size=1280,900',
        'about:blank',
      ];
      if (headless) args.splice(1, 0, '--headless=new');
      log('launching', chrome, 'headless=' + headless, 'profile=' + profile.name, 'attempt=' + attempt);
      const proc = spawn(args[0], args.slice(1), { stdio: 'ignore' });
      browser.proc = proc;
      proc.on('error', (e) => { logErr('browser spawn error', e.message); });
      proc.on('exit', (code) => {
        log('browser exited', code);
        if (browser.proc === proc) {
          browser.proc = null;
          browser.cdp = null;
          browser.ws = null;
          browser.pages.clear();
        }
      });
      const portFile = path.join(dir, 'DevToolsActivePort');
      const content = await waitForFile(portFile, 25000);
      if (!content) {
        lastErr = new Error('browser did not expose DevTools port (profile: ' + profile.name + ')');
        await closeBrowser();
        await sleep(1200);
        continue;
      }
      const lines = content.split(/\r?\n/).filter((x) => x.trim().length > 0);
      const port = parseInt(lines[0], 10);
      const wsPath = lines[1] || '/devtools/browser/' + crypto.randomUUID();
      const wsUrl = 'ws://127.0.0.1:' + port + wsPath;
      try {
        const ws = await wsConnect(wsUrl, 15000);
        const cdp = new CdpClient(ws);
        browser.cdp = cdp;
        browser.ws = ws;
        browser.profile = profile;
        log('cdp connected', wsUrl);
        return;
      } catch (e) {
        lastErr = e;
        await closeBrowser();
        await sleep(1200);
      }
    }
    throw lastErr || new Error('browser launch failed');
  })();
  browser.launching = launch;
  try { await launch; } finally { browser.launching = null; }
}

/** 关闭浏览器进程并清空全部页面状态（Windows 用 taskkill 树杀，POSIX 用 SIGKILL）。 */
async function closeBrowser() {
  const proc = browser.proc;
  browser.proc = null;
  browser.cdp = null;
  browser.ws = null;
  browser.pages.clear();
  browser.pageSeq = 0;
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /pid ' + proc.pid + ' /T /F', { stdio: 'ignore', timeout: 10000 });
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) {
      try { proc.kill(); } catch (e2) { /* ignore */ }
    }
  }
  await sleep(600);
}

/** 确保浏览器以指定 profile 运行（缺省用配置首个 profile）。 */
async function ensureBrowser(profile) {
  const p = profile || CFG.profiles[0] || { name: 'default', headless: CFG.headless };
  await launchBrowser(p);
  return browser;
}

/* ------------------------------------------------------------------ */
/* page management                                                     */
/* ------------------------------------------------------------------ */
/** 新建浏览器 Tab（可选 newWindow 独立窗口），attach 后启用 Runtime/Page/DOM 域。
 * @returns {Promise<string>} pageId（内部递增标识） */
async function newPage(opts) {
  const cdp = browser.cdp;
  if (!cdp) throw new Error('browser not running');
  const params = { url: 'about:blank' };
  if (opts && opts.newWindow) params.newWindow = true;
  const t = await cdp.call('Target.createTarget', params);
  const targetId = t.targetId;
  const att = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = att.sessionId;
  const pageId = 'p' + (++browser.pageSeq);
  browser.pages.set(pageId, { targetId, sessionId, url: 'about:blank' });
  await cdp.call('Runtime.enable', {}, sessionId);
  await cdp.call('Page.enable', {}, sessionId);
  await cdp.call('DOM.enable', {}, sessionId);
  return pageId;
}

/** 查询页面信息（targetId/sessionId/url）。 */
function pageInfo(pageId) { return browser.pages.get(pageId); }

/** 关闭 Tab；保活策略：最后一个页面被关时补 about:blank，防浏览器进程退出丢 cookie。 */
async function closePage(pageId) {
  const p = pageInfo(pageId);
  if (!p) return;
  browser.pages.delete(pageId);
  try { await browser.cdp.call('Target.closeTarget', { targetId: p.targetId }); } catch (e) { /* ignore */ }
  /* 保活：若没有任何页面了，补一个 about:blank 标签，避免 Chrome 窗口关闭导致进程退出、会话丢失 */
  if (browser.pages.size === 0 && browser.proc) {
    try { await newPage(); } catch (e) { /* ignore */ }
  }
}

/** 在页面上下文执行 JavaScript 表达式（DOM 表达式引擎的唯一执行入口）。
 * awaitPromise=true（支持页面侧 async IIFE）；页面抛异常时转 Node 侧 Error。
 * @param {string} pageId 页面 ID
 * @param {string} expression JS 表达式（非函数体，直接 eval）
 * @param {object} [opts] { userGesture: true } 需要"用户手势"权限的操作（如下载/剪贴板）
 * @returns {Promise<any>} 表达式返回值（returnByValue 序列化） */
async function evalJs(pageId, expression, opts) {
  const p = pageInfo(pageId);
  if (!p) throw new Error('page gone');
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (opts && opts.userGesture) params.userGesture = true;
  const r = await browser.cdp.call('Runtime.evaluate', params, p.sessionId);
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new Error('page eval: ' + (ex ? (ex.description || ex.value) : r.exceptionDetails.text));
  }
  return r.result && r.result.value;
}

/** 导航到 URL 并等待页面就绪（document.body 出现）。
 * CDP 调用自带 30s 超时；waitReady 额外轮询确保页面实际渲染。 */
async function navigate(pageId, url) {
  const p = pageInfo(pageId);
  if (!p) throw new Error('page gone');
  await browser.cdp.call('Page.navigate', { url }, p.sessionId);
  const ready = await waitReady(pageId, 30000);
  if (!ready) log('navigate waitReady timed out for ' + pageId + ' url=' + String(url).slice(0, 80));
}

/** 轮询等待页面就绪（readyState + body 存在），超时返回 false（导航中间态异常吞掉继续等）。 */
async function waitReady(pageId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > timeoutMs) return false;
    try {
      const st = await evalJs(pageId, '(() => { return { ready: document.readyState, hasBody: !!document.body, title: (document.title||"").slice(0,80) }; })()');
      if (st && st.hasBody) return true;
    } catch (e) { /* page mid-nav */ }
    await sleep(300);
  }
}

/** 轮询等待表达式返回真值（页面条件等待通用器），超时返回 null。 */
async function waitFor(pageId, expression, timeoutMs, intervalMs) {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > timeoutMs) return null;
    try {
      const v = await evalJs(pageId, expression);
      if (v) return v;
    } catch (e) { /* keep polling */ }
    await sleep(intervalMs || 300);
  }
}

/* ------------------------------------------------------------------ */
/* DOM expressions (ported from deepseek-browser-agent)                */
/* ------------------------------------------------------------------ */
const EXPR = {
  messageCount: `(() => {
    const cands = ['.ds-message','.ds-assistant-message-main-content','[class*="assistant"][class*="message"]','[data-role="assistant"]','[class*="markdown-content"]','[class*="chat-message"]','[class*="message-bubble"]'];
    for (const s of cands) { const els = document.querySelectorAll(s); if (els.length) return els.length; }
    return document.querySelectorAll('[class*="message"]').length;
  })()`,

  extractLast: `(() => {
    function walk(node, out) {
      if (!node) return;
      if (node.nodeType === 3) { out.push(node.textContent); return; }
      if (node.nodeType !== 1) return;
      /* 折叠/隐藏元素整体跳过：思考容器折叠后 display:none / visibility:hidden，
       * 其内容不应混入正文（已通过 extractThinking → kind=thinking 流式输出） */
      const cs = node.nodeType === 1 ? window.getComputedStyle(node) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return;
      /* 思考模式（DeepThink）修复：class 含 think/reasoning 的容器（思考流/折叠头
       * "已深度思考（用时N秒）"）整体跳过——思考文本绝不能混入回答。
       * 排除（保留）列表只放强正文信号 markdown/answer/message/reply/response；
       * 不要放 content（几乎每个容器都含 content，真实思考容器正是 .ds-think-content，
       * 含 think 又含 content，放 content 会让排除条件失效、思考文本泄漏进正文）。
       * 额外检测：data-type/data-role 含 think/reasoning 的容器也跳过
       * （DeepSeek Web 可能用 data-* 属性而非 class 标记思考容器）。 */
      const cls = String(node.className || '').toLowerCase();
      const dataRole = (node.getAttribute('data-type') || node.getAttribute('data-role') || '').toLowerCase();
      const isThink = (cls && /think|reasoning/.test(cls) && !/markdown|answer/.test(cls))
                   || (dataRole && /think|reasoning/.test(dataRole));
      if (isThink) return;
      /* 智能搜索模式修复：class 含 search 的容器（搜索结果/搜索指示器/搜索摘要）
       * 整体跳过——搜索文本绝不能混入回答正文（搜索结果由 thinking 流或正文输出）。
       * 排除列表仅保留 markdown/answer（强正文信号），移除 message/content/reply/response
       * （过于通用，搜索结果容器常含这些词导致过滤失效）。 */
      if (cls && /search/.test(cls) && !/markdown|answer/.test(cls)) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'pre') {
        const codeEl = node.querySelector('code');
        if (codeEl) {
          const cls = codeEl.className || '';
          const lang = (cls.match(/language-(\\S+)/) || [])[1] || '';
          out.push('\\n\`\`\`' + lang + '\\n' + (codeEl.textContent || '') + '\\n\`\`\`\\n');
        } else out.push('\\n\`\`\`\\n' + (node.textContent || '') + '\\n\`\`\`\\n');
        return;
      }
      if (tag === 'code') {
        const pt = node.parentElement ? node.parentElement.tagName.toLowerCase() : '';
        if (pt !== 'pre') out.push('\`' + (node.textContent || '') + '\`');
        return;
      }
      for (const ch of node.childNodes) walk(ch, out);
      if (['p','div','li','br','h1','h2','h3','h4','h5','h6'].includes(tag)) out.push('\\n');
    }
    function fullText(el) { const out = []; walk(el, out); return out.join('').trim(); }
    /* Only extract from a root that explicitly identifies an assistant message.
     * Unscoped markdown/content/message selectors can point to the user's latest
     * input and must never enter DSH's content or tool-call parser. Returning an
     * empty string when no verified root exists is safer than emitting a prompt. */
    const assistantRoots = [
      '.ds-assistant-message-main-content',
      '[class*="assistant-message-main"]',
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]',
      '[class*="assistant"][class*="message"]',
      '[class*="ai-message"]',
      '[class*="bot-message"]',
    ];
    for (const selector of assistantRoots) {
      const nodes = document.querySelectorAll(selector);
      if (!nodes.length) continue;
      const text = fullText(nodes[nodes.length - 1]);
      /* A verified assistant root may legitimately contain a one-character answer
       * or a tool-call prefix, so do not impose a text-length threshold here. */
      if (text) return text;
    }
    return '';
  })()`,

  generating: `(() => {
    /* 停止按钮（生成中可见、完成后消失）是最可靠的"正在生成"正信号：
     * 覆盖英文 Stop、中文 停止/暂停，以及常见 stop/pause/generating 类名 */
    const stopSels = ['button[aria-label*="Stop" i]','button[aria-label*="停止" i]','button[aria-label*="暂停" i]','[class*="stop-gen"]','[class*="stopGen"]','[class*="stop"]','[class*="pause"]','[class*="abort"]','[class*="generating"]','[class*="is-generating"]','[class*="streaming"]','[class*="in-progress"]','[data-status="generating"]','[data-status="streaming"]'];
    for (const s of stopSels) { const el = document.querySelector(s); if (el) { const cs = window.getComputedStyle(el); if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') return true; } }
    /* 仅保留强"正在生成"信号：typing/loading/spinner/dot-pulse/dot-flashing/thinking-indicator
     * 去掉易误判为常驻的 cursor/blink/pulsing（输入框光标、代码块复制按钮等会持续命中，
     * 导致完成后仍判定为 generating → 轮询直到 240s 超时，表现为 dsh 不停止） */
    const loaderSels = ['[class*="typing"]','[class*="spinner"]','svg[class*="spinner"]','[class*="dot-pulse"]','[class*="dot-flashing"]','[class*="thinking-indicator"]','[class*="loading-indicator"]'];
    for (const s of loaderSels) { const el = document.querySelector(s); if (el) { const cs = window.getComputedStyle(el); if (cs.display !== 'none' && cs.visibility !== 'hidden') return true; } }
    return false;
  })()`,

  /* 思考中检测（DeepThink 流式期间）——思考模式的完成判定防线：
   * 1) 全局进行时标题（"深度思考中…"/"Thinking..."）；
   * 2) 可见的 thinking/reasoning 容器（innerText 跳过 display:none 的折叠内容，
   *    textContent 会误读折叠后的思考正文导致永不退出）；
   * 完成折叠头（"已深度思考（用时N秒）"/"Thought for N seconds"）不算思考中。
   * 用途：轮询完成判定加 !thinking——思考中/折叠间隙绝不提前退出（防截断） */
  thinking: `(() => {
    const body = (document.body && document.body.innerText) || '';
    if (/深度思考中|正在深度思考|思考中\\.\\.|Thinking\\.\\./.test(body)) return true;
    const done = /^(已(?:深度)?思考|深度思考（已|Thought for)/;
    const doneBody = /已(?:深度)?思考（用时|Thought for\s+\d+/;
    let hasAnswer = false;
    const answerEls = document.querySelectorAll('.ds-assistant-message-main-content, [class*="assistant-message-main"], .ds-markdown.ds-assistant-message-main-content');
    for (const ans of answerEls) {
      const acs = window.getComputedStyle(ans);
      if (acs.display === 'none' || acs.visibility === 'hidden') continue;
      const at = (ans.innerText || '').trim();
      if (at && at.length > 20) { hasAnswer = true; break; }
    }
    /* 真实思考容器为 .ds-think-content（含 think 但无 thinking 子串），
     * [class*="thinking"] 匹配不到 → 改用 [class*="think"] 同时覆盖
     * ds-think-content / ds-thinking-content / ds-thinking-block */
    const els = document.querySelectorAll('[class*="think"], [class*="reasoning"]');
    for (const el of els) {
      if (el.closest && el.closest('button, [role="button"], label')) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (el.innerText || '').trim();
      if (!t) continue;
      if (hasAnswer && doneBody.test(body)) continue;
      if (done.test(t) && t.length < 80) continue;
      return true;
    }
    return false;
  })()`,

  /* 提取当前思考流文本（DeepThink 流式思考输出，v3 真流式核心）：
   * - 只取可见容器（思考完成后折叠 display:none → 读不到，此时返回 ''，
   *   思考全文已通过增量事件发完，由调用侧差分）
   * - 跳过按钮内元素（pill 开关误命中）与折叠头文案（"已深度思考（用时N秒）"）
   * - 多容器命中取最长（嵌套思考容器去重）
   * 返回当前思考全量文本，调用侧与上次快照差分发 kind='thinking' 增量 */
  extractThinking: `(() => {
    const done = /^(已(?:深度)?思考|深度思考（已|Thought for)/;
    const doneBody = /已(?:深度)?思考（用时|Thought for\s+\d+/;
    const body = (document.body && document.body.innerText) || '';
    let hasAnswer = false;
    const answerEls = document.querySelectorAll('.ds-assistant-message-main-content, [class*="assistant-message-main"], .ds-markdown.ds-assistant-message-main-content');
    for (const ans of answerEls) {
      const acs = window.getComputedStyle(ans);
      if (acs.display === 'none' || acs.visibility === 'hidden') continue;
      const at = (ans.innerText || '').trim();
      if (at && at.length > 20) { hasAnswer = true; break; }
    }
    /* 同 EXPR.thinking：真实思考容器 .ds-think-content 需用 [class*="think"] 才能命中 */
    const els = document.querySelectorAll('[class*="think"], [class*="reasoning"]');
    let best = '';
    for (const el of els) {
      if (el.closest && el.closest('button, [role="button"], label')) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (el.innerText || '').trim();
      if (!t || t.length <= best.length) continue;
      if (hasAnswer && doneBody.test(body)) continue;
      if (done.test(t) && t.length < 80) continue;
      best = t;
    }
    return best;
  })()`,

  /* 完成态正信号（v3c 防提前终止丢内容）：DeepSeek 生成完成后才出现"复制 / 重新生成
   * / 编辑 / 分享"动作按钮，生成中绝不显示。generating 选择器偶发漏检（停止按钮 class
   * 不匹配）时，仅靠"文本稳定"判定会在生成中 DOM 突发静默间隙误触发提前 break；
   * 用完成态动作按钮作可靠正信号，配合文本稳定即可确定完成。按按钮文字/aria-label
   * 匹配，避免依赖易变 class。 */
  doneActions: `(() => {
    const acts = ['复制', '重新生成', 'regenerate', 'copy', '编辑', 'edit', '分享', 'share'];
    const els = document.querySelectorAll('button, [role="button"]');
    for (const el of els) {
      const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
      if (!t) continue;
      if (acts.some((a) => t.includes(a.toLowerCase()))) {
        const cs = window.getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') return true;
      }
    }
    return false;
  })()`,

  /* 智能搜索中检测（联网搜索/智能搜索阶段）——搜索阶段的完成判定防线：
   * DeepSeek 思考折叠后进入搜索阶段时，thinking=false 但页面仍在搜索/处理搜索结果，
   * 此时正文尚未出现，文本可能暂时稳定。若不加 !searching 守卫，5s 兜底条件会
   * 误判为完成，导致正文内容丢失（仅输出思考文本就结束）。
   * 检测方式：
   * 1) 全局进行时文本（"搜索中"/"联网搜索中"/"Searching..."）；
   * 2) 可见的搜索结果容器（class 含 search/web-search/searching/search-result）；
   *    排除搜索开关 pill（短文本，通常是"智能搜索"/"联网搜索"）和完成态文案。
   * 用途：轮询完成判定加 !searching——搜索阶段绝不提前退出（防截断正文） */
  searching: `(() => {
    const body = (document.body && document.body.innerText) || '';
    let hasAnswer = false;
    const answerEls = document.querySelectorAll('.ds-assistant-message-main-content, [class*="assistant-message-main"], .ds-markdown.ds-assistant-message-main-content');
    for (const el of answerEls) {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (el.innerText || '').trim();
      if (t && t.length > 20) { hasAnswer = true; break; }
    }
    if (!hasAnswer && /搜索中[\\.。…]*|联网搜索中|网络搜索中|Searching\\.\\./.test(body)) return true;
    if (!hasAnswer && /浏览\s*\d+\s*个页面|正在浏览页面|Opening \d+ pages|Browsing \d+ pages/i.test(body)) return true;
    /* 搜索完成态文案模式（完成态不算搜索中，允许完成判定通过）：
     * 1) 短文案以"搜索到"/"已搜索"/"Found"/"Searched"开头（<80字符）
     * 2) 长文案包含"搜索到 N 个网页"模式（搜索结果摘要容器可能很长，
     *    但只要包含完成态关键词，说明搜索已完成，正文正在/已经生成） */
    const doneShort = /^(搜索到|已搜索|Found \\d|Searched)/;
    const doneLong = /搜索到\\s*\\d+\\s*个网页|已搜索|Found \\d+|Searched \\d+/;
    const els = document.querySelectorAll('[class*="search"], [class*="web-search"], [class*="searching"], [class*="search-result"]');
    for (const el of els) {
      if (el.closest && el.closest('button, [role="button"], label')) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (el.innerText || '').trim();
      if (!t) continue;
      if (doneShort.test(t) && t.length < 80) { if (!hasAnswer) return true; continue; }
      if (doneLong.test(t)) { if (!hasAnswer) return true; continue; }
      if (t.length <= 8 && /搜索|search/i.test(t)) continue;
      return true;
    }
    return false;
  })()`,

  /* ---------- pill 开关（2026-08 页面重构：无模型选择器，输入框下方 pill） ----------
   * toggleState：读开关当前状态（true=开/false=关/null=无法判定）
   * 状态信号优先级：aria-pressed > aria-checked > data-state > class 中的 active 类名 */
  toggleState: (labels) => `(() => {
    const labels = ${JSON.stringify(labels)};
    function findPill() {
      const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [class*="toggle"], [class*="switch"], [class*="pill"], [class*="mode"], [class*="tab"], label, div[class*="option"], span[class*="option"], a[role="tab"]'));
      for (const lab of labels) {
        const needle = String(lab).toLowerCase();
        for (const el of els) {
          const txt = ((el.innerText || el.textContent || '').trim() || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const all = [txt, aria, title];
          if (all.some((s) => s && (s === needle || s.includes(needle)))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
          }
        }
      }
      return null;
    }
    function readState(el) {
      const ap = el.getAttribute('aria-pressed');
      if (ap === 'true') return true;
      if (ap === 'false') return false;
      const ac = el.getAttribute('aria-checked');
      if (ac === 'true') return true;
      if (ac === 'false') return false;
      const as = el.getAttribute('aria-selected');
      if (as === 'true') return true;
      if (as === 'false') return false;
      const ds = el.getAttribute('data-state');
      if (ds === 'checked' || ds === 'on' || ds === 'active' || ds === 'open' || ds === 'selected') return true;
      if (ds === 'unchecked' || ds === 'off' || ds === 'inactive' || ds === 'unselected') return false;
      const cls = String(el.className || '').toLowerCase();
      const parts = cls.split(/\\s+/);
      if (parts.some((c) => /^(active|selected|checked|enabled|on|open|isOpen|current)$/.test(c))) return true;
      return null;
    }
    const pill = findPill();
    if (!pill) return { found: false, state: null };
    return { found: true, state: readState(pill) };
  })()`,

  /* setToggle：幂等设置开关到期望状态——先读状态，仅在不一致时点击。
   * 返回 { found, state, action: 'none'|'clicked' }。修复旧"点击了事"语义：
   * pill 是开关，盲点击会把已开启的深度思考再次点关（连续请求状态错乱）。 */
  setToggle: (labels, want) => `(() => {
    const labels = ${JSON.stringify(labels)};
    const want = ${JSON.stringify(!!want)};
    function findPill() {
      const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [class*="toggle"], [class*="switch"], [class*="pill"], [class*="mode"], [class*="tab"], label, div[class*="option"], span[class*="option"], a[role="tab"]'));
      for (const lab of labels) {
        const needle = String(lab).toLowerCase();
        for (const el of els) {
          const txt = ((el.innerText || el.textContent || '').trim() || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const all = [txt, aria, title];
          if (all.some((s) => s && (s === needle || s.includes(needle)))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
          }
        }
      }
      return null;
    }
    function readState(el) {
      const ap = el.getAttribute('aria-pressed');
      if (ap === 'true') return true;
      if (ap === 'false') return false;
      const ac = el.getAttribute('aria-checked');
      if (ac === 'true') return true;
      if (ac === 'false') return false;
      const as = el.getAttribute('aria-selected');
      if (as === 'true') return true;
      if (as === 'false') return false;
      const ds = el.getAttribute('data-state');
      if (ds === 'checked' || ds === 'on' || ds === 'active' || ds === 'open' || ds === 'selected') return true;
      if (ds === 'unchecked' || ds === 'off' || ds === 'inactive' || ds === 'unselected') return false;
      const cls = String(el.className || '').toLowerCase();
      const parts = cls.split(/\\s+/);
      if (parts.some((c) => /^(active|selected|checked|enabled|on|open|isOpen|current)$/.test(c))) return true;
      return null;
    }
    const pill = findPill();
    if (!pill) return { found: false, state: null, action: 'none' };
    const state = readState(pill);
    if (state === want) return { found: true, state, action: 'none' };
    pill.click();
    return { found: true, state, action: 'clicked' };
  })()`,

  findInput: `(() => {
    const sels = ['#chat-input','textarea[placeholder]','textarea','[contenteditable="true"][role="textbox"]','[contenteditable="true"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { found: true, tag: el.tagName.toLowerCase(), editable: el.isContentEditable === true };
      }
    }
    return { found: false };
  })()`,

  clickSend: `(() => {
    const sels = ['button[aria-label*="Send" i]','button[aria-label*="send" i]','[data-testid="send-button"]','button[type="submit"]','[class*="send-btn"]','[class*="sendBtn"]','[class*="send-button"]','[class*="send-icon"]','button[class*="send"]','button[aria-label*="提交"]','button[aria-label*="发送"]','button[aria-label*="enter"]','[class*="submit-btn"]','[class*="submitBtn"]'];
    for (const s of sels) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && !el.disabled) { el.click(); return true; } } }
    return false;
  })()`,

  clickNewChat: `(() => {
    const sels = ['button[aria-label*="New chat" i]','button[aria-label*="New conversation" i]','a[href="/"][aria-label]','[data-testid="new-chat"]','[class*="new-chat"]','[class*="newChat"]','button[aria-label*="新对话"]','button[aria-label*="新建对话"]','[class*="newChatButton"]','[class*="sidebar"] [class*="new"]','[class*="sidebar"] button','[class*="nav"] [class*="new"]','[class*="side"] button:first-child','[class*="list"] > button:first-child','button svg[class*="plus"]','button svg[class*="add"]','[class*="create-btn"]','[class*="createBtn"]'];
    for (const s of sels) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { el.click(); return true; } } }
    /* V4 兜底：找侧边栏中文本短且含"新"、"New"、"+"的按钮 */
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.length > 0 && t.length < 15 && (t.includes('新') || t.includes('New') || t.includes('new') || t === '+' || t === '＋')) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { b.click(); return true; }
      }
    }
    return false;
  })()`,

  loginState: `(() => {
    const url = window.location.href;
    const body = (document.body && document.body.innerText) || '';
    const hasPasswordInput = !!document.querySelector('input[type="password"]');
    const hasLoginButton = !!document.querySelector('button[type="submit"]') && (body.length < 500 || body.includes('Sign in') || body.includes('Log in'));
    return {
      needsLogin: url.includes('/auth') || url.includes('/login') || url.includes('/sign') || hasPasswordInput || hasLoginButton,
      url: url,
      hasChatInput: !!document.querySelector('#chat-input, textarea[placeholder], textarea, [contenteditable="true"]'),
    };
  })()`,

  buttons: `(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [class*="toggle"], [class*="switch"], [class*="mode"], [class*="tab"], label'));
    const seen = [];
    const out = [];
    for (const el of els) {
      const txt = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const display = txt || aria || title;
      if (!display) continue;
      const key = display.slice(0, 40);
      if (seen.includes(key)) continue;
      seen.push(key);
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.push({ text: display.slice(0, 80), aria: el.getAttribute('aria-pressed') || el.getAttribute('aria-selected'), ariaLabel: aria, title, cls: String(el.className || '').slice(0, 60), tag: el.tagName.toLowerCase() });
    }
    return out;
  })()`,

  clickText: (labels) => `(() => {
    const labels = ${JSON.stringify(labels)};
    const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [class*="toggle"], [class*="switch"], [class*="option"], [class*="menu-item"], [class*="mode"], [class*="tab"], div[class*="model"], span[class*="model"], a[role="tab"]'));
    for (const lab of labels) {
      const needle = String(lab).toLowerCase();
      for (const el of els) {
        const txt = ((el.innerText || el.textContent || '').trim() || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const all = [txt, aria, title];
        if (all.some((s) => s && (s === needle || s.includes(needle)))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return { clicked: true, matched: lab, text: (txt || aria || title).slice(0, 60) }; }
        }
      }
    }
    return { clicked: false };
  })()`,

  bodyTail: `(() => { const t = (document.body && document.body.innerText) || ''; return t.slice(-2500); })()`,

  domDebug: `(() => {
    const classFreq = {};
    document.querySelectorAll('*').forEach((el) => { el.classList.forEach((c) => { if (/message|chat|input|send|stop|markdown|content|assistant|user|bot|model|toggle|think/i.test(c)) classFreq[c] = (classFreq[c] || 0) + 1; }); });
    const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable]')).map((e) => ({ tag: e.tagName, id: e.id || null, cls: String(e.className || '').slice(0, 80), ph: e.placeholder || null, editable: e.isContentEditable, visible: e.offsetParent !== null }));
    return { url: window.location.href, title: document.title, classes: Object.entries(classFreq).sort((a, b) => b[1] - a[1]).slice(0, 50), inputs };
  })()`,

  modelBadge: `(() => {
    const sels = ['[class*="model-name"]','[class*="modelName"]','[class*="model-name-display"]','[class*="model-select"]','[class*="modelSelect"]','[class*="model"] button','button[class*="model"]'];
    for (const s of sels) { const el = document.querySelector(s); if (el) { const t = (el.innerText || el.textContent || '').trim(); if (t) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { text: t.slice(0, 60), tag: el.tagName.toLowerCase() }; } } }
    const all = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const el of all) { const t = (el.innerText || el.textContent || '').trim(); if (t && /deepseek|r1|v3|v4|flash|pro|ocr|模型/i.test(t)) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { text: t.slice(0, 60), tag: el.tagName.toLowerCase() }; } }
    return { text: '', tag: '' };
  })()`,

  setFileInput: (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el; })()`,
};

/* ------------------------------------------------------------------ */
/* chat operations                                                     */
/* ------------------------------------------------------------------ */
/** 检查页面登录状态（返回 loginState 表达式结果：needsLogin/hasChatInput/url 等）。
 * 只检测不处理——登录引导由上层（网关 /login 或 streamAsk errorKind=login 路径）负责。 */
async function ensureLoggedIn(pageId, providerId) {
  if (!isDeepSeekProvider(providerId)) {
    const adapter = resolveProviderAdapter(providerId);
    await waitReady(pageId, 30000);
    const challenge = await evalJs(pageId, adapter.expressions.detectChallenge).catch(() => false);
    if (challenge) return { needsLogin: false, hasChatInput: false, challenge: true, url: providerUrl(providerId) };
    const needsLogin = await evalJs(pageId, adapter.expressions.detectLogin).catch(() => true);
    const composer = await evalJs(pageId, adapter.expressions.findComposer).catch(() => ({ found: false }));
    return { needsLogin: !!needsLogin, hasChatInput: !!(composer && composer.found), challenge: false, url: providerUrl(providerId) };
  }
  await waitReady(pageId, 30000);
  const st = await evalJs(pageId, EXPR.loginState);
  if (st.needsLogin || !st.hasChatInput) {
    log('ensureLoggedIn: needsLogin=' + st.needsLogin + ' hasChatInput=' + st.hasChatInput + ' provider=' + (providerId || 'deepseek'));
  }
  return st;
}

/** 轮询等待聊天输入框出现（页面加载/登录完成信号）；期间检测到 needsLogin 立即抛错。 */
async function waitForChatInput(pageId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    let st = null;
    try { st = await evalJs(pageId, EXPR.loginState); } catch (e) { /* page mid-nav */ }
    if (st && st.needsLogin) throw new Error('login required: run dsweb_login (or the dashboard 登录 button) to log into chat.deepseek.com. url=' + st.url);
    try {
      const inp = await evalJs(pageId, EXPR.findInput);
      if (inp && inp.found) return st;
    } catch (e) { /* keep waiting */ }
    if (Date.now() - start > timeoutMs) {
      throw new Error('chat input not found - login may be needed (run dsweb_login). url=' + (st ? st.url : '?'));
    }
    await sleep(1000);
  }
}

/* 幂等设置单个 pill 开关：读状态 → 不一致才点击 → 复核。
 * 返回 { ok, name, action: 'clicked'|'already'|'not-found', state } */
async function setPill(pageId, labels, want, name) {
  try {
    const r = await evalJs(pageId, EXPR.setToggle(labels, want));
    if (!r || !r.found) return { ok: false, name, action: 'not-found', state: null };
    if (r.action === 'none') return { ok: true, name, action: 'already', state: r.state };
    /* 点击后等待 UI 状态生效并复核 */
    await sleep(450);
    let after = null;
    try { after = (await evalJs(pageId, EXPR.toggleState(labels))).state; } catch (e) { /* ignore */ }
    return { ok: true, name, action: 'clicked', state: after };
  } catch (e) {
    return { ok: false, name, action: 'error', error: e.message };
  }
}

/** 应用模型配置到页面（2026-08 页面重构后：三模式入口 + pill 开关组合）。
 * 模式入口三选一（幂等 setMode：读激活态，不一致才点击）：
 *   quick  快速模式 —— 可选 pill：深度思考、智能搜索（可同开）
 *   expert 专家模式 —— 可选 pill：深度思考
 *   vision 识图模式 —— 可选 pill：深度思考
 * 顺序：模式入口 → 深度思考 pill（三模式通用）→ 智能搜索 pill（仅 quick 模式有）。
 * 全程幂等（setPill 先读状态不一致才点击），并回填校准回退 fallback。
 * @param {string} pageId 页面 ID
 * @param {object} opts { mode: 'quick'|'expert'|'vision', deepThink, search }
 * @returns {Promise<{toggles: string[], warnings: string[]}>} 应用报告 */
async function applyConfig(pageId, opts) {
  const report = { toggles: [], warnings: [] };
  try {
    /* 1) 模式入口（三选一，幂等：已激活则不点击）。
     * quick 入口找不到时静默——页面默认即快速模式（无显式入口）；
     * expert/vision 找不到才告警（显式切换失败）。 */
    const modeLabels = {
      quick: ['快速', '快速模式', 'Quick', '闪电', '闪电模式', 'Instant'],
      expert: ['专家', '专家模式', 'Expert', '钻石', '钻石模式', 'Pro'],
      vision: ['识图', '视图', '识图模式', '图片理解', 'Vision', '眼睛'],
    };
    const wantMode = modeLabels[opts.mode] ? opts.mode : 'quick';
    const m = await setPill(pageId, modeLabels[wantMode], true, 'mode');
    if (m.ok && m.action === 'clicked') {
      report.toggles.push('mode:' + wantMode + '(' + m.action + ')');
      await sleep(600); /* 模式切换后 UI 需要时间挂载对应 pill */
    } else if (!m.ok && wantMode !== 'quick') {
      /* 降级：setPill 状态读不到时退回盲点击（expert/vision 入口降级盲点击路径） */
      const v = await evalJs(pageId, EXPR.clickText(modeLabels[wantMode]));
      if (v.clicked) { report.toggles.push('mode:' + wantMode + '(clickText:' + v.matched + ')'); await sleep(600); }
      else report.warnings.push(wantMode + ' mode entry not found');
    }
    /* 2) 深度思考 pill（快速/专家/识图模式均可选） */
    const wantThink = opts.deepThink === true;
    const t = await setPill(pageId, ['深度思考', 'DeepThink', 'Deep Think', '深度推理'], wantThink, 'think');
    if (t.ok) report.toggles.push('think:' + (wantThink ? 'on' : 'off') + '(' + t.action + (t.state !== null && t.state !== undefined ? ',state=' + t.state : '') + ')');
    else if (wantThink) report.warnings.push('deep-think pill not found');
    await sleep(300);
    /* 3) 智能搜索 pill（仅 quick 模式提供；expert/vision 页面无此开关，跳过防误告警） */
    const wantSearch = opts.search === true && wantMode === 'quick';
    const s = await setPill(pageId, ['智能搜索', '联网搜索', '联网', 'Search'], wantSearch, 'search');
    if (s.ok) report.toggles.push('search:' + (wantSearch ? 'on' : 'off') + '(' + s.action + ')');
    else if (wantSearch) report.warnings.push('search pill not found');
    await sleep(400);
  } catch (e) {
    report.warnings.push('applyConfig error: ' + e.message);
  }
  return report;
}

/** 上传图片（识图模式）：必要时先点附件按钮触发 file input 挂载，
 * 再通过 CDP DOM.setFileInputFiles 直接设值（绕过隐藏 input 无法 click 的限制）。 */
async function uploadImage(pageId, absPath) {
  const cdp = browser.cdp;
  const p = pageInfo(pageId);
  if (!p) throw new Error('page gone');
  if (!fs.existsSync(absPath)) throw new Error('image not found: ' + absPath);
  /* open the attachment picker if a hidden file input is not present yet */
  const has = await evalJs(pageId, EXPR.setFileInput('input[type="file"]'));
  if (!has) {
    const r = await evalJs(pageId, EXPR.clickText(['上传', '附件', 'Attach', 'attach', '＋', '+', '添加']));
    await sleep(600);
  }
  const doc = await cdp.call('DOM.getDocument', { depth: -1 }, p.sessionId);
  const q = await cdp.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' }, p.sessionId);
  if (!q || !q.nodeId) throw new Error('no file input found for image upload');
  await cdp.call('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [absPath] }, p.sessionId);
  await sleep(1500);
}

/** 向聊天输入框填入文本并点击发送。
 * 两种输入框：contenteditable（execCommand insertText 触发 React）/
 * textarea（原生 setter + dispatchEvent）；点击后 CDP Enter 键兜底。
 * @param {string} pageId 页面 ID
 * @param {string} text 消息文本
 * @param {object} [opts] { imageData }（识图模式附图路径） */
async function sendMessage(pageId, text, opts) {
  const cdp = browser.cdp;
  const p = pageInfo(pageId);
  if (!p) throw new Error('page gone');
  const inp = await evalJs(pageId, EXPR.findInput);
  if (!inp || !inp.found) throw new Error('chat input not found (logged in?)');
  /* focus + 清空 + 输入（参考 deepseek-browser-agent：execCommand + 手动 InputEvent 触发 React，
   * 否则发送按钮保持 disabled 导致无法发送） */
  if (inp.editable) {
    await evalJs(pageId, `(() => {
      const el = document.querySelector('[contenteditable="true"]');
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
      return true;
    })()`);
  } else {
    await evalJs(pageId, `(() => {
      const el = document.querySelector('textarea');
      if (!el) return false;
      el.focus();
      const proto = window.HTMLTextAreaElement ? HTMLTextAreaElement.prototype : Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)});
      else { el.value = ${JSON.stringify(text)}; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }
  /* 等待发送按钮可用（React 异步更新按钮状态，最多等 3 秒） */
  let sendReady = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    try {
      sendReady = await evalJs(pageId, `(() => {
        const sels = ['button[aria-label*="Send" i]','[data-testid="send-button"]','button[type="submit"]','[class*="send-btn"]','[class*="sendBtn"]','[class*="send-button"]','[class*="send-icon"]'];
        for (const s of sels) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; } }
        return false;
      })()`);
    } catch (e) { /* ignore */ }
    if (sendReady) break;
  }
  if (!sendReady) log('sendMessage: send button not ready after 3s, trying anyway');
  /* 点击发送按钮 */
  const clicked = await evalJs(pageId, EXPR.clickSend);
  if (!clicked) {
    /* 完整 Enter 序列（keyDown + char + keyUp，对照 Playwright keyboard.press）。
     * CDP 级 Enter 不受 contenteditable 换行影响，直接触发提交 */
    const enterKeys = [
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    ];
    for (const k of enterKeys) { await cdp.call('Input.dispatchKeyEvent', k, p.sessionId); }
  }
  await sleep(500);
}

/** 提取当前网页会话的历史摘要（超限迁移用）：最近 15 条消息、每条压缩到 150 字。
 * @param {string} pageId 页面 ID
 * @returns {Promise<string>} 摘要文本（空串 = 提取失败/无历史）
 */
async function extractHistoryDigest(pageId) {
  const texts = await evalJs(pageId, `(() => {
    const out = [];
    const els = document.querySelectorAll('.ds-message, [class*="message"], .ds-markdown');
    for (const el of els) {
      const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 150);
      if (t && t.length > 5) out.push(t);
    }
    return out;
  })()`);
  return (texts || []).slice(-15).join('\n');
}

/** 新建对话（清空网页版会话历史）：优先点击"新对话"按钮，
 * 失败则导航回首页（DeepSeek 首页即新对话）并复核 URL 非 /chat/xxx。 */
async function newChat(pageId) {
  const clicked = await evalJs(pageId, EXPR.clickNewChat);
  if (clicked) { await sleep(1200); return; }
  /* 点击失败 → 导航到首页（DeepSeek 首页即新对话） */
  try { await navigate(pageId, DS_URL); } catch (e) { log('newChat navigate fallback failed', e.message); }
  await sleep(2000);
  /* 验证是否真的开了新对话：URL 应该是 / 而非 /chat/xxx */
  const urlOk = await evalJs(pageId, `(() => {
    const u = window.location.href;
    return u === ${JSON.stringify(DS_URL)} || u === ${JSON.stringify(DS_URL)} + '#/' || !u.includes('/chat/');
  })()`).catch(() => false);
  if (!urlOk) {
    log('newChat: URL still shows old chat, trying navigate again');
    try { await navigate(pageId, DS_URL); } catch (e) { /* ignore */ }
    await sleep(2000);
  }
}

/** 等待网页版回复完成（三阶段轮询）：
 * 1. 等新消息出现（messageCount 超过初始值，最多 15s）
 * 2. 轮询 extractLast 直到文本稳定（stableDelayMs 无变化）
 *    —— 思考模式（DeepThink）下"思考中/折叠间隙"不退出（防正文截断）
 * 3. 确认 generating=false 后取最终文本
 * @param {object} state 任务状态（pageId + stopped 停止信号）
 * @param {number} timeoutMs 总超时
 * @param {number} stableDelayMs 文本稳定判定窗口
 * @returns {Promise<string>} cleanText 后的最终回复 */
async function waitForResponse(state, timeoutMs, stableDelayMs) {
  const pageId = state.pageId;
  const start = Date.now();
  const initial = await evalJs(pageId, EXPR.messageCount);
  let appeared = false;
  while (Date.now() - start < 15000) {
    if (state.stopped) throw new Error('stopped');
    try {
      const c = await evalJs(pageId, EXPR.messageCount);
      if (c > initial) { appeared = true; break; }
    } catch (e) { /* keep waiting */ }
    await sleep(400);
  }
  let lastText = '';
  let stableStart = null;
  while (Date.now() - start < timeoutMs) {
    if (state.stopped) throw new Error('stopped');
    let text = '';
    try { text = await evalJs(pageId, EXPR.extractLast); } catch (e) { /* keep polling */ }
    if (text !== lastText) { lastText = text; stableStart = null; }
    else if (text.length > 0) {
      if (stableStart === null) stableStart = Date.now();
      else if (Date.now() - stableStart >= stableDelayMs) {
        let thinking = false;
        try { thinking = await evalJs(pageId, EXPR.thinking); } catch (e) { /* ignore */ }
        /* 思考模式（DeepThink）：思考中/折叠间隙不退出（防正文截断） */
        if (!thinking) {
          /* 稳定且不在思考即视为完成：不再强依赖 generating——生成中选择器偶发误判为
           * 常驻时，原 !gen && !thinking 会让本函数等到 timeoutMs 才退出（重试等待挂起）。
           * 兜底：稳定达到 max(stableDelayMs,5s) 即退出，挂起最多约 5s。 */
          let gen = true;
          try { gen = await evalJs(pageId, EXPR.generating); } catch (e) { /* assume generating */ }
          if (!gen || Date.now() - stableStart >= Math.max(stableDelayMs, 5000)) break;
        }
        stableStart = null;
      }
    }
    await sleep(500);
  }
  let final = '';
  try { final = await evalJs(pageId, EXPR.extractLast); } catch (e) { /* ignore */ }
  return cleanText(final);
}

/** 清理助手回复文本：去思考块（<think>/Thinking…）、去代码块操作按钮文本
 * （"1Copy/Run/Insert"行）、压缩连续空行。 */
function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
    .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
    .replace(/^\d+(?:Copy|Run|Insert|Edit)\b.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 限制信号模式表（动态风控检测核心，SPEC-v2 §5.3）：
 * - length：对话过长 → driver 内迁移+摘要重试（不上报网关不切账号）
 * - quota：配额/频率限制（含"服务器繁忙"等动态文案）→ errorKind 上报网关切账号
 * - captcha：人机验证 → errorKind 上报网关，账号转人工
 * 误判防线在调用侧：仅新回复 <400 字符且已实际出现（firstSeen）时才检测。 */
const LIMIT_PATTERNS = {
  length: [
    /对话.{0,8}(过长|超|限制|已满|已满员|无法继续)/i,
    /(上下文|内容).{0,8}(过长|超出|超限|限制)/i,
    /too (long|large|many)|context (length|limit)|exceeds? (the )?(limit|maximum)|limit reached/i,
  ],
  quota: [
    /(今日|当天|当前).{0,10}(对话|提问|消息|次数).{0,10}(用完|耗尽|达到上限|已达上限|已用完|受限)/i,
    /次数.{0,10}(用完|耗尽|上限|受限|限制)/i,
    /(发送|请求|操作).{0,6}(太频繁|过于频繁|请稍后|稍后再试)/i,
    /(服务器|系统).{0,4}繁忙/i,
    /rate limit|too many requests|quota|limit reached|try again later|please slow down/i,
  ],
  captcha: [
    /验证码|人机验证|安全验证|captcha|cloudflare|challenge/i,
  ],
};

/** 检测文本是否命中限制模式（length/quota/captcha 任一命中即返回）。
 * 注意：勿对正常长回复全文调用——调用侧保证只传新回复短文本（<400 字符）。 */
function detectLimit(bodyText) {
  const t = String(bodyText || '');
  for (const kind of ['length', 'quota', 'captcha']) {
    for (const re of LIMIT_PATTERNS[kind]) {
      if (re.test(t)) return { kind, matched: String(re).slice(0, 60) };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* tool-call parser (ported from deepseek-browser-agent)               */
/* ------------------------------------------------------------------ */
/** 剥离思考块（<think>…</think> 与 "Thinking…" 前缀）——解析工具调用前必须先清理。 */
function stripThinkingBlocks(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
    .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
    .trim();
}

/** JSON 容错修复解析：移除尾逗号、补未加引号的 key 后再 parse，失败返回 null。 */
function attemptJsonFix(str) {
  try {
    const fixed = String(str)
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  } catch (e) { return null; }
}

/** 提取文本中最长的合法 JSON 对象（平衡括号扫描，正确处理字符串内 {}/转义）。
 * 直接 parse 失败时尝试 attemptJsonFix 修复。供"纯参数无 name"场景兜底。 */
function extractLargestJsonObject(text) {
  let best = null;
  let bestLen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (candidate.length > bestLen) {
            try { const parsed = JSON.parse(candidate); best = parsed; bestLen = candidate.length; }
            catch (e) { const fixed = attemptJsonFix(candidate); if (fixed && candidate.length > bestLen) { best = fixed; bestLen = candidate.length; } }
          }
          break;
        }
      }
    }
  }
  return best;
}

/** 从助手回复解析单次工具调用（任务模式用）：按优先级尝试
 * tool_call 前缀 / ```json 代码块 / <tool_call> 标签 / 最大 JSON 对象兜底，
 * 兼容 name/tool/function 与 args/arguments/parameters/input 多种键名。 */
function parseResponse(rawText) {
  const text = stripThinkingBlocks(rawText).trim();
  const mk = (name, args) => ({ type: 'tool_call', name, args, raw: rawText });
  const bare = text.match(/^tool_call\s*\n([\s\S]+)$/i);
  if (bare) {
    try {
      const parsed = JSON.parse(bare[1].trim());
      const name = parsed.name || parsed.tool || parsed.function;
      const args = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') return mk(name, args);
    } catch (e) {
      const fixed = attemptJsonFix(bare[1]);
      if (fixed && (fixed.name || fixed.tool || fixed.function)) return mk(fixed.name || fixed.tool || fixed.function, fixed.args || fixed.arguments || fixed.parameters || fixed.input || {});
    }
  }
  const fenced = text.match(/```tool_call\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      const name = parsed.name || parsed.tool || parsed.function;
      const args = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') return mk(name, args);
    } catch (e) {
      const fixed = attemptJsonFix(fenced[1]);
      if (fixed && (fixed.name || fixed.tool || fixed.function)) return mk(fixed.name || fixed.tool || fixed.function, fixed.args || fixed.arguments || fixed.parameters || fixed.input || {});
      return { type: 'error', message: 'tool_call invalid JSON: ' + e.message, raw: rawText };
    }
  }
  const jsonFence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonFence) {
    try {
      const parsed = JSON.parse(jsonFence[1]);
      const name = parsed.name || parsed.tool || parsed.function;
      const args = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') return mk(name, args);
    } catch (e) { /* fall through */ }
  }
  const xml = text.match(/<tool_call[^>]*>\s*(?:<name>([\s\S]*?)<\/name>\s*)?(?:<input>([\s\S]*?)<\/input>|<args>([\s\S]*?)<\/args>)\s*<\/tool_call>/i);
  if (xml) {
    const name = (xml[1] || '').trim();
    const inputRaw = stripCodeFences((xml[2] || xml[3] || '').trim());
    if (name) {
      try { return mk(name, JSON.parse(inputRaw)); }
      catch (e) { const fixed = attemptJsonFix(inputRaw); if (fixed) return mk(name, fixed); }
    }
  }
  if (/["'](?:name|tool|function)["']\s*:\s*["'][\w_]+["']/.test(text)) {
    const obj = extractLargestJsonObject(text);
    if (obj) {
      const name = obj.name || obj.tool || obj.function;
      const args = obj.args || obj.arguments || obj.parameters || obj.input || {};
      if (name && typeof name === 'string') return mk(name, args);
    }
  }
  return { type: 'final', content: text, raw: rawText };
}

function stripCodeFences(str) {
  return String(str).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/* ------------------------------------------------------------------ */
/* tools (cross-platform port of deepseek-browser-agent tools)         */
/* ------------------------------------------------------------------ */
function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  const m = max || CFG.maxOutputLength;
  if (s.length <= m) return s;
  const half = Math.floor(m / 2);
  return s.slice(0, half) + '\n\n\u26a0 [OUTPUT TRUNCATED - ' + s.length.toLocaleString() + ' chars total, showing first & last ' + half + ' chars]\n\n' + s.slice(-half);
}

function resolvePath(p, base) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(base || '.', p);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.dsh', '.dsweb']);
function walkDir(dir, depth, maxEntries, showHidden, cb) {
  let count = 0;
  function walk(d, dep) {
    if (count >= maxEntries) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (count >= maxEntries) return;
      if (!showHidden && ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        cb(full, true);
        count++;
        if (dep < depth) walk(full, dep + 1);
      } else {
        cb(full, false);
        count++;
      }
    }
  }
  walk(dir, 0);
  return count;
}

const TOOLS = {
  read_file: {
    description: 'Read the full contents of a file. Optionally read specific line ranges.',
    parameters: { path: 'string (REQUIRED): path to the file', start_line: 'number (optional): first line (1-indexed)', end_line: 'number (optional): last line (inclusive)' },
    async execute(args, base) {
      const abs = resolvePath(args.path, base);
      if (!fs.existsSync(abs)) throw new Error('File not found: ' + args.path);
      if (fs.statSync(abs).isDirectory()) throw new Error(args.path + ' is a directory');
      let content = fs.readFileSync(abs, 'utf8');
      if (args.start_line != null || args.end_line != null) {
        const lines = content.split('\n');
        const s = Math.max(0, (args.start_line || 1) - 1);
        const e = args.end_line != null ? args.end_line : lines.length;
        return '[' + args.path + ' | lines ' + (s + 1) + '-' + e + ']\n' + truncate(lines.slice(s, e).map((l, i) => (s + i + 1) + ': ' + l).join('\n'));
      }
      const lineCount = content.split('\n').length;
      if (lineCount <= 300) return '[' + args.path + ' | ' + lineCount + ' lines]\n' + content.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
      return '[' + args.path + ' | ' + lineCount + ' lines - use start_line/end_line to read sections]\n' + truncate(content);
    },
  },
  write_file: {
    description: 'Write (create or overwrite) a file with given content. Creates parent directories automatically.',
    parameters: { path: 'string (REQUIRED): destination file path', content: 'string (REQUIRED): full file content' },
    async execute(args, base) {
      const abs = resolvePath(args.path, base);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content, 'utf8');
      return '\u2713 Wrote ' + formatBytes(Buffer.byteLength(args.content, 'utf8')) + ' (' + args.content.split('\n').length + ' lines) -> ' + args.path;
    },
  },
  append_to_file: {
    description: 'Append text to the end of an existing file (or create it if missing).',
    parameters: { path: 'string (REQUIRED): file path', content: 'string (REQUIRED): text to append' },
    async execute(args, base) {
      const abs = resolvePath(args.path, base);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, args.content, 'utf8');
      return '\u2713 Appended ' + formatBytes(Buffer.byteLength(args.content, 'utf8')) + ' to ' + args.path;
    },
  },
  replace_in_file: {
    description: 'Find and replace text in a file. Supports regex patterns.',
    parameters: { path: 'string (REQUIRED): file path', find: 'string (REQUIRED): text to find', replace: 'string (REQUIRED): replacement text', use_regex: 'boolean (optional): treat find as regex (default false)', all_occurrences: 'boolean (optional): replace all (default true)' },
    async execute(args, base) {
      const abs = resolvePath(args.path, base);
      const original = fs.readFileSync(abs, 'utf8');
      let content = original;
      const all = args.all_occurrences !== false;
      if (args.use_regex) content = content.replace(new RegExp(args.find, all ? 'g' : ''), args.replace);
      else if (all) content = content.split(args.find).join(args.replace);
      else content = content.replace(args.find, args.replace);
      if (content === original) return '\u26a0 No matches found for "' + args.find + '" in ' + args.path;
      const re = new RegExp(args.use_regex ? args.find : args.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const count = (original.match(re) || []).length;
      fs.writeFileSync(abs, content, 'utf8');
      return '\u2713 Replaced ' + count + ' occurrence(s) of "' + args.find + '" in ' + args.path;
    },
  },
  delete_file: {
    description: 'Permanently delete a file.',
    parameters: { path: 'string (REQUIRED): file to delete' },
    async execute(args, base) {
      const abs = resolvePath(args.path, base);
      if (!fs.existsSync(abs)) throw new Error('File not found: ' + args.path);
      fs.unlinkSync(abs);
      return '\u2713 Deleted ' + args.path;
    },
  },
  list_directory: {
    description: 'List files and folders in a directory, optionally recursive.',
    parameters: { path: 'string (optional): directory (default working dir)', recursive: 'boolean (optional)', show_hidden: 'boolean (optional)' },
    async execute(args, base) {
      const abs = resolvePath(args.path || '.', base);
      if (!fs.existsSync(abs)) throw new Error('Directory not found: ' + args.path);
      if (!fs.statSync(abs).isDirectory()) throw new Error(args.path + ' is not a directory');
      if (args.recursive) {
        const out = [];
        walkDir(abs, 4, 300, !!args.show_hidden, (f, isDir) => out.push((isDir ? '[d] ' : '    ') + path.relative(base || '.', f)));
        return out.join('\n') || '(empty)';
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => args.show_hidden || !e.name.startsWith('.'));
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      if (!entries.length) return '(empty directory: ' + args.path + ')';
      const lines = entries.map((e) => {
        if (e.isDirectory()) return '\ud83d\udcc1  ' + e.name + '/';
        try { return '\ud83d\udcc4  ' + e.name + '  ' + formatBytes(fs.statSync(path.join(abs, e.name)).size); }
        catch (err) { return '\ud83d\udcc4  ' + e.name; }
      });
      return '[' + args.path + '] - ' + entries.length + ' items\n' + lines.join('\n');
    },
  },
  create_directory: {
    description: 'Create a directory (and all necessary parent directories).',
    parameters: { path: 'string (REQUIRED): directory path to create' },
    async execute(args, base) {
      fs.mkdirSync(resolvePath(args.path, base), { recursive: true });
      return '\u2713 Created directory: ' + args.path;
    },
  },
  move_file: {
    description: 'Move or rename a file or directory.',
    parameters: { source: 'string (REQUIRED): source path', destination: 'string (REQUIRED): destination path' },
    async execute(args, base) {
      const src = resolvePath(args.source, base);
      const dest = resolvePath(args.destination, base);
      if (!fs.existsSync(src)) throw new Error('Source not found: ' + args.source);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      return '\u2713 Moved: ' + args.source + ' -> ' + args.destination;
    },
  },
  copy_file: {
    description: 'Copy a file to a new location.',
    parameters: { source: 'string (REQUIRED): source file path', destination: 'string (REQUIRED): destination file path' },
    async execute(args, base) {
      const src = resolvePath(args.source, base);
      const dest = resolvePath(args.destination, base);
      if (!fs.existsSync(src)) throw new Error('Source not found: ' + args.source);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return '\u2713 Copied: ' + args.source + ' -> ' + args.destination;
    },
  },
  get_file_info: {
    description: 'Get metadata about a file or directory (size, modified date, line count, etc.).',
    parameters: { path: 'string (REQUIRED): file or directory path' },
    async execute(args, base) {
      const abs = resolvePath(args.path, base);
      if (!fs.existsSync(abs)) throw new Error('Not found: ' + args.path);
      const stat = fs.statSync(abs);
      const info = { path: abs, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, size_human: formatBytes(stat.size), modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() };
      if (stat.isFile()) { info.lines = fs.readFileSync(abs, 'utf8').split('\n').length; info.encoding = 'utf-8'; }
      return JSON.stringify(info, null, 2);
    },
  },
  run_command: {
    description: 'Execute a shell command and return its output. Runs in the working directory by default. On Windows, cmd-compatible commands are expected (use powershell -Command "..." for PowerShell).',
    parameters: { command: 'string (REQUIRED): shell command to run', cwd: 'string (optional): working directory', timeout: 'number (optional): timeout ms (default 60000)', env: 'object (optional): extra env vars' },
    async execute(args, base) {
      const workDir = args.cwd ? resolvePath(args.cwd, base) : base;
      try {
        const output = execSync(args.command, {
          cwd: workDir, encoding: 'utf8', timeout: args.timeout || 60000,
          maxBuffer: 20 * 1024 * 1024,
          env: Object.assign({}, process.env, args.env || {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return truncate((output || '').trim() || '(command completed with no output)');
      } catch (err) {
        const stdout = (err.stdout || '').trim();
        const stderr = (err.stderr || '').trim();
        const combined = [stdout && 'STDOUT:\n' + stdout, stderr && 'STDERR:\n' + stderr].filter(Boolean).join('\n\n');
        throw new Error('Command failed (exit code ' + err.status + '):\n' + truncate(combined || err.message));
      }
    },
  },
  find_files: {
    description: 'Search for files by name pattern (glob-style, e.g. "*.js", "test_*").',
    parameters: { pattern: 'string (REQUIRED): filename pattern (e.g. "*.ts")', directory: 'string (optional): directory to search', exclude: 'string (optional): substring to exclude from paths' },
    async execute(args, base) {
      const dir = resolvePath(args.directory || '.', base);
      const pat = String(args.pattern || '');
      const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
      const out = [];
      walkDir(dir, 6, 300, true, (f) => {
        if (args.exclude && f.includes(args.exclude)) return;
        if (re.test(path.basename(f))) out.push(f);
      });
      return out.slice(0, 100).join('\n') || 'No files matching "' + args.pattern + '" in ' + args.directory;
    },
  },
  search_in_files: {
    description: 'Search for text patterns inside files (like grep -r). Returns matching lines with filenames.',
    parameters: { pattern: 'string (REQUIRED): text or regex to search for', directory: 'string (optional): directory to search', file_pattern: 'string (optional): only search files matching this', case_sensitive: 'boolean (optional)', context_lines: 'number (optional): context lines around matches' },
    async execute(args, base) {
      const dir = resolvePath(args.directory || '.', base);
      let re;
      try { re = new RegExp(args.pattern, args.case_sensitive ? '' : 'i'); }
      catch (e) { throw new Error('invalid search pattern: ' + e.message); }
      const ctx = Math.max(0, args.context_lines || 2);
      const hits = [];
      walkDir(dir, 6, 400, true, (f, isDir) => {
        if (isDir) return;
        if (args.file_pattern && !f.endsWith(String(args.file_pattern).replace(/^\*/, ''))) return;
        if (hits.length >= 150) return;
        try {
          const lines = fs.readFileSync(f, 'utf8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) {
                hits.push(f + ':' + (k + 1) + ': ' + lines[k]);
              }
              hits.push('---');
              break;
            }
          }
        } catch (e) { /* skip unreadable */ }
      });
      if (!hits.length) return 'No matches found for: ' + args.pattern;
      return truncate(hits.join('\n'), 8000);
    },
  },
  read_url: {
    description: 'Fetch the text content of a URL (useful for reading documentation, APIs, etc.).',
    parameters: { url: 'string (REQUIRED): full URL (http or https)' },
    async execute(args) {
      return new Promise((resolve, reject) => {
        const u = String(args.url || '');
        const client = u.startsWith('https') ? https : http;
        const req = client.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekWebAgent/1.0)', Accept: 'text/html,text/plain,application/json' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            TOOLS.read_url.execute({ url: res.headers.location }).then(resolve).catch(reject);
            return;
          }
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            const text = data.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n\n').trim();
            resolve(truncate(text));
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('URL fetch timed out')); });
      });
    },
  },
  write_files: {
    description: 'Write multiple files at once - useful for scaffolding projects.',
    parameters: { files: 'array (REQUIRED): array of {path, content} objects' },
    async execute(args, base) {
      if (!Array.isArray(args.files)) throw new Error('"files" must be an array of {path, content}');
      const results = [];
      for (const f of args.files) {
        const abs = resolvePath(f.path, base);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(f.content == null ? '' : f.content), 'utf8');
        results.push('\u2713 ' + f.path);
      }
      return 'Wrote ' + results.length + ' files:\n' + results.join('\n');
    },
  },
};

function getToolDescriptions() {
  return Object.keys(TOOLS).map((name) => {
    const t = TOOLS[name];
    const params = Object.keys(t.parameters).map((p) => '    - ' + p + ': ' + t.parameters[p]).join('\n');
    return '### ' + name + '\n  ' + t.description + '\n  Parameters:\n' + params;
  }).join('\n\n');
}

async function executeTool(name, args, base, policy) {
  const tool = TOOLS[name];
  if (!tool) throw new Error('Unknown tool: "' + name + '". Available: ' + Object.keys(TOOLS).join(', '));
  if (policy) {
    if (policy.allowed && !policy.allowed.includes(name)) throw new Error('Tool "' + name + '" is disabled for this task.');
    if (policy.denied && policy.denied.includes(name)) throw new Error('Tool "' + name + '" is disabled by task policy.');
  }
  return await tool.execute(args || {}, base);
}

/* ------------------------------------------------------------------ */
/* system prompt + working-dir snapshot                               */
/* ------------------------------------------------------------------ */
function buildSystemPrompt(task) {
  const now = new Date().toISOString();
  return [
    'You are DeepSeek Web Agent - an autonomous AI coding agent running through the DeepSeek web chat.',
    'You have direct access to the filesystem and can execute shell commands.',
    '',
    'ENVIRONMENT',
    'Platform        : ' + process.platform + ' ' + os.release(),
    'Node.js         : ' + process.version,
    'Date/Time       : ' + now,
    'Working Directory: ' + task.workingDir,
    '',
    'HOW TO CALL TOOLS',
    'Your ENTIRE response must be ONLY a fenced code block tagged "tool_call" with NO text before or after:',
    '```tool_call',
    '{ "name": "TOOL_NAME", "args": { "param": "value" } }',
    '```',
    '',
    'CRITICAL RULES:',
    '- Output ONLY the tool_call block - no prose, no greeting.',
    '- ONE tool call per response. Never multiple.',
    '- Content must be valid JSON with exactly "name" and "args" keys.',
    '- After receiving a tool result, call another tool OR give your final prose response.',
    '- Write plain prose (no code block) only when the task is 100% complete.',
    '',
    'WHEN TO STOP',
    'When fully done, respond with a clear natural-language summary. Do NOT wrap it in tags or code blocks.',
    '',
    'CODING GUIDELINES',
    '- Always read existing files before modifying them.',
    '- Always check the directory structure before creating files.',
    '- Write complete, production-quality code - no TODOs, no placeholders.',
    '- After writing code, run it (if applicable) to verify it works.',
    '- Keep tool results and file content as small as possible to conserve context.',
    '',
    'CONTEXT MIGRATION (IMPORTANT)',
    '- The web chat limits message count and context length. The harness automatically compacts history',
    '  and migrates to a new chat when limits approach. If you see a "[CONTEXT DIGEST]" message, it',
    '  contains compressed prior history - continue working normally on the original task.',
    '- Do not repeat the whole task in every message. Only state what is new.',
    '',
    'AVAILABLE TOOLS',
    getToolDescriptions(),
    '',
    'Remember: you are running autonomously. Be thorough, be precise, and complete the task fully.',
  ].join('\n');
}

function buildAskPrompt(task) {
  return [
    'You are answering a single question through the DeepSeek web chat.',
    'Answer directly, concisely, and completely. Reply in the same language as the question.',
    'Do NOT use any special formatting or code-block protocols.',
    'If the question needs a file or web resource you cannot access, say so clearly.',
    'Question: ' + String(task.task),
  ].join('\n');
}

function dirListing(base) {
  const out = [];
  walkDir(base, 3, 80, false, (f, isDir) => out.push((isDir ? '[d] ' : '    ') + path.relative(base, f)));
  return out.join('\n') || '(empty directory)';
}

/* ------------------------------------------------------------------ */
/* context digest (free, deterministic compression for migration)      */
/* ------------------------------------------------------------------ */
function compactStr(s, max) {
  const str = String(s || '');
  if (str.length <= max) return str;
  const half = Math.floor(max / 2);
  return str.slice(0, half) + ' ...[' + str.length + ' chars]... ' + str.slice(-half);
}

function buildDigest(history, keepRecent, maxPerMsg) {
  const recentCount = Math.max(2, keepRecent * 2);
  const old = history.slice(0, Math.max(0, history.length - recentCount));
  const recent = history.slice(Math.max(0, history.length - recentCount));
  const lines = [];
  for (const m of old) {
    const c = String(m.content || '');
    if (m.kind === 'tool-result') {
      const head = c.split('\n')[0] || '';
      lines.push('[TOOL RESULT ' + m.tool + '] ' + head + ' (' + c.length + ' chars)');
    } else {
      lines.push('[' + (m.kind === 'user' ? 'USER' : 'ASSISTANT') + '] ' + compactStr(c, maxPerMsg));
    }
  }
  const recentLines = [];
  for (const m of recent) {
    recentLines.push('[' + (m.kind === 'user' ? 'USER' : 'ASSISTANT') + ']\n' + compactStr(m.content, maxPerMsg * 2));
  }
  return {
    digestText: lines.join('\n'),
    recentText: recentLines.join('\n\n'),
    oldCount: old.length,
    recentCount: recent.length,
  };
}

/* ------------------------------------------------------------------ */
/* task manager                                                        */
/* ------------------------------------------------------------------ */
const tasks = new Map(); // taskId -> taskState
let taskSeq = 0;
const activeCount = () => [...tasks.values()].filter((t) => t.status === 'running' || t.status === 'starting' || t.status === 'migrating' || t.status === 'rotating').length;

function taskSummary(t) {
  return {
    id: t.id,
    status: t.status,
    detail: t.detail || '',
    kind: t.kind,
    mode: t.mode,
    deepThink: t.deepThink,
    search: t.search,
    step: t.step,
    turns: t.turns,
    migrations: t.migrations,
    profile: t.profile,
    taskPreview: String(t.task || '').slice(0, 80),
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    hasResult: !!t.result,
  };
}

function setStatus(t, status, detail) {
  t.status = status;
  t.detail = detail || '';
  emitEvent('progress', { taskId: t.id, status, detail: t.detail, step: t.step, turns: t.turns, migrations: t.migrations });
  log('task', t.id, status, detail);
}

function schedule() {
  const queued = [...tasks.values()].filter((t) => t.status === 'queued');
  for (const t of queued) {
    if (activeCount() >= CFG.maxConcurrent) break;
    setStatus(t, 'starting', 'launching');
    runTask(t).catch((err) => {
      t.error = err.message;
      t.finishedAt = Date.now();
      setStatus(t, 'error', 'error: ' + err.message);
    });
  }
}

/* ------------------------------------------------------------------ */
/* per-task loop                                                       */
/* ------------------------------------------------------------------ */
async function runTask(t) {
  try {
    const started = Date.now();
    const timeoutMs = t.timeoutMs || (t.kind === 'ask' ? 300000 : 1800000);
    t.pageId = null;
    t.history = [];
    t.turns = 0;
    t.migrations = 0;
    t.charsInChat = 0;
    t.stopped = false;
    t.profile = t.profile || 'default';

    await ensurePageFor(t);
    await waitForChatInput(t.pageId, 25000);
    await newChat(t.pageId);
    const cfgReport = await applyConfig(t.pageId, t);
    for (const w of cfgReport.warnings) { t.warnings.push(w); log('task', t.id, 'warn', w); }
    if (t.images && t.images.length) {
      for (const img of t.images) {
        try { await uploadImage(t.pageId, img); t.warnings.push('image uploaded: ' + img); }
        catch (e) { t.warnings.push('image upload failed: ' + img + ' -> ' + e.message); }
      }
    }

    let first;
    if (t.kind === 'ask') {
      first = buildAskPrompt(t);
    } else {
      first = buildSystemPrompt(t) + '\n\n\u2550'.repeat(60) + '\n\nWORKING DIRECTORY CONTENTS:\n' + dirListing(t.workingDir) + '\n\nUSER TASK:\n' + String(t.task);
    }
    t.history.push({ kind: 'user', content: first });
    t.charsInChat += first.length;

    await ensurePageFor(t);
    setStatus(t, 'running', 'task started');
    await sendMessage(t.pageId, first, t);

    const maxIter = t.maxIterations || CFG.maxIterations;
    let finalText = null;

    for (let iter = 1; iter <= maxIter; iter++) {
      if (t.stopped) { setStatus(t, 'stopped', 'stopped by user'); return; }
      if (Date.now() - started > timeoutMs) { t.error = 'timeout after ' + Math.round((Date.now() - started) / 1000) + 's'; setStatus(t, 'timeout', t.error); return; }

      /* anti-limit: proactive compaction & migration before sending */
      const needsCompact = t.turns >= (t.maxTurnsPerChat || CFG.maxTurnsPerChat) || t.charsInChat >= (t.compactThresholdChars || CFG.compactThresholdChars);
      if (needsCompact && t.migrations < CFG.maxMigrations) {
        t.migrations++;
        setStatus(t, 'migrating', 'compacting context and migrating chat #' + (t.migrations + 1));
        const digest = buildDigest(t.history, 4, 500);
        await ensurePageFor(t, true);
        await newChat(t.pageId);
        const reseed = '[CONTEXT DIGEST]\n' + digest.digestText + '\n\n[RECENT EXCHANGES]\n' + digest.recentText +
          '\n\n[SYSTEM] The chat was migrated to bypass web-side limits. Continue the ORIGINAL TASK (' + String(t.task).slice(0, 200) + ') using this compressed context. Keep the same tool-call protocol.';
        t.history.push({ kind: 'user', content: reseed });
        t.charsInChat = reseed.length;
        t.turns = 0;
        await sendMessage(t.pageId, reseed, t);
        continue;
      }

      const rawResponse = await waitForResponse(t, CFG.responseTimeoutMs, CFG.stableDelayMs);
      if (t.stopped) { setStatus(t, 'stopped', 'stopped by user'); return; }

      if (!rawResponse || rawResponse.trim().length === 0) {
        await sendMessage(t.pageId, 'Please continue. If you are waiting for input, proceed with your best judgement.', t);
        continue;
      }

      /* post-response limit check (hard limits surfaced by the site) */
      let bodyTail = '';
      try { bodyTail = await evalJs(t.pageId, EXPR.bodyTail); } catch (e) { /* ignore */ }
      const limit = detectLimit(bodyTail);
      if (limit) {
        log('task', t.id, 'limit signal', limit.kind, limit.matched);
        t.warnings.push('limit signal: ' + limit.kind + ' (' + limit.matched + ')');
        if (limit.kind === 'captcha') {
          t.error = 'captcha/verification detected on chat.deepseek.com - manual intervention required (open the browser window and solve it).';
          setStatus(t, 'error', t.error);
          return;
        }
        if (limit.kind === 'length') {
          if (t.migrations < CFG.maxMigrations) {
            t.migrations++;
            setStatus(t, 'migrating', 'length limit hit - compacting and migrating');
            const digest = buildDigest(t.history.concat([{ kind: 'assistant', content: rawResponse }]), 4, 500);
            await ensurePageFor(t, true);
            await newChat(t.pageId);
            const reseed = '[CONTEXT DIGEST]\n' + digest.digestText + '\n\n[RECENT EXCHANGES]\n' + digest.recentText +
              '\n\n[SYSTEM] The chat hit the length limit and was migrated. Continue the ORIGINAL TASK (' + String(t.task).slice(0, 200) + '). Keep the tool-call protocol.';
            t.history.push({ kind: 'user', content: reseed });
            t.charsInChat = reseed.length;
            t.turns = 0;
            await sendMessage(t.pageId, reseed, t);
            continue;
          }
          t.error = 'length limit hit and max migrations reached - task cannot continue in one session.';
          setStatus(t, 'error', t.error);
          return;
        }
        if (limit.kind === 'quota') {
          const handled = await handleQuota(t, rawResponse);
          if (!handled) return; /* task ended (error/stopped) */
          continue;
        }
      }

      t.history.push({ kind: 'assistant', content: rawResponse });
      t.turns++;
      t.charsInChat += rawResponse.length;
      t.step = iter;

      const parsed = parseResponse(rawResponse);

      if (parsed.type === 'tool_call') {
        if (t.kind === 'ask') {
          const correction = '[SYSTEM] Tools are disabled for this question. Please answer directly in plain text with no code-block markup.';
          t.history.push({ kind: 'tool-result', tool: 'SYSTEM', content: correction });
          await sendMessage(t.pageId, correction, t);
          continue;
        }
        emitEvent('log', { taskId: t.id, level: 'tool', tool: parsed.name, args: parsed.args, step: iter });
        setStatus(t, 'running', 'tool: ' + parsed.name);
        let result, isError = false;
        try {
          result = await executeTool(parsed.name, parsed.args, t.workingDir, t.policy);
          log('task', t.id, 'tool ok', parsed.name);
        } catch (err) {
          result = 'Error: ' + err.message;
          isError = true;
          log('task', t.id, 'tool error', parsed.name, err.message);
        }
        const feedback = '[TOOL RESULT: ' + parsed.name + ' | ' + (isError ? 'ERROR' : 'SUCCESS') + ']\n' + String(result) + '\n[END TOOL RESULT]\n\nContinue with the next step, or provide your final response if the task is complete.';
        t.history.push({ kind: 'tool-result', tool: parsed.name, content: feedback });
        t.charsInChat += feedback.length;
        await sendMessage(t.pageId, feedback, t);
        continue;
      }

      if (parsed.type === 'error') {
        const recovery = '[TOOL RESULT: SYSTEM | ERROR]\nParse error: ' + parsed.message + '\n\nPlease respond with ONLY a valid ```tool_call code block (valid JSON with "name" and "args") or your final prose answer.\n[END TOOL RESULT]';
        t.history.push({ kind: 'tool-result', tool: 'SYSTEM', content: recovery });
        await sendMessage(t.pageId, recovery, t);
        continue;
      }

      /* final */
      finalText = parsed.content;
      t.result = finalText;
      t.finishedAt = Date.now();
      setStatus(t, 'done', 'completed in ' + t.turns + ' turns, ' + t.migrations + ' migrations');
      return;
    }

    if (finalText === null) {
      t.error = 'reached max iterations (' + maxIter + ') without a final answer';
      t.result = 'Task may be incomplete: ' + t.error;
      t.finishedAt = Date.now();
      setStatus(t, 'done', t.error);
    }
  } finally {
    try { if (t.pageId) await closePage(t.pageId); } catch (e) { /* ignore */ }
    t.pageId = null;
    schedule();
  }
}

async function ensurePageFor(t, forceNew) {
  if (!forceNew && t.pageId && pageInfo(t.pageId)) return;
  if (t.pageId) { try { await closePage(t.pageId); } catch (e) { /* ignore */ } }
  await ensureBrowser({ name: t.profile, headless: t.headless });
  /* visible sessions: when not headless, each task gets its own independent window */
  const vis = !effectiveHeadless({ name: t.profile, headless: t.headless });
  t.pageId = await newPage({ newWindow: vis });
  try { await navigate(t.pageId, DS_URL); } catch (e) { log('navigate failed', e.message); }
}

async function handleQuota(t, lastRaw) {
  /* account-level daily/frequency cap: rotate to another profile, else backoff-retry */
  const profiles = CFG.profiles && CFG.profiles.length ? CFG.profiles : [{ name: 'default', headless: CFG.headless }];
  const idx = profiles.findIndex((p) => p.name === t.profile);
  const next = profiles[(idx + 1) % profiles.length];
  if (profiles.length > 1 && next.name !== t.profile) {
    t.profileRotations = (t.profileRotations || 0) + 1;
    setStatus(t, 'rotating', 'quota hit - rotating to profile "' + next.name + '"');
    await closeBrowser();
    t.profile = next.name;
    t.headless = effectiveHeadless(next);
    t.migrations++;
    await ensurePageFor(t, true);
    const login = await ensureLoggedIn(t.pageId);
    if (login.needsLogin) {
      t.error = 'profile "' + next.name + '" requires login - run dsweb_login profile=' + next.name;
      setStatus(t, 'error', t.error);
      return false;
    }
    await newChat(t.pageId);
    const digest = buildDigest(t.history.concat([{ kind: 'assistant', content: lastRaw }]), 4, 500);
    const reseed = '[CONTEXT DIGEST]\n' + digest.digestText + '\n\n[RECENT EXCHANGES]\n' + digest.recentText +
      '\n\n[SYSTEM] Quota limit hit; session migrated to another account/profile. Continue the ORIGINAL TASK (' + String(t.task).slice(0, 200) + '). Keep the tool-call protocol.';
    t.history.push({ kind: 'user', content: reseed });
    t.charsInChat = reseed.length;
    t.turns = 0;
    await sendMessage(t.pageId, reseed, t);
    return true;
  }
  /* single profile: backoff retry */
  const retries = t.quotaRetries || 0;
  if (retries < CFG.maxQuotaBackoffRetries) {
    t.quotaRetries = retries + 1;
    setStatus(t, 'migrating', 'rate limited - backing off 60s (retry ' + t.quotaRetries + '/' + CFG.maxQuotaBackoffRetries + ')');
    await sleep(60000);
    await ensurePageFor(t, true);
    await newChat(t.pageId);
    const digest = buildDigest(t.history.concat([{ kind: 'assistant', content: lastRaw }]), 4, 500);
    const reseed = '[CONTEXT DIGEST]\n' + digest.digestText + '\n\n[RECENT EXCHANGES]\n' + digest.recentText +
      '\n\n[SYSTEM] Rate limit hit; continue the ORIGINAL TASK (' + String(t.task).slice(0, 200) + '). Keep the tool-call protocol.';
    t.history.push({ kind: 'user', content: reseed });
    t.charsInChat = reseed.length;
    t.turns = 0;
    await sendMessage(t.pageId, reseed, t);
    return true;
  }
  t.error = 'daily quota exhausted on all profiles. The free web tier caps message counts; add more profiles (multi-account rotation) or wait for reset.';
  setStatus(t, 'error', t.error);
  return false;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* standalone window (always-visible browser for the dashboard page)  */
/* ------------------------------------------------------------------ */
const dwindow = { proc: null, cdp: null, ws: null, launching: null };

async function closeDashWindow() {
  const proc = dwindow.proc;
  dwindow.proc = null;
  dwindow.cdp = null;
  dwindow.ws = null;
  dwindow.launching = null;
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /pid ' + proc.pid + ' /T /F', { stdio: 'ignore', timeout: 10000 });
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) {
      try { proc.kill(); } catch (e2) { /* ignore */ }
    }
  }
  await sleep(500);
}

async function openWindowSafe(url) {
  if (dwindow.launching) await dwindow.launching.catch(() => {});
  /* reuse an already-open dashboard window instead of killing + relaunching */
  const proc = dwindow.proc;
  if (proc && proc.exitCode === null && !proc.killed) {
    log('reusing standalone window', String(url));
    return { ok: true, reused: true };
  }
  const launch = (async () => {
    await closeDashWindow();
    const chrome = findChrome();
    if (!chrome) throw new Error('Chrome/Edge not found. Set DS_WEB_CHROME or install Chrome/Edge.');
    const dir = path.join(CFG.baseDir, 'profiles', 'dashboard');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        const fp = path.join(dir, f);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch (e) { /* ignore */ }
    }
    const args = [
      chrome,
      '--user-data-dir=' + dir,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-features=Translate,OptimizationHints,msEdgeSidebarV2',
      '--window-size=1200,900',
      String(url),
    ];
    log('launching standalone window', String(url));
    const proc = spawn(args[0], args.slice(1), { stdio: 'ignore' });
    dwindow.proc = proc;
    proc.on('error', (e) => { logErr('standalone spawn error', e.message); });
    proc.on('exit', () => {
      dwindow.proc = null;
      dwindow.cdp = null;
      dwindow.ws = null;
      dwindow.launching = null;
    });
    const portFile = path.join(dir, 'DevToolsActivePort');
    const content = await waitForFile(portFile, 25000);
    const lines = content ? content.split(/\r?\n/).filter((x) => x.trim().length > 0) : [];
    const port = parseInt(lines[0], 10);
    if (!content || !port) throw new Error('standalone window did not expose DevTools port');
    const wsPath = lines[1] || '/devtools/browser/' + crypto.randomUUID();
    const ws = await wsConnect('ws://127.0.0.1:' + port + wsPath, 15000);
    dwindow.cdp = new CdpClient(ws);
    dwindow.ws = ws;
  })();
  dwindow.launching = launch;
  try { await launch; } finally { dwindow.launching = null; }
  return { ok: true };
}

/* RPC handlers                                                        */
/* ------------------------------------------------------------------ */
handlers.ping = async () => ({ pong: true, version: VERSION, ts: Date.now() });

handlers.health = async () => ({
  version: VERSION,
  browser: { running: !!browser.proc, profile: browser.profile ? browser.profile.name : null, pages: browser.pages.size },
  tasks: [...tasks.values()].map(taskSummary),
  config: { headless: CFG.headless, maxConcurrent: CFG.maxConcurrent, maxTurnsPerChat: CFG.maxTurnsPerChat, compactThresholdChars: CFG.compactThresholdChars, profiles: CFG.profiles },
});

handlers.config = async (params) => {
  if (params && params.config) {
    const c = params.config;
    if (c.headless !== undefined) CFG.headless = !!c.headless;
    if (c.maxConcurrent !== undefined) CFG.maxConcurrent = Math.max(1, Math.min(10, parseInt(c.maxConcurrent, 10) || 1));
    if (c.maxTurnsPerChat !== undefined) CFG.maxTurnsPerChat = Math.max(2, parseInt(c.maxTurnsPerChat, 10) || 30);
    if (c.compactThresholdChars !== undefined) CFG.compactThresholdChars = Math.max(1000, parseInt(c.compactThresholdChars, 10) || 60000);
    if (c.maxOutputLength !== undefined) CFG.maxOutputLength = parseInt(c.maxOutputLength, 10) || 8000;
    if (c.responseTimeoutMs !== undefined) CFG.responseTimeoutMs = parseInt(c.responseTimeoutMs, 10) || 240000;
    if (c.stableDelayMs !== undefined) CFG.stableDelayMs = parseInt(c.stableDelayMs, 10) || 2500;
    if (c.sendDelayMs !== undefined) CFG.sendDelayMs = parseInt(c.sendDelayMs, 10) || 400;
    if (c.maxIterations !== undefined) CFG.maxIterations = parseInt(c.maxIterations, 10) || 40;
    if (c.maxMigrations !== undefined) CFG.maxMigrations = parseInt(c.maxMigrations, 10) || 24;
    if (c.maxQuotaBackoffRetries !== undefined) CFG.maxQuotaBackoffRetries = parseInt(c.maxQuotaBackoffRetries, 10) || 3;
    if (c.chromePath !== undefined) CFG.chromePath = String(c.chromePath || '');
    if (Array.isArray(c.profiles) && c.profiles.length) {
      CFG.profiles = c.profiles.map((p, i) => ({ name: String(p.name || 'profile' + (i + 1)), headless: p.headless !== undefined ? !!p.headless : CFG.headless }));
    }
  }
  return { config: { headless: CFG.headless, maxConcurrent: CFG.maxConcurrent, maxTurnsPerChat: CFG.maxTurnsPerChat, compactThresholdChars: CFG.compactThresholdChars, maxOutputLength: CFG.maxOutputLength, responseTimeoutMs: CFG.responseTimeoutMs, stableDelayMs: CFG.stableDelayMs, sendDelayMs: CFG.sendDelayMs, maxIterations: CFG.maxIterations, maxMigrations: CFG.maxMigrations, maxQuotaBackoffRetries: CFG.maxQuotaBackoffRetries, chromePath: CFG.chromePath, profiles: CFG.profiles, baseDir: CFG.baseDir } };
};

const WRITE_TOOLS = ['write_file', 'append_to_file', 'replace_in_file', 'delete_file', 'move_file', 'copy_file', 'create_directory', 'write_files'];

function makeTask(params) {
  const task = params || {};
  const id = 't' + (++taskSeq);
  const denied = [];
  if (task.allowShell === false) denied.push('run_command');
  if (task.allowFileWrite === false) denied.push(...WRITE_TOOLS);
  return {
    id,
    task: String(task.task || ''),
    kind: task.kind === 'ask' ? 'ask' : 'run',
    mode: ['quick', 'expert', 'vision'].includes(task.mode) ? task.mode : 'quick',
    deepThink: !!task.deepThink,
    search: !!task.search,
    images: Array.isArray(task.images) ? task.images : [],
    workingDir: task.workingDir || CFG.baseDir,
    maxIterations: task.maxIterations ? parseInt(task.maxIterations, 10) : (task.kind === 'ask' ? 2 : CFG.maxIterations),
    maxTurnsPerChat: task.maxTurnsPerChat ? parseInt(task.maxTurnsPerChat, 10) : CFG.maxTurnsPerChat,
    compactThresholdChars: task.compactThresholdChars ? parseInt(task.compactThresholdChars, 10) : CFG.compactThresholdChars,
    timeoutMs: task.timeoutMs ? parseInt(task.timeoutMs, 10) : null,
    profile: task.profile || 'default',
    headless: task.headless !== undefined ? !!task.headless : CFG.headless,
    policy: { allowed: task.allowTools === false || task.kind === 'ask' ? [] : null, denied },
    status: 'queued',
    detail: 'queued',
    step: 0,
    turns: 0,
    migrations: 0,
    warnings: [],
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    stopped: false,
  };
}

handlers.start = async (params) => {
  const task = params || {};
  if (!task.task || !String(task.task).trim()) throw new Error('task text is required');
  const t = makeTask(task);
  tasks.set(t.id, t);
  emitEvent('progress', { taskId: t.id, status: 'queued', detail: 'queued', step: 0 });
  schedule();
  return { taskId: t.id, status: t.status };
};

handlers.status = async () => {
  const list = [...tasks.values()].map(taskSummary).sort((a, b) => a.startedAt - b.startedAt);
  return {
    version: VERSION,
    browser: { running: !!browser.proc, profile: browser.profile ? browser.profile.name : null, pages: browser.pages.size, headless: browser.profile ? effectiveHeadless(browser.profile) : CFG.headless },
    tasks: list,
    config: { maxConcurrent: CFG.maxConcurrent, profiles: CFG.profiles },
  };
};

handlers.result = async (params) => {
  const t = tasks.get(params.taskId);
  if (!t) throw new Error('unknown task: ' + params.taskId);
  return {
    taskId: t.id,
    status: t.status,
    detail: t.detail,
    result: t.result,
    error: t.error,
    turns: t.turns,
    migrations: t.migrations,
    profileRotations: t.profileRotations || 0,
    warnings: t.warnings,
    step: t.step,
  };
};

handlers.wait = async (params) => {
  const t = tasks.get(params.taskId);
  if (!t) throw new Error('unknown task: ' + params.taskId);
  const timeoutMs = Math.max(1000, parseInt(params.timeoutMs, 10) || 300000);
  const terminal = ['done', 'error', 'stopped', 'timeout'];
  const start = Date.now();
  for (;;) {
    if (terminal.includes(t.status)) return await handlers.result({ taskId: t.id });
    if (Date.now() - start > timeoutMs) {
      return Object.assign(await handlers.result({ taskId: t.id }), { waitTimedOut: true });
    }
    if (t.stopped) return await handlers.result({ taskId: t.id });
    await sleep(1000);
  }
};

handlers.openWindow = async (params) => {
  const url = params && params.url;
  if (!url) return { ok: false, message: 'url required' };
  if (params && params.profile === 'task') {
    /* open a new window inside the task browser (shares login cookies) */
    await ensureBrowser(browser.profile || CFG.profiles[0]);
    const t = await browser.cdp.call('Target.createTarget', { url: String(url), newWindow: true });
    return { ok: true, window: 'task', targetId: t && t.targetId };
  }
  return openWindowSafe(String(url));
};

handlers.stop = async (params) => {
  const t = tasks.get(params.taskId);
  if (!t) return { stopped: false, message: 'unknown task' };
  t.stopped = true;
  setStatus(t, 'stopped', 'stop requested');
  return { stopped: true, taskId: t.id };
};

/** 打开有头登录窗口并轮询等待用户完成登录（不存密码，D4 决策）：
 * 2s 轮询 loginState，期间推送 login-progress 事件；超时（默认 5min）返回未完成。
 * @param {object} params { profile, timeoutMs } */
handlers.login = async (params) => {
  const providerId = (params && params.providerId) || 'deepseek';
  const profileName = profileKey(providerId, params && params.profile);
  const timeoutMs = (params && params.timeoutMs) || 300000;
  /* 单页常驻：登录与发消息用同一页面（对照 deepseek-browser-agent 的 _ensureLoggedIn：
   * 打开页面 → 检测未登录 → 用户在同一窗口手动登录 → 自动轮询直到登录成功）。 */
  const pageId = await ensurePage({ name: profileName, headless: false }, providerId);
  try { await navigate(pageId, providerUrl(providerId)); } catch (e) { log('login navigate failed', e.message); }
  const start = Date.now();
  for (;;) {
    const st = await ensureLoggedIn(pageId, providerId);
    if (st.challenge) return { ok: false, loggedIn: false, errorKind: 'challenge_required', url: st.url, message: 'provider challenge required' };
    if (!st.needsLogin && st.hasChatInput) {
      return { ok: true, loggedIn: true, url: st.url, message: 'logged in on profile "' + profileName + '"' };
    }
    if (Date.now() - start > timeoutMs) {
      return { ok: false, loggedIn: false, url: st.url, message: 'still not logged in after ' + Math.round(timeoutMs / 1000) + 's - complete login in the opened browser window' };
    }
    emitEvent('login-progress', { profile: profileName, url: st.url, needsLogin: st.needsLogin, elapsedMs: Date.now() - start });
    await sleep(2000);
  }
};

handlers.inspect = async (params) => {
  const providerId = (params && params.providerId) || 'deepseek';
  const adapter = resolveProviderAdapter(providerId);
  const taskPage = params && params.taskId ? (tasks.get(params.taskId) || {}).pageId : null;
  const requestedProfile = profileKey(adapter.id, params && params.profile);
  /* Dashboard/health refreshes must be observational only. Switching a single
   * browser between provider profiles aborts active web streams, so a passive
   * inspect reports inactive state rather than launching/restarting Chrome. */
  const passive = !!(params && params.passive) || streamActive > 0;
  const inspectHeadless = params && params.headless !== undefined ? !!params.headless : false;
  let pid = taskPage;
  if (!pid && passive) {
    const activePage = thePage && pageInfo(thePage) ? thePage : [...browser.pages.keys()][0];
    if (!browser.profile || browser.profile.name !== requestedProfile || !activePage) {
      return {
        providerId: adapter.id,
        dom: { url: providerUrl(adapter.id), providerId: adapter.id },
        buttons: [],
        login: { needsLogin: false, hasChatInput: false, challenge: false, profileInactive: true, url: providerUrl(adapter.id) },
        modelBadge: { text: '', tag: '' },
        channels: [...channels.keys()],
        freePages: subPages.length,
        lastStreamSummary,
      };
    }
    pid = activePage;
  } else if (!pid) {
    /* An explicit login-status check uses the same headed/headless mode as actual
     * DSH requests, avoiding a mismatched browser presentation. */
    pid = await ensurePage({ name: requestedProfile, headless: inspectHeadless }, adapter.id);
  }
  const info = adapter.id === 'deepseek' ? await evalJs(pid, EXPR.domDebug) : { url: providerUrl(adapter.id), providerId: adapter.id };
  const buttons = adapter.id === 'deepseek' ? await evalJs(pid, EXPR.buttons) : [];
  const login = await ensureLoggedIn(pid, adapter.id);
  const badge = adapter.id === 'deepseek' ? await evalJs(pid, EXPR.modelBadge) : { text: '', tag: '' };
  return { providerId: adapter.id, dom: info, buttons: buttons.slice(0, 60), login, modelBadge: badge, channels: [...channels.keys()], freePages: subPages.length, lastStreamSummary };
};

/* ------------------------------------------------------------------ */
/* streaming ask (LLM adapter feed): send one question, stream deltas  */
/* ------------------------------------------------------------------ */
const streamSeqs = { n: 0 };
const streamStates = new Map(); // streamId -> { pageId, stopped }
let lastStreamSummary = null; /* 最近一次 streamAsk 完成快照（调试/health） */

/* 单页常驻（对照 deepseek-browser-agent）：主 agent 用 thePage（连续对话、网页版历史保持）。
 * 子 agent 并发：当有请求正在处理时，新请求用独立页面（多窗口并行，会话隔离）。 */
let thePage = null;
const subPages = []; // 空闲页面池（用完归还复用；通道回收的页面也进这里）
let streamActive = 0;

/* 会话通道（并发最佳实践：会话亲和——每个逻辑会话绑定专属页面，网关按指纹分配 pageKey）。
 * channels: pageKey -> { pageId }；页面健康失败自动重建；releaseChannel 清历史归还池。 */
const channels = new Map();

function updateLastStreamSummary(info) {
  lastStreamSummary = Object.assign({
    at: Date.now(),
    streamId: null,
    profile: null,
    pageKey: null,
    pageId: null,
    attempt: 0,
    finishBy: null,
    ok: null,
    errorKind: null,
    error: null,
    genSeen: false,
    thinkStalled: false,
    thinking: false,
    searching: false,
    doneActions: false,
    toolCalls: 0,
    resultLen: 0,
    lastTextLen: 0,
    thinkLen: 0,
    dedupedLen: 0,
    lastChangeAgoMs: null,
    thinkIdleMs: null,
  }, info || {});
}

let thePageHealthFails = 0;

/** 获取/创建指定通道的页面（pageKey='main' 走 thePage 常驻逻辑）。
 * 优先复用空闲页面池（subPages），池空则新开 tab 并导航到 DeepSeek。
 * P0 单浏览器模型：目标 profile 与当前浏览器不同 → 重启浏览器切换账号（3-8s）；
 * 重启后所有旧 pageId 失效 → 清空通道/页面池（网关侧 recovery 机制会重建上下文）。 */
async function ensureChannelPage(pageKey, profile, providerId) {
  const id = resolveProviderAdapter(providerId).id;
  const siteUrl = providerUrl(id);
  const key = channelKey(id, pageKey);
  const wantProfile = (profile && profile.name) || 'default';
  if (browser.profile && browser.profile.name !== wantProfile) {
    log('profile 切换: ' + browser.profile.name + ' → ' + wantProfile + '（重启浏览器）');
    await launchBrowser({ name: wantProfile, headless: false });
    thePage = null;
    subPages.length = 0;
    channels.clear();
  }
  /* 冷启动兜底：driver 刚拉起（或 Chrome 被外部关闭）时浏览器尚未运行，
   * 必须先拉起浏览器再建通道页——否则 newPage() 抛 'browser not running'，
   * 模型访问直接失败且不弹窗（/login 走 ensurePage 所以正常）。
   * launchBrowser 内部会等待进行中的启动，天然串行化并发首请求。 */
  if (!browser.cdp || browser.cdp.closed) {
    log('ensureChannelPage: browser not running, launching profile ' + wantProfile);
    await launchBrowser(profile || { name: wantProfile, headless: false });
    thePage = null;
    subPages.length = 0;
    channels.clear();
  }
  if (pageKey === 'main' && id === 'deepseek') return ensurePage(profile || { name: 'default', headless: false }, id);
  let ch = channels.get(key);
  if (ch && pageInfo(ch.pageId)) {
    try { await evalJs(ch.pageId, '1'); return ch.pageId; } catch (e) { /* fallthrough: rebuild */ }
    try { await closePage(ch.pageId); } catch (e2) { /* ignore */ }
    channels.delete(key);
  }
  const pageId = subPages.pop() || await newPage();
  try { await navigate(pageId, siteUrl); } catch (e) { log('ensureChannelPage navigate warn', e.message); }
  try { await waitReady(pageId, 30000); } catch (e) { /* ignore */ }
  channels.set(key, { pageId, providerId: id });
  log('channel ' + key + ' ready: ' + pageId);
  return pageId;
}

/** 确保主 Agent 常驻页面（thePage）可用（任务模式用）：
 * 健康检查（evalJs('1')）失败 → 立即重建；不复用可能已损坏的页面。
 * 新建流程：开 tab → 导航 → 复核 URL 确实到达（防 about:blank 误判未登录）。 */
async function ensurePage(profile, providerId) {
  const id = resolveProviderAdapter(providerId).id;
  const siteUrl = providerUrl(id);
  if (browser.profile && profile && browser.profile.name !== profile.name) {
    await launchBrowser(profile);
    thePage = null; subPages.length = 0; channels.clear();
  }
  if (thePage && pageInfo(thePage)) {
    try {
      await evalJs(thePage, '1');
      thePageHealthFails = 0;
      return thePage;
    } catch (e) {
      thePageHealthFails++;
      log('ensurePage health check fail #' + thePageHealthFails + ', rebuilding', e.message);
      try { await closePage(thePage); } catch (e2) { /* ignore */ }
      thePage = null;
    }
  }
  thePageHealthFails = 0;
  await ensureBrowser(profile || { name: 'default', headless: false });
  thePage = await newPage();
  try { await navigate(thePage, siteUrl); } catch (e) { log('ensurePage navigate warn', e.message); }
  await sleep(3000);
  try { await waitReady(thePage, 30000); } catch (e) { /* ignore */ }
  /* 保留 DeepSeek 原有导航校验；其他 provider 由 adapter 输入框检测确认。 */
  const urlOk = id !== 'deepseek' ? true : await evalJs(thePage, `(() => {
    const u = window.location.href;
    return u.startsWith(${JSON.stringify(DS_URL)}) || u.includes('chat.deepseek.com') || u.includes('chat.deepseek');
  })()`).catch(() => false);
  if (!urlOk) {
    log('ensurePage: page not at deepseek, retrying navigation');
    try { await navigate(thePage, siteUrl); } catch (e) { log('ensurePage retry navigate warn', e.message); }
    await sleep(3000);
  }
  await sleep(1500);
  log('single page ready: ' + thePage);
  return thePage;
}

/** 在指定页面回放校准点击（打开模型面板 → 点击目标模型选项）。
 * 必须在 newChat（新会话）之后调用——DeepSeek 模型选择是会话级的，新会话会重置为默认。
 * 逐点击元素匹配（text/aria/class 三路候选 + role 优先级排序），命中即点击。
 * 2026-08 页面重构后降级为 fallback：pill 开关未找到时才走此路径。
 * @param {string} pageId 页面 ID
 * @param {string} key 校准键（如模型 ID）
 * @returns {Promise<number>} 成功回放的点击步数（0=无数据/未命中） */
async function applyCalibration(pageId, key) {
  if (!key) return 0;
  let store = {};
  try { store = JSON.parse(fs.readFileSync(CALIB_FILE(), 'utf8')); } catch (e) { return 0; }
  const clicks = store[key];
  if (!clicks || !clicks.length) return 0;
  /* 校准数据就是用户录的完整操作（如点击"专家模式"），直接回放，不额外打开面板 */
  await sleep(400);
  let applied = 0;
  for (const step of clicks) {
    const found = await evalJs(pageId, `(() => {
      const text = ${JSON.stringify(step.text || '')};
      const aria = ${JSON.stringify(step.aria || '')};
      const cls = ${JSON.stringify(step.cls || '')};
      const all = Array.from(document.querySelectorAll('*')).filter((e) => e.childElementCount < 3 && (e.textContent || '').length < 150);
      const cands = [];
      const tKey = text.slice(0, 25);
      if (tKey) cands.push(...all.filter((e) => {
        const t = (e.textContent || '').trim().replace(/\\s+/g, ' ');
        return t.indexOf(tKey) >= 0 && t.length <= 60;
      }));
      if (aria) cands.push(...all.filter((e) => (e.getAttribute('aria-label') || '') === aria));
      if (cls) { const c = cls.split(' ')[0]; if (c) cands.push(...Array.from(document.querySelectorAll('.' + CSS.escape(c)))); }
      const rank = (el) => {
        const r = el.getAttribute('role') || '';
        const tag = el.tagName.toLowerCase();
        if (r === 'radio' || r === 'option' || r === 'menuitem' || r === 'button') return 3;
        if (tag === 'label' || tag === 'li' || tag === 'a') return 2;
        return 1;
      };
      cands.sort((a, b) => rank(b) - rank(a));
      for (const el of cands) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { el.click(); return true; } }
      return false;
    })()`);
    if (found) applied++;
    await sleep(700);
  }
  return applied;
}

/**
 * 从网页版回复中解析 tool_call（提示工程输出的 JSON，工具调用协议的解析端）。
 * DeepSeek 网页版没有原生 function calling——它只输出参数 JSON（常缺 name 字段），
 * 所以除了识别带 name/function 的格式，还要按工具 schema（parameters.properties
 * 的 key）推断工具名。
 * 解析策略（优先级）：tool_call 前缀 → ```tool_call 块 → ```json 块 → 裸 ``` 块
 * → <tool_call> XML → 平衡括号提取（schema 推断）→ Python 函数格式。
 * 协议约定一轮只执行一个工具调用：命中多个候选时只保留最先出现的一个（显式
 * tool_call 标记的代码块优先），其余忽略——与提示词「一次只调用一个工具」对齐。
 * @param {string} text 助手回复原文（含思考块亦可，内部会剥离）
 * @param {Array} tools OpenAI tools 数组（schema 推断用）
 * @returns {Array<{name: string, arguments: object|string}>} 工具调用列表（空数组=非工具回复）
 */
function parseToolCalls(text, tools, options) {
  const calls = [];
  const strictProtocol = !!(options && options.protocol === 'strict');
  const t = String(text || '');
  if (!t) return calls;
  function buildParseInputs(raw) {
    const source = String(raw || '');
    const out = [source];
    const bodyMark = /(?:^|\n)\s*(?:正文|body)\s*[：:]\s*/gi;
    let m;
    let last = null;
    while ((m = bodyMark.exec(source)) !== null) last = m;
    if (last) {
      const body = source.slice(last.index + last[0].length).trim();
      if (body && body !== source) out.unshift(body);
    }
    return out;
  }
  /* 宽容 JSON 解析（参考 deepseek-browser-agent parser.js）：
   * 1) 网页版渲染 markdown 把 \\ 显示为 \（Windows 路径 \U \h 非法转义）→ 修复单反斜杠
   * 2) attemptJsonFix：修尾逗号 + 补未加引号的 key */
  function jsonParseTolerant(s) {
    try { return JSON.parse(s); } catch (e) {
      const fixed1 = String(s).replace(/\\(?![\\"/bfnrtu])/g, '\\\\');
      try { return JSON.parse(fixed1); } catch (e2) {
        const fixed2 = fixed1.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
        try { return JSON.parse(fixed2); } catch (e3) { return null; }
      }
    }
  }
  /* 参数别名：模型可能用 path/file/text/cmd 而非 schema 参数名（file_path/content/command） */
  const PARAM_ALIAS = {
    path: 'file_path', file: 'file_path', filepath: 'file_path', filename: 'file_path',
    cmd: 'command', code: 'command', script: 'command',
    text: 'content', data: 'content', body: 'content',
    queries: 'query', querys: 'query', q: 'query',
  };
  function toolSchemaByName(name) {
    if (!tools || !Array.isArray(tools) || !name) return null;
    for (const t of tools) {
      const fn = t.function || t;
      if (fn && fn.name === name) return fn;
    }
    return null;
  }
  function normalizeArgsForTool(name, argsObj) {
    if (!argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) return argsObj;
    const fn = toolSchemaByName(name);
    if (!fn) return argsObj;
    const props = (fn.parameters && fn.parameters.properties) || {};
    const propKeys = Object.keys(props);
    if (!propKeys.length) return argsObj;
    const adaptValue = (key, value) => {
      const def = props[key] || {};
      if (Array.isArray(value) && def.type !== 'array') return value.length ? value[0] : '';
      return value;
    };
    const out = {};
    for (const [k, v] of Object.entries(argsObj)) {
      if (propKeys.includes(k)) {
        out[k] = adaptValue(k, v);
        continue;
      }
      const alias = PARAM_ALIAS[k] || '';
      if (!alias || !propKeys.includes(alias) || out[alias] !== undefined) continue;
      out[alias] = adaptValue(alias, v);
    }
    /* 保留规范参数；当完全无法规范化时回退原对象（保持旧行为）。 */
    const normalized = Object.keys(out).length ? out : argsObj;
    /* 必填参数补全（提示词与解析一致性）：模型经常只给 command 而漏掉
     * description/justification 等说明型必填参数，DSH 执行端 required 校验会报
     * 'missing required property xxx' 并作为工具错误回传，对话卡死。
     * 按 schema 的 required 列表补齐缺失键（已有键绝不覆盖）：
     * - 说明型参数（description/justification/reason...）用参数描述或工具名生成说明
     * - 其余按类型默认值（string 空串 / boolean false / number 0 / array [] / object {}） */
    const req = (fn.parameters && fn.parameters.required) || [];
    if (req.length) {
      for (const k of req) {
        if (normalized[k] !== undefined) continue;
        const def = props[k] || {};
        const t = def.type || 'string';
        if (t === 'string') {
          if (/description|justification|reason|purpose|explanation|comment/i.test(k)) {
            normalized[k] = def.description ? String(def.description).slice(0, 48) : ('执行 ' + name + ' 操作（自动补充）');
          } else {
            normalized[k] = def.description ? String(def.description).slice(0, 48) : '';
          }
        } else if (t === 'boolean') normalized[k] = false;
        else if (t === 'number' || t === 'integer') normalized[k] = 0;
        else if (t === 'array') normalized[k] = [];
        else if (t === 'object') normalized[k] = {};
        else normalized[k] = '';
      }
    }
    return normalized;
  }
  function recoverInvokeXmlCalls(text) {
    const t = String(text || '');
    if (!/<tool_calls>|<invoke\b/i.test(t)) return [];
    const out = [];
    const invokeRe = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;
    let m;
    while ((m = invokeRe.exec(t)) !== null) {
      const name = String(m[1] || '').trim();
      const body = String(m[2] || '');
      if (!name) continue;
      const args = {};
      const paramRe = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
      let p;
      while ((p = paramRe.exec(body)) !== null) {
        const key = String(p[1] || '').trim();
        const raw = String(p[2] || '').trim();
        if (!key) continue;
        let val = raw;
        try {
          const parsed = jsonParseTolerant(raw);
          if (parsed !== null) val = parsed;
        } catch (e) { /* keep raw text */ }
        args[key] = val;
      }
      /* 只返回原始候选；调用方必须经 pushCall() 校验授权工具名并规范化参数。 */
      if (Object.keys(args).length) out.push({ name, arguments: args });
    }
    return out;
  }
  /* 按参数 schema 推断工具名：{"file_path": "...", "content": "..."} → write_file */
  function matchToolByParams(j) {
    if (!tools || !Array.isArray(tools) || !j || typeof j !== 'object') return null;
    const keys = Object.keys(j).filter((k) => k !== 'name' && k !== 'arguments' && k !== 'function' && k !== 'tool');
    if (!keys.length) return null;
    let best = null, bestScore = 0;
    for (const t of tools) {
      const fn = t.function || t;
      if (!fn || !fn.name) continue;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const propKeys = Object.keys(props);
      if (!propKeys.length) continue;
      let score = 0;
      let hit = 0;
      let miss = 0;
      for (const k of keys) {
        if (propKeys.includes(k)) { score += 2; hit++; }                    /* 原样命中 */
        else if (propKeys.includes(PARAM_ALIAS[k] || '')) { score += 2; hit++; }  /* 别名命中 */
        else { score -= 1.5; miss++; } /* 未知 key 惩罚，防误判 */
      }
      /* 命中率加成：参数更"专一"的工具优先（file_path 单参数 → read_image/read
       * 而非 edit/write——edit 需 old_string+new_string，write 需 content）。
       * 关键防线：
       * 1) 未知 key 多于命中 key时直接视为不匹配；
       * 2) 当输入本身带多个参数时，不允许用“只命中其中一部分”的工具硬匹配，
       *    防止 {file_path, content} 在 write 不可用时误落到只认识 file_path 的工具。 */
      if (miss > hit) continue;
      if (keys.length > 1 && miss > 0) continue;
      score += (hit / propKeys.length) * 2;
      if (hit > 0 && score > bestScore) { bestScore = score; best = fn.name; }
    }
    /* 至少 1 个参数命中才算工具调用（避免把闲聊里的 JSON 误判为工具） */
    return bestScore >= 2 ? best : null;
  }
  function matchToolByParamsStrict(j) {
    if (!tools || !Array.isArray(tools) || !j || typeof j !== 'object') return null;
    const keys = Object.keys(j).filter((k) => k !== 'name' && k !== 'arguments' && k !== 'function' && k !== 'tool');
    if (!keys.length) return null;
    let best = null, bestScore = 0, tied = false;
    for (const t of tools) {
      const fn = t.function || t;
      if (!fn || !fn.name) continue;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const propKeys = Object.keys(props);
      if (!propKeys.length) continue;
      let score = 0;
      let hit = 0;
      for (const k of keys) {
        if (propKeys.includes(k)) { score += 2; hit++; }
        else if (propKeys.includes(PARAM_ALIAS[k] || '')) { score += 2; hit++; }
        else score -= 1.5;
      }
      score += (hit / propKeys.length) * 2;
      if (hit > 0 && score > bestScore) { bestScore = score; best = fn.name; tied = false; }
      else if (hit > 0 && score === bestScore && score > 0 && best && best !== fn.name) tied = true;
    }
    if (tied) return null;
    return bestScore >= 2 ? best : null;
  }
  function recoverArgsOnlyObject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (Array.isArray(raw)) {
      if (raw.length !== 1 || !raw[0] || typeof raw[0] !== 'object' || Array.isArray(raw[0])) return null;
      return raw[0];
    }
    if (raw.tool_call && typeof raw.tool_call === 'object') {
      const tc = raw.tool_call;
      if (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments)) return tc.arguments;
      if (tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)) return tc.args;
      if (tc.parameters && typeof tc.parameters === 'object' && !Array.isArray(tc.parameters)) return tc.parameters;
      if (tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)) return tc.input;
    }
    if (raw.arguments && typeof raw.arguments === 'object' && !Array.isArray(raw.arguments) && !raw.name && !raw.tool && !(raw.function && raw.function.name)) return raw.arguments;
    if (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) && !raw.name && !raw.tool && !(raw.function && raw.function.name)) return raw.args;
    if (raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters) && !raw.name && !raw.tool && !(raw.function && raw.function.name)) return raw.parameters;
    if (raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input) && !raw.name && !raw.tool && !(raw.function && raw.function.name)) return raw.input;
    return null;
  }
  const pushCall = (raw) => {
    /* 展开 tool_call 嵌套包装：{"tool_call": {"name": ..., "arguments": {...}}} */
    let j = raw;
    if (j && j.tool_call && typeof j.tool_call === 'object') j = j.tool_call;
    if (!j || typeof j !== 'object') return calls.length > 0;
    /* name/args 容器宽容（参考实现）：name||tool||function、args||arguments||parameters||input */
    const name = String(j.name || j.tool || (j.function && j.function.name) || '');
    const rawArgs = j.arguments !== undefined ? j.arguments
      : (j.args !== undefined ? j.args
        : (j.parameters !== undefined ? j.parameters
          : (j.input !== undefined ? j.input : undefined)));
    /* 参数对象：容器可能是字符串（JSON）或对象；纯参数形态（无 name/容器）用 j 本身 */
    let argsObj = null;
    if (typeof rawArgs === 'string') {
      try { argsObj = jsonParseTolerant(rawArgs); } catch (e) { argsObj = null; }
    } else if (rawArgs && typeof rawArgs === 'object') {
      argsObj = rawArgs;
    } else if (!name) {
      argsObj = j;
    }
    if (strictProtocol) {
      const fn = toolSchemaByName(name);
      if (!fn || !argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) return false;
      const required = (fn.parameters && fn.parameters.required) || [];
      if (required.some((key) => argsObj[key] === undefined)) return false;
      calls.push({ name, arguments: JSON.stringify(argsObj) });
      return true;
    }
    /* 工具名优先级：
     * 1) 模型给的 name 在工具列表里 → 直接用（可信）
     * 2) 否则用 schema 参数匹配推断（模型可能编造 name，如 write vs write_file；
     *    或纯参数形态无 name）
     * 3) 兜底（已移除）：旧实现在名字不在列表且无法按参数匹配时，仍回退用模型给的
     *    原始名字转发——这会转发网页版自带能力（如智能搜索下的 web_search）或幻觉
     *    工具名，触发 DSH 端「无效工具→报错/无结果→回传→再调」的死循环，
     *    对话永远到不了终态（表现为阻塞）。现改为：名字不在列表且无法按参数匹配
     *    到任一已授权工具 → 丢弃该调用（不转发）。后续 looksLikeToolCall 仍命中 →
     *    走安全网纠正消息，让模型改用合法工具或直接文本回答。 */
    const nameKnown = name && Array.isArray(tools) && tools.some((t) => {
      const fn = t.function || t;
      return fn && fn.name === name;
    });
    let finalName = null;
    if (nameKnown) finalName = name;
    else {
      const byParams = matchToolByParams(argsObj);
      if (byParams) finalName = byParams;
    }
    if (!finalName) {
      const recovered = recoverArgsOnlyObject(j);
      if (recovered) {
        const byRecovered = matchToolByParamsStrict(recovered);
        if (byRecovered) {
          finalName = byRecovered;
          argsObj = recovered;
        }
      }
    }
    if (finalName) {
      const normArgs = normalizeArgsForTool(finalName, argsObj || {});
      calls.push({
        name: finalName,
        arguments: typeof rawArgs === 'string' ? JSON.stringify(normArgs) : JSON.stringify(normArgs || {}),
      });
    }
    return calls.length > 0;
  };
  function parseFromText(sourceText) {
    const patterns = strictProtocol ? [
      /* Strict mode accepts only the explicit formats injected into the web prompt. */
      { re: /```tool_call\s*\n([\s\S]*?)```/gi, g: 1 },
      { re: /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, g: 1 },
    ] : [
      { re: /tool_call\s*\n?\s*(\{[\s\S]*\})/gi, g: 1 },
      /* 显式带 tool_call 标注的代码块优先于普通 json/裸代码块：
       * 同一轮输出多个块时先匹配执行带标记的那个（协议可信度最高）。 */
      { re: /```tool_call\s*\n([\s\S]*?)```/gi, g: 1 },
      { re: /```json\s*\n([\s\S]*?)```/gi, g: 1 },
      /* 无语言标注代码块（模型可能只输出 ``` 不写 json） */
      { re: /```\s*\n([\s\S]*?)```/gi, g: 1 },
      /* 逐块非贪婪：多个 <tool_call> 块时按出现顺序逐块匹配，先命中先执行；
       * 尾部必须跟闭合标签，arguments 里的内层 } 不会误截（其后无闭合标签）。 */
      { re: /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi, g: 1 },
      /* 贪婪兜底（无闭合标签/结尾处）：匹配到最后一个 }——arguments 是嵌套对象时非贪婪会在内层 } 截断 */
      { re: /<tool_call>\s*(\{[\s\S]*\})(?:\s*<\/tool_call>|\s*$)/gi, g: 1 },
    ];
    outer:
    for (const { re, g } of patterns) {
      let m;
      while ((m = re.exec(sourceText)) !== null) {
        try {
          const j = jsonParseTolerant(String(m[g] || m[0]).trim());
          if (j && typeof j === 'object') {
            if (!Array.isArray(j) && pushCall(j)) break outer;
          }
        } catch (e) { /* keep scanning */ }
      }
    }
    if (strictProtocol) return;
    if (!calls.length) {
      /* scavenger: 平衡括号提取所有完整 JSON 对象（正确处理嵌套——正则非贪婪会在内层 } 截断），
       * 从后往前扫描——有 name 的直接用，只有参数的按 schema 推断工具名 */
      const objs = extractBalancedObjects(sourceText);
      for (let i = objs.length - 1; i >= 0; i--) {
        try {
          const j = jsonParseTolerant(objs[i]);
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            if (pushCall(j)) break;
          }
        } catch (e) { /* ignore */ }
      }
    }
    if (!calls.length) {
      const xmlCalls = recoverInvokeXmlCalls(sourceText);
      for (const candidate of xmlCalls) {
        if (pushCall(candidate)) break;
      }
    }
    if (!calls.length) {
      /* 兜底：Python 风格函数调用（参考实现 Strategy 6）：```write_file(path="a.txt", content="hi")``` */
      const funcMatch = sourceText.match(/```\w*\s*([\w_]+)\(([^)]*)\)\s*```/);
      if (funcMatch) {
        const fname = funcMatch[1];
        const argsRaw = funcMatch[2];
        const args = {};
        const argRe = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b))/g;
        let m;
        while ((m = argRe.exec(argsRaw)) !== null) {
          const key = m[1];
          if (m[2] !== undefined) args[key] = m[2];
          else if (m[3] !== undefined) args[key] = m[3];
          else if (m[4] !== undefined) args[key] = parseFloat(m[4]);
          else if (m[5] !== undefined) args[key] = m[5] === 'true';
        }
        /* Python 兼容格式也必须走统一的授权与 schema 推断，不转发模型编造的函数名。 */
        if (fname && Object.keys(args).length) pushCall({ name: fname, arguments: args });
      }
    }
  }
  for (const sourceText of buildParseInputs(t)) {
    parseFromText(sourceText);
    if (calls.length) break;
  }
  /* 硬性保证只保留一个调用（防御：后续任何策略改动也不得返回多个） */
  return calls.slice(0, 1);
}

/* 提取文本中所有平衡的 JSON 对象（{...}），正确处理字符串内的 { } 与转义 */
function extractBalancedObjects(t) {
  const out = [];
  const s = String(t || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { out.push(s.slice(i, j + 1)); break; }
        }
      }
    }
  }
  return out;
}

/** Non-DeepSeek provider path. DeepSeek continues through the calibrated EXPR path below. */
async function adapterSignals(pageId, adapter) {
  const [challenge, needsLogin, limit] = await Promise.all([
    evalJs(pageId, adapter.expressions.detectChallenge).catch(() => false),
    evalJs(pageId, adapter.expressions.detectLogin).catch(() => false),
    evalJs(pageId, adapter.expressions.detectLimit).catch(() => null),
  ]);
  if (challenge) throw providerError('challenge_required', adapter.id + ' requires a browser challenge to be completed');
  if (needsLogin) throw providerError('login_required', adapter.id + ' login required');
  if (limit) throw providerError('quota', adapter.id + ' rate limited');
}

async function sendAdapterMessage(pageId, adapter, text) {
  const cdp = browser.cdp;
  const p = pageInfo(pageId);
  if (!p) throw new Error('page gone');
  const filled = await evalJs(pageId, '(' + adapter.expressions.fillPrompt + ')(' + JSON.stringify(String(text)) + ')');
  if (!filled) throw providerError('dom_unavailable', adapter.id + ' composer not found');
  await sleep(CFG.sendDelayMs);
  let sendReady = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    try {
      sendReady = await evalJs(pageId, `(() => {
        const sels = ['button[aria-label*="Send" i]','button[aria-label*="发送" i]','[data-testid="send-button"]','button[type="submit"]','[class*="send-btn"]','[class*="sendBtn"]','[class*="send-button"]','[class*="send-icon"]'];
        for (const s of sels) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; } }
        return false;
      })()`);
    } catch (e) { /* ignore */ }
    if (sendReady) break;
  }
  if (!sendReady) log('sendAdapterMessage: send button not ready after 3s, trying anyway');
  const clicked = await evalJs(pageId, adapter.expressions.clickSend);
  if (!clicked) {
    const enterKeys = [
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    ];
    for (const k of enterKeys) { await cdp.call('Input.dispatchKeyEvent', k, p.sessionId); }
  }
  await sleep(500);
}

async function openAdapterNewChat(pageId, adapter) {
  const opened = await evalJs(pageId, adapter.expressions.openNewChat).catch(() => false);
  if (!opened) throw providerError('dom_unavailable', adapter.id + ' new-chat control unavailable');
  await sleep(1200);
  await waitReady(pageId, 30000);
}

function shouldFinishAdapterResponse({ sawText, generating, lastChangeAt, now }) {
  if (!sawText || !lastChangeAt) return false;
  const stableFor = now - lastChangeAt;
  /* Stop control is the normal completion signal. A bounded fallback prevents a stale
   * provider control from keeping ChatGPT/Qwen in DSH's "thinking" state forever. */
  return (!generating && stableFor >= 1200) || stableFor >= 5000;
}

function shouldSkipAdapterBaseline(text, baselineText, sawText) {
  if (sawText) return false;
  return String(text || '') === String(baselineText || '');
}

function computeAdapterDelta(text, lastText, baselineText, sawText) {
  const current = String(text || '');
  const previous = String(lastText || '');
  const baseline = String(baselineText || '');
  if (!current) return '';
  if (!sawText) return baseline && current.startsWith(baseline) ? current.slice(baseline.length) : current;
  return previous && current.startsWith(previous) ? current.slice(previous.length) : current;
}

async function waitForAdapterComposer(pageId, adapter, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const login = await ensureLoggedIn(pageId, adapter.id);
    if (login.challenge) throw providerError('challenge_required', adapter.id + ' requires a browser challenge to be completed');
    if (login.needsLogin) throw providerError('login_required', adapter.id + ' login required');
    if (login.hasChatInput) return login;
    if (Date.now() - start >= timeoutMs) {
      throw providerError('dom_unavailable', adapter.id + ' composer not found on an authenticated page');
    }
    await sleep(500);
  }
}

async function streamAdapterAsk(params, adapter, profile) {
  const streamId = 's' + (++streamSeqs.n);
  const hasChannel = !!(params && params.pageKey);
  streamActive++;
  let pageId = null;
  try {
    if (hasChannel) pageId = await ensureChannelPage(params.pageKey, profile, adapter.id);
    else pageId = await ensurePage(profile, adapter.id);
  } catch (e) {
    streamActive--;
    const kind = e && e.kind ? e.kind : 'unavailable';
    emitEvent('stream-end', { streamId, ok: false, errorKind: kind, error: String(e.message || e) });
    return { streamId };
  }
  const state = { pageId, stopped: false };
  streamStates.set(streamId, state);
  (async () => {
    try {
      await waitForAdapterComposer(pageId, adapter, 15000);
      if (params && params.reset === true) {
        await openAdapterNewChat(pageId, adapter);
        await waitForAdapterComposer(pageId, adapter, 15000);
      }
      let baselineText = '';
      try {
        const before = await evalJs(pageId, adapter.expressions.extractLatest).catch(() => null);
        baselineText = before && typeof before.text === 'string' ? before.text : '';
      } catch (e) { /* ignore */ }
      const model = (params && params.model) || {};
      if (adapter.expressions.selectModel && model.modelName) {
        /* 模型选择：radix dialog 渲染/关闭动画是异步的，失败或未确认（pending）
         * 时间隔重试（幂等，已选中会直接返回），最多 3 次；全部失败只告警不
         * 中断——按页面当前模型继续对话，避免页面模型清单与网关清单不一致时
         * 所有请求直接报错。 */
        let sel = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          sel = await evalJs(pageId, '(' + adapter.expressions.selectModel + ')(' + JSON.stringify(model.modelName) + ')')
            .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
          if (sel && sel.ok === true && sel.pending !== true) break;
          await sleep(800);
        }
        if (!sel || sel.ok !== true) log('selectModel: ' + adapter.id + ' model selection issue: ' + JSON.stringify(sel));
      }
      const modeOptions = {};
      if (model.search === true) modeOptions.search = true;
      if (model.mode === 'thinking') modeOptions.thinking = true;
      else if (model.mode === 'fast') modeOptions.thinking = false;
      /* 模式切换：与 selectModel 同级的重试。模型切换完成后页面常见短暂重渲染，
       * 模式胶囊（trigger）可能在 1~2 个 UI tick 内不可见；radix 菜单的打开动画
       * 也会间歇性导致首次求值找不到菜单项。最多重试 3 次，间隔 800ms，与
       * selectModel 节奏对齐。pending 状态（radix aria-checked 异步回写）视为需重试。 */
      let mode = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        mode = await evalJs(pageId, '(' + adapter.expressions.applyMode + ')(' + JSON.stringify(modeOptions) + ')')
          .catch((e) => ({ ok: false, kind: 'dom_unavailable', mode: (modeOptions && modeOptions.thinking === true) ? 'thinking' : 'requested', error: String((e && e.message) || e) }));
        if (mode && mode.ok === true && mode.pending !== true) break;
        await sleep(800);
      }
      if (!mode || mode.ok !== true) throw providerError('mode_unavailable', adapter.id + ' mode unavailable: ' + ((mode && mode.mode) || 'requested'));
      await sendAdapterMessage(pageId, adapter, params.question);
      const timeoutMs = (params && params.timeoutMs) || 240000;
      const started = Date.now();
      let lastText = '';
      let lastChange = Date.now();
      let sawText = false;
      for (;;) {
        if (state.stopped) throw providerError('unavailable', 'stream stopped');
        await adapterSignals(pageId, adapter);
        const latest = await evalJs(pageId, adapter.expressions.extractLatest).catch(() => null);
        if (!latest || typeof latest.text !== 'string') throw providerError('dom_unavailable', adapter.id + ' response DOM unavailable');
        const text = latest.text;
        if (text && text !== lastText) {
          if (shouldSkipAdapterBaseline(text, baselineText, sawText)) {
            lastText = text;
          } else {
            const delta = computeAdapterDelta(text, lastText, baselineText, sawText);
            if (delta) emitEvent('stream-delta', { streamId, delta });
            lastText = text;
            lastChange = Date.now();
            sawText = true;
          }
        }
        const generating = await evalJs(pageId, adapter.expressions.detectGenerating).catch(() => true);
        if (shouldFinishAdapterResponse({ sawText, generating, lastChangeAt: lastChange, now: Date.now() })) break;
        if (Date.now() - started > timeoutMs) throw providerError('unavailable', adapter.id + ' response timed out');
        await sleep(350);
      }
      const adapterToolCalls = parseToolCalls(lastText, params && params.tools, { protocol: (params && params.toolProtocol) || (process.env.DSWEB_TOOL_PROTOCOL === 'compat' ? 'compat' : 'strict') });
      updateLastStreamSummary({ streamId, profile: profile.name, pageKey: (params && params.pageKey) || null, pageId, finishBy: 'adapter', ok: true, resultLen: lastText.length, toolCalls: adapterToolCalls.length });
      emitEvent('stream-end', adapterToolCalls.length ? { streamId, ok: true, result: lastText, toolCalls: adapterToolCalls } : { streamId, ok: true, result: lastText });
    } catch (e) {
      const kind = e && e.kind ? e.kind : 'dom_unavailable';
      updateLastStreamSummary({ streamId, profile: profile.name, pageKey: (params && params.pageKey) || null, pageId, finishBy: 'exception', ok: false, errorKind: kind, error: String(e.message || e) });
      emitEvent('stream-end', { streamId, ok: false, errorKind: kind, error: String(e.message || e) });
    } finally {
      streamStates.delete(streamId);
      streamActive--;
    }
  })();
  return { streamId };
}


/* 检测文本"看起来像工具调用但没被解析"（参考 deepseek-browser-agent agent.js 安全网）：
 * 文本含 tool_call 标记 / "name"/"tool" 键 / 代码块函数调用 / 已知工具名 → 应触发解析重试 */
function looksLikeToolCall(text, tools) {
  const t = String(text || '').slice(0, 2000);
  if (/tool_call|<tool_call>|<tool_calls>|<invoke\b/i.test(t)) return true;
  if (/^[\s\S]{0,120}```tool_call/i.test(t)) return true;
  if (/["'](?:name|tool|function)["']\s*:\s*["'][\w_]+["']/.test(t)) return true;
  if (/```\w*\s*[\w_]+\s*\(/.test(t)) return true;
  if (/(?:write_file|read_file|run_command|list_directory|pwsh|subagent|web_search)\b/.test(t)) return true;
  if (Array.isArray(tools) && tools.length) {
    for (const tool of tools) {
      const fn = tool.function || tool;
      if (!fn || !fn.name) continue;
      const name = String(fn.name);
      if (new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) return true;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const keys = Object.keys(props);
      const hit = keys.filter((k) => new RegExp('["\']' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']\\s*:').test(t)).length;
      if (keys.length && hit >= Math.min(2, keys.length)) return true;
    }
  }
  return false;
}

/**
 * 流式问答（DSH 主路径，网关每轮 chat completion 的最终落点）。
 * 异步模型：立即返回 streamId，过程经事件上报（stream-delta 增量 / stream-end 终态）。
 * 流程：页面分配（pageKey 专属通道 / thePage / 子页面）→ 登录检测（失效 → errorKind=login）
 * → 会话管理（reset=true 强制新会话 / 'auto' 超限自动迁移+摘要）
 * → applyConfig pill 幂等切换（校准回放兜底）→ sendMessage
 * → 轮询循环（Promise.all 并行探测文本/生成中/思考；detectLimit 限流检测：
 *    length → 迁移+摘要重试（≤2 次）；quota/captcha → errorKind 上报网关切账号）
 * → parseToolCalls 工具解析（安全网重试 ≤2 次）→ stream-end { ok, result, toolCalls }。
 * @param {object} params { question, profile, pageKey, reset, mode, deepThink, search,
 *   headless, calibKey, maxTurnsPerChat, timeoutMs, tools }
 * @returns {Promise<{streamId: string}>} 流标识（结果走事件，不走 RPC 返回值）
 */

handlers.streamAsk = async (params) => {
  const question = params && params.question;
  if (!question || !String(question).trim()) throw new Error('question required');
  const providerId = (params && params.providerId) || 'deepseek';
  const adapter = resolveProviderAdapter(providerId);
  const profile = { name: profileKey(adapter.id, params && params.profile), headless: params && params.headless !== undefined ? !!params.headless : false };
  if (adapter.id !== 'deepseek') return streamAdapterAsk(params, adapter, profile);
  const streamId = 's' + (++streamSeqs.n);
  /* 页面分配（并发最佳实践：会话亲和）：
   * 1. 带 pageKey（网关会话注册表分配）→ 专属通道页面——同一会话固定同一 tab，历史保持
   * 2. 无 pageKey（兼容路径：手动 rpc / 旧客户端）→ 无并发用 thePage，有并发用独立页面 */
  streamActive++;
  const hasChannel = !!(params && params.pageKey);
  const isConcurrent = streamActive > 1;
  let pageId = null;
  try {
    if (hasChannel) {
      pageId = await ensureChannelPage(params.pageKey, profile, adapter.id);
    } else if (!isConcurrent) {
      pageId = await ensurePage(profile, adapter.id);
    } else {
      pageId = subPages.pop() || await newPage();
      try { await navigate(pageId, providerUrl(adapter.id)); } catch (e) { /* 子页面导航失败时由登录检测兜底 */ }
      try { await ensureLoggedIn(pageId, adapter.id); } catch (e) { /* 子页面登录态与主共享 */ }
    }
  } catch (e) {
    streamActive--;
    emitEvent('stream-end', { streamId, ok: false, error: String(e.message || e) });
    return { streamId };
  }
  const st = { pageId, stopped: false };
  streamStates.set(streamId, st);
  (async () => {
    try {
      let login = await ensureLoggedIn(pageId, adapter.id);
      /* 页面可能还在加载（重建后）→ 等待重试，避免误判未登录 */
      for (let i = 0; i < 3 && (login.needsLogin || !login.hasChatInput); i++) {
        await sleep(2000);
        login = await ensureLoggedIn(pageId, adapter.id);
      }
      if (login.needsLogin || !login.hasChatInput) {
        emitEvent('stream-end', { streamId, ok: false, errorKind: 'login', error: 'login required: 页面已关闭或未登录。请从本地 Provider Console 重新登录（建议勾选保持登录）。' });
        return;
      }
      /* 模型切换由校准回放（applyCalibration）负责——不调用 applyConfig
       * （它会对 expert 模式点击两次"深度思考"，与校准冲突产生多余操作） */
      /* 问题组装由网关完成（buildContext 已内嵌工具协议块到 [用户] 之前，
       * 位置最优；限长在网关 buildToolsText 智能压缩，不再 driver 端截断） */
      let payload = String(question);
      /* 会话管理（绕限）：
       * reset=true  → 强制新会话（清历史）后应用校准
       * reset='auto' → 连续对话（网页版历史保持）；网页版会话超限（消息数 > 25）时
       *                 自动迁移：提取当前会话摘要 → newChat → 注入摘要 → 继续
       * reset 其他/无 → 连续（不 newChat，网页版记住历史） */
      let migrated = false;
      if (params && params.reset === true) {
        await newChat(pageId);
        migrated = true;
      } else if (params && params.reset === 'auto') {
        let count = 0;
        try { count = await evalJs(pageId, EXPR.messageCount); } catch (e) { /* ignore */ }
        /* 对话长度限制（可配置 maxTurnsPerChat，默认 50）——超限迁移+摘要 */
        const limit = (params && params.maxTurnsPerChat) || 50;
        if (count > limit) {
          /* 超限迁移：提取网页版会话历史 → 压缩摘要 → 新会话注入 */
          let digest = '';
          try { digest = await extractHistoryDigest(pageId); } catch (e) { /* ignore */ }
          await newChat(pageId);
          migrated = true;
          if (digest) payload = '【之前的对话摘要，请基于此继续】\n' + digest + '\n\n' + payload;
        }
      }
      /* 模式应用（2026-08 页面重构）：旧"专家模式"选择器已下线，改为输入框下方
       * pill 开关（深度思考/智能搜索）。每次请求都幂等应用——连续对话中上一请求
       * 可能改变了开关状态（reasoner→chat 需关思考，反向需开）。
       * 校准回放降级为 fallback：pill 未找到时若存在该模型的录制则回放
       * （应对区域差异化改版）。迁移（新会话）后需等待页面就绪。 */
      if (migrated) {
        try { await waitReady(pageId, 15000); } catch (e) { /* ignore */ }
        await sleep(1500);
      }
      try {
        const rep = await applyConfig(pageId, {
          mode: params && params.mode,
          deepThink: params && params.deepThink,
          search: params && params.search,
        });
        if (rep.toggles && rep.toggles.length) log('applyConfig: ' + rep.toggles.join(' | '));
        if (rep.warnings && rep.warnings.length) log('applyConfig warnings: ' + rep.warnings.join('; '));
        /* pill 未找到（页面改版/区域差异）→ 回放该模型的校准录制 */
        const needFallback = (params && params.calibKey) &&
          rep.warnings.some((w) => w.indexOf('pill not found') >= 0 || w.indexOf('entry not found') >= 0);
        if (needFallback) {
          const applied = await applyCalibration(pageId, params.calibKey);
          if (applied) log('applyCalibration fallback: ' + applied + ' 步回放');
        }
      } catch (e) { log('applyConfig warn', e.message); }
      /* Snapshot before clicking Send: a fast reply can otherwise arrive before the
       * first poll and be mistaken for the old-message baseline. */
      const snapshotBeforeSend = async () => {
        const beforeText = await evalJs(pageId, EXPR.extractLast).catch(() => '');
        return cleanText(beforeText);
      };
      let beforeClean = await snapshotBeforeSend();
      await sendMessage(pageId, payload, {});
      const timeoutMs = (params && params.timeoutMs) || 240000;
      /* 参考 deepseek-browser-agent agent.js 的容错循环：
       * 解析失败/像工具调用但没解析 → 发纠正消息重试（最多 2 次），而非直接把文本返回 */
      const RETRY_PROMPT = '你的上一条回复看起来包含工具调用，但格式无法解析。请重新输出：整个回复必须 ONLY 一个 ```tool_call 代码块（含 "name" 和 "args" 两个键），前后不要有任何文字、解释或标点。';
      let finalText = '';
      let toolCalls = [];
      /* 限流检测（动态风控核心）：DeepSeek 公平使用风控的受限提示会作为"回复"本身出现
       * （"服务器繁忙，请稍后再试"等）。仅当新回复较短（<400 字符）时对回复文本检测，
       * 避免误判正常长回复中被复述的关键词；检测到 → 结构化 errorKind 上报网关切账号，
       * 不把受限文案当正常回答发给 DSH。 */
      let limitHit = null;
      let lengthHit = false; /* 对话过长信号（SPEC-v2 §5.3）：走迁移+摘要重试，不上报网关不切账号 */
      let finalAttempt = 0;
      let finalLastText = '';
      let finalThinkSent = '';
      let finalThinkLastChange = 0;
      let finalLastChange = 0;
      let finalGenSeen = false;
      let finalLastDoneReason = null;
      let finalLastDoneState = { thinking: false, searching: false, doneActions: false, thinkStalled: false, dedupedLen: 0 };
      let retrySamePayload = false;
      const requestStart = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        finalAttempt = attempt;
        if (attempt > 0) {
          if (retrySamePayload) {
            log('streamAsk 未见新回复 → 重发原问题重试 ' + attempt + '/2');
            retrySamePayload = false;
            beforeClean = await snapshotBeforeSend();
            await sendMessage(pageId, payload, {});
          } else if (lengthHit) {
            /* 对话过长 → 迁移+摘要：提取当前会话摘要 → newChat → 注入摘要重发原问题。
             * 旧实现检测到 length 后直接忽略，"对话过长"文案被当正常回复发给 DSH。 */
            log('streamAsk 对话过长 → 迁移+摘要重试 ' + attempt + '/2');
            let digest = '';
            try { digest = await extractHistoryDigest(pageId); } catch (e) { /* ignore */ }
            await newChat(pageId);
            migrated = true;
            if (digest) payload = '【之前的对话摘要，请基于此继续】\n' + digest + '\n\n' + payload;
            lengthHit = false;
            /* 新会话就绪等待 + 模式 pill 幂等重应用（newChat 可能重置页面状态） */
            try { await waitReady(pageId, 15000); } catch (e) { /* ignore */ }
            await sleep(1500);
            try {
              await applyConfig(pageId, {
                mode: params && params.mode,
                deepThink: params && params.deepThink,
                search: params && params.search,
              });
            } catch (e) { log('applyConfig warn', e.message); }
            beforeClean = await snapshotBeforeSend();
            await sendMessage(pageId, payload, {});
          } else {
            log('streamAsk 安全网: 像工具调用但解析失败，发纠正消息重试 ' + attempt + '/2');
            beforeClean = await snapshotBeforeSend();
            await sendMessage(pageId, RETRY_PROMPT, {});
          }
        }
        const start = Date.now();
        /* beforeClean is captured immediately before the send that started this attempt.
         * It is only a new-reply baseline and is never returned as this attempt's result. */
        let lastText = ''; /* 本轮新回复的累计文本（cleanText 后；firstSeen 后才有效） */
        let lastThink = ''; /* 思考流累计快照（思考增量差分基线；每 attempt 重置） */
        let thinkSent = ''; /* 已发送的思考全量文本（用于正文去重：正文不应重复输出思考内容） */
        let thinkLastChange = 0; /* 思考文本最后变化时刻：用于区分“仍在思考”与“思考面板仍可见但内容已静止” */
        let sentEnd = 0; /* 已发送正文的字符偏移（cleanText 后文本中的位置；增量去重基线） */
        let lastChange = 0; /* 不为初始值 Date.now()，避免 5s 兜底在文本未出现时误触发 */
        let lastObservedText = ''; /* 最近一次观测到的正文快照（用于稳定判定；忽略 shrink 时不反复重置 lastChange） */
        let firstSeen = false; /* 首次看到新回复文本 */
        let genSeen = false; /* 是否见过生成中（文本相同的新回复靠 generating 完成判定） */
        let pollCount = 0; /* 轮询计数（调试日志用） */
        let lastDoneReason = null; /* 本轮退出轮询的主要原因（debug/health） */
        let lastDoneState = { thinking: false, searching: false, doneActions: false, thinkStalled: false, dedupedLen: 0 };
        function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
        function stripLeadingThinkLeak(raw, thinkingText) {
          const text = String(raw || '');
          const think = String(thinkingText || '').trim();
          if (!text || !think || think.length < 80) return { text, offset: 0, matched: false, mode: 'none' };
          const thinkNorm = normText(think);
          const textNorm = normText(text);
          const thinkHead = thinkNorm.slice(0, Math.min(200, thinkNorm.length));
          if (!textNorm.startsWith(thinkHead) || textNorm.length <= thinkHead.length) return { text, offset: 0, matched: false, mode: 'none' };
          const tailLen = Math.min(120, Math.max(24, Math.floor(think.length * 0.08)));
          const tail = think.slice(-tailLen).trim();
          if (tail) {
            const tailPos = text.indexOf(tail);
            if (tailPos >= 0) {
              const cut = tailPos + tail.length;
              const sliced = text.slice(cut).replace(/^\s*\n?/, '');
              if (sliced && sliced.length < text.length) return { text: sliced, offset: cut, matched: true, mode: 'tail' };
            }
          }
          const suffixNorm = textNorm.slice(thinkHead.length).replace(/^\s+/, '');
          if (suffixNorm.length > 0) {
            const anchor = suffixNorm.slice(0, Math.min(24, suffixNorm.length));
            const idx = text.indexOf(anchor, Math.max(0, Math.floor(think.length * 0.7)));
            if (idx > 0) {
              const sliced = text.slice(idx).replace(/^\s*\n/, '');
              if (sliced && sliced.length < text.length) return { text: sliced, offset: idx, matched: true, mode: 'head' };
            }
          }
          return { text, offset: 0, matched: false, mode: 'none' };
        }
        function looksLikeThinkLeak(raw, thinkingText) {
          const thinkNorm = normText(thinkingText);
          const rawNorm = normText(raw);
          if (!thinkNorm || thinkNorm.length < 80 || !rawNorm) return false;
          const head = thinkNorm.slice(0, Math.min(200, thinkNorm.length));
          const pos = rawNorm.indexOf(head);
          return pos >= 0 && pos < 80;
        }
        function shouldAcceptAnswerShrink(prevRaw, nextRaw, nextDeduped, thinkingText) {
          const prevNorm = normText(prevRaw);
          const nextNorm = normText(nextRaw);
          const dedupNorm = normText(nextDeduped);
          if (!prevNorm || !dedupNorm) return false;
          if (prevNorm.length < 120 || dedupNorm.length >= prevNorm.length) return false;
          if (!looksLikeThinkLeak(prevRaw, thinkingText)) return false;
          if (nextNorm.length + 80 >= prevNorm.length) return false;
          if (dedupNorm.length > Math.max(160, Math.floor(prevNorm.length * 0.45))) return false;
          return true;
        }
        function shrinkDiag(prevRaw, nextRaw, nextDeduped, thinkingText) {
          const prevNorm = normText(prevRaw);
          const nextNorm = normText(nextRaw);
          const dedupNorm = normText(nextDeduped);
          const thinkNorm = normText(thinkingText);
          const leak = looksLikeThinkLeak(prevRaw, thinkingText);
          return 'prevRawLen=' + String(prevRaw || '').length +
            ' prevNormLen=' + prevNorm.length +
            ' nextRawLen=' + String(nextRaw || '').length +
            ' nextNormLen=' + nextNorm.length +
            ' nextDedupLen=' + String(nextDeduped || '').length +
            ' nextDedupNormLen=' + dedupNorm.length +
            ' thinkLen=' + String(thinkingText || '').length +
            ' thinkNormLen=' + thinkNorm.length +
            ' leak=' + leak;
        }
        while (Date.now() - start < timeoutMs) {
          if (st.stopped) throw new Error('stopped');
          /* 五项探测并行（CDP roundtrip 串行会把轮询周期拉长近一倍）：
           * 正文 / 生成中 / 思考中 / 思考文本 / 搜索中
           * （非思考/搜索模式无容器 → ''/false，空跑一轮） */
          const [textR, genR, thinkR, thinkTextR, searchR] = await Promise.all([
            evalJs(pageId, EXPR.extractLast).catch(() => ''),
            evalJs(pageId, EXPR.generating).catch(() => true),
            evalJs(pageId, EXPR.thinking).catch(() => false),
            evalJs(pageId, EXPR.extractThinking).catch(() => ''),
            evalJs(pageId, EXPR.searching).catch(() => false),
          ]);
          /* 思考流增量（kind=thinking，网关转 reasoning_content）：
           * 思考文本只增（生成中）；收缩/折叠（完成）→ 只更新基线不发增量。
           * 折叠后读 ''，不重置 lastThink——下轮 attempt 重试时在循环外重置。 */
          const thinkText = thinkTextR || '';
          if (thinkText && thinkText !== lastThink) {
            const td = thinkText.length > lastThink.length ? thinkText.slice(lastThink.length) : '';
            if (td) {
              emitEvent('stream-delta', { streamId, delta: td, kind: 'thinking' });
              logDbg('streamAsk think-delta: +' + td.length + ' chars (total=' + thinkText.length + ')');
            }
            lastThink = thinkText;
            thinkSent = thinkText;
            thinkLastChange = Date.now();
          }
          /* 思考折叠后 extractThinking 返回 ''，但 thinkSent 保留已发思考全量。
           * 用于正文去重：extractLast 可能泄漏思考文本（class 过滤遗漏），需要
           * 在 delta 发送前去除与 thinkSent 重叠的前缀部分。 */
          /* 正文 cleanText 后比较：流式增量与终态 result 同基准
           * （网关前缀对齐补尾的前提；cleanText 幂等——按钮行/空行中途出现不破坏前缀）。 */
          const text = cleanText(textR || '');
          const gen = genR !== false; /* 探测失败按生成中处理（保守不退出） */
          const thinking = !!thinkR;
          const searching = !!searchR;
          if (text !== lastObservedText) {
            lastObservedText = text;
            lastChange = Date.now();
          }
          if (gen) genSeen = true;
          pollCount++;
          /* 调试日志：每 10 轮或关键状态变化时输出（避免日志洪泛） */
          if (pollCount <= 3 || pollCount % 10 === 0 || (!gen && genSeen) || (firstSeen && text !== lastText)) {
            log('streamAsk poll#' + pollCount + ' gen=' + gen + ' thinking=' + thinking + ' searching=' + searching + ' firstSeen=' + firstSeen + ' textLen=' + text.length + ' thinkLen=' + thinkText.length + ' lastChange=' + (lastChange > 0 ? (Date.now() - lastChange) + 'ms' : 'n/a'));
          }
          /* 正文去重 v3：extractLast 可能泄漏思考内容（class/data 过滤遗漏），
           * 正文文本会以已发送的思考文本开头。去除重叠前缀，防止思考内容在
           * reasoning_content 和 content 中重复输出。
           * 策略：每次轮询都对 text 做去重（不仅 firstSeen），因为思考内容可能
           * 随正文一起增长。用 thinkHead 前缀匹配找到切割点，映射回原始 text。
           * sentEnd 跟踪已发送正文的字符偏移（在去重后文本中），增量从 sentEnd 切片。 */
          let deduped = text;
          let dedupOffset = 0;
          if (thinkSent && thinkSent.length > 20 && text) {
            const leakStrip = stripLeadingThinkLeak(text, thinkSent);
            if (leakStrip.matched) {
              deduped = leakStrip.text;
              dedupOffset = leakStrip.offset;
              logDbg('streamAsk think-dedup: mode=' + leakStrip.mode + ' offset=' + dedupOffset + ' rawLen=' + text.length + ' dedupedLen=' + deduped.length);
            }
          }
          const thinkStalled = !!(thinking && thinkLastChange > 0 && Date.now() - thinkLastChange >= 1200 && deduped && deduped.length > 0 && !gen && !searching);
          const canEmitContent = (!thinking || thinkStalled) && !searching;
          /* 变化检测：与发送前基线不同 = 新回复开始出现。
           * 修复：delta 从新回复自身累计（首轮发全量、后续发增量），
           * 旧实现 text.slice(beforeText.length) 假设新回复是旧回复的前缀扩展——
           * 两轮回复内容无关，切片会把新回复开头截掉。 */
          if (deduped && !firstSeen && text !== beforeClean) {
            firstSeen = true;
            lastText = text;
            if (canEmitContent) sentEnd = deduped.length;
            else sentEnd = 0;
            log('streamAsk firstText len=' + deduped.length + ' (raw=' + text.length + ' dedupOffset=' + dedupOffset + ') after ' + (Date.now() - start) + 'ms');
            /* 受限提示检测（先于 delta 发出）：新回复文本短且命中风控模式 → 立即终止。
             * 检测先行保证限流文案绝不流入客户端——切号重试无残留文本污染。 */
            if (!limitHit && deduped.length < 400) {
              const lim = detectLimit(deduped);
              if (lim && lim.kind === 'length') {
                lengthHit = true;
                log('streamAsk 对话过长检测命中: text[:120]=' + deduped.slice(0, 120).replace(/\n/g, '\\n'));
                break;
              }
              if (lim && (lim.kind === 'quota' || lim.kind === 'captcha')) {
                limitHit = lim;
                log('streamAsk 限流检测命中: kind=' + lim.kind + ' text[:120]=' + deduped.slice(0, 120).replace(/\n/g, '\\n'));
                break;
              }
            }
            if (canEmitContent) {
              emitEvent('stream-delta', { streamId, delta: deduped });
            } else {
              logDbg('streamAsk hold content while waiting: rawLen=' + text.length + ' dedupedLen=' + deduped.length + ' thinking=' + thinking + ' searching=' + searching + ' gen=' + gen);
            }
          } else if (firstSeen && text && text !== lastText) {
            /* 流式增长：发增量。修复：页面重渲染/占位符闪烁可能导致文本瞬时缩短，
             * 大多数 shrink 仍视为瞬时抖动；但 think 模式存在一个合法 shrink：
             * 早前 extractLast 混入了长思考文本，随后页面折叠思考、切换成很短的真实正文。
             * 若此时仍一律忽略 shrink，就会把思考泄漏内容永久保留成 finalText，
             * 真正正文永远进不了 content。 */
            const grew = text.length > lastText.length;
            const acceptShrink = !grew && shouldAcceptAnswerShrink(lastText, text, deduped, thinkSent);
            if (!grew && text.length !== lastText.length && thinkSent && thinkSent.length > 80) {
              logDbg('streamAsk shrink-check: ' + shrinkDiag(lastText, text, deduped, thinkSent) + ' accept=' + acceptShrink + ' firstSeen=' + firstSeen + ' gen=' + gen + ' thinking=' + thinking + ' searching=' + searching);
            }
            if (grew) {
              const newPart = deduped.slice(sentEnd);
              lastText = text;
              if (canEmitContent) {
                sentEnd = deduped.length;
                if (newPart) emitEvent('stream-delta', { streamId, delta: newPart });
              } else sentEnd = 0;
            } else if (acceptShrink) {
              const prevText = lastText;
              lastText = text;
              if (canEmitContent) {
                sentEnd = 0;
                if (deduped) emitEvent('stream-delta', { streamId, delta: '\n' + deduped });
                sentEnd = deduped.length;
              } else sentEnd = 0;
              log('streamAsk 接纳 think→正文 shrink: ' + shrinkDiag(prevText, text, deduped, thinkSent) + '（旧正文疑似混入思考，切换到真实短答案）');
            }
            if (!limitHit && deduped.length < 400) {
              const lim = detectLimit(deduped);
              if (lim && lim.kind === 'length') {
                lengthHit = true;
                log('streamAsk 对话过长检测命中: text[:120]=' + deduped.slice(0, 120).replace(/\n/g, '\\n'));
                break;
              }
              if (lim && (lim.kind === 'quota' || lim.kind === 'captcha')) {
                limitHit = lim;
                log('streamAsk 限流检测命中: kind=' + lim.kind + ' text[:120]=' + deduped.slice(0, 120).replace(/\n/g, '\\n'));
                break;
              }
            }
          }
          if (firstSeen && sentEnd === 0 && deduped && (!thinking || thinkStalled) && !searching) {
            lastText = text;
            emitEvent('stream-delta', { streamId, delta: deduped });
            sentEnd = deduped.length;
            logDbg('streamAsk flush buffered content after waiting: dedupedLen=' + deduped.length + ' thinkStalled=' + thinkStalled + ' thinking=' + thinking + ' searching=' + searching);
          }
          /* 完成判定（v3d 搜索兼容版，防提前终止丢内容）：
           * 与 v3c 相比，新增 !searching 守卫——智能搜索阶段（思考折叠后、正文出现前/中）
           * 页面显示搜索结果容器，文本可能暂时稳定，但生成尚未完成。
           * !thinking && !searching 在所有分支都要求——思考/搜索→正文间隙绝不退出。
           * 1) 正信号（最可靠、最快）：见过生成中(genSeen)且当下 !gen（停止按钮消失），
           *    或页面出现完成态动作按钮(复制/重新生成，生成中不显示) → 稳定 400ms 即完成；
           *    直接解决 generating 选择器漏检时"文本稳定"误判提前 break 的问题。
           * 2) 非生成中 + 非思考中 + 非搜索中 + 文本稳定 1500ms → 完成（generating 漏检兜底；
           *    1500ms 而非 800ms，避免生成中 DOM 突发 >800ms 静默间隙误触发提前 break）。
          * 3) 安全网：文本稳定超时即完成（防 generating 误判常驻卡死到 240s）。
           *    gen=true 时用 30s 超时（搜索阶段文本可能长时间稳定，需更长等待）；
           *    gen=false 时保留 5s 超时（generating 误判常驻兜底）。 */
          let doneActions = false;
          if (!searching) { try { doneActions = await evalJs(pageId, EXPR.doneActions); } catch (e) { /* ignore */ } }
          lastDoneState = { thinking, searching, doneActions, thinkStalled, dedupedLen: deduped.length };
          const doneSignal = (genSeen && !gen) || doneActions || thinkStalled;
          if (thinkStalled) {
            logDbg('streamAsk think-stalled: think panel still visible but content present and think stable for ' + (Date.now() - thinkLastChange) + 'ms; allow completion');
          }
          if (lastChange > 0 && doneSignal && !searching && (!thinking || thinkStalled) && Date.now() - lastChange >= 400) {
            lastDoneReason = 'doneSignal';
            logDbg('streamAsk done: doneSignal (genSeen=' + genSeen + ' gen=' + gen + ' doneActions=' + doneActions + ' thinkStalled=' + thinkStalled + ') after ' + (Date.now() - start) + 'ms');
            break;
          }
          if (lastChange > 0 && lastText.length > 10 && !gen && !searching && (!thinking || thinkStalled) && Date.now() - lastChange >= 1500) {
            lastDoneReason = 'stable1500ms';
            logDbg('streamAsk done: stable 1500ms after ' + (Date.now() - start) + 'ms' + (thinkStalled ? ' (thinkStalled)' : ''));
            break;
          }
          if (lastChange > 0 && lastText.length > 10 && gen && !searching && (!thinking || thinkStalled) && Date.now() - lastChange >= 5000) {
            lastDoneReason = 'genStuck5s';
            logDbg('streamAsk done: gen-stuck fallback 5s after ' + (Date.now() - start) + 'ms');
            break;
          }
          if (lastChange > 0 && !searching && (!thinking || thinkStalled) && Date.now() - lastChange >= (gen ? 30000 : 5000)) {
            lastDoneReason = gen ? 'timeout30s' : 'timeout5s';
            logDbg('streamAsk done: timeout (' + (gen ? 30 : 5) + 's) after ' + (Date.now() - start) + 'ms' + (thinkStalled ? ' (thinkStalled)' : ''));
            break;
          }
          await sleep(200);
        }
        /* 对话过长：attempt 未用尽 → 迁移+摘要重试（循环开头处理）；
         * 用尽 → 显式报错（ok:false 无 errorKind，网关按普通错误上报，不切账号） */
        if (lengthHit) {
          updateLastStreamSummary({
            streamId,
            profile: profile.name,
            pageKey: (params && params.pageKey) || null,
            pageId,
            attempt,
            finishBy: 'lengthRetryExhausted',
            ok: false,
            error: 'length: 对话过长且迁移重试后仍受限，请重试或缩短对话',
            genSeen,
            thinking: lastDoneState.thinking,
            searching: lastDoneState.searching,
            doneActions: lastDoneState.doneActions,
            thinkStalled: lastDoneState.thinkStalled,
            toolCalls: 0,
            resultLen: 0,
            lastTextLen: finalText ? finalText.length : lastText.length,
            thinkLen: thinkSent.length,
            dedupedLen: lastDoneState.dedupedLen,
            lastChangeAgoMs: lastChange > 0 ? (Date.now() - lastChange) : null,
            thinkIdleMs: thinkLastChange > 0 ? (Date.now() - thinkLastChange) : null,
          });
          if (attempt < 2) continue;
          emitEvent('stream-end', { streamId, ok: false, error: 'length: 对话过长且迁移重试后仍受限，请重试或缩短对话' });
          return;
        }
        /* 超时保护：新回复从未出现（发送失败/页面卡死）→ 报错而非把上一轮
         * 旧回复当本轮结果返回（旧实现静默返回旧文本，用户看到重复的旧答案）。
         * genSeen 兜底：见过生成中但文本与上轮完全相同（极端巧合）不误报 */
        if (!firstSeen && !genSeen) {
          if (attempt < 2) {
            retrySamePayload = true;
            await sleep(1000);
            continue;
          }
          const waitedSec = Math.max(1, Math.round((Date.now() - requestStart) / 1000));
          updateLastStreamSummary({
            streamId,
            profile: profile.name,
            pageKey: (params && params.pageKey) || null,
            pageId,
            attempt,
            finishBy: 'timeoutNoFirstSeen',
            ok: false,
            error: 'timeout: 等待 ' + waitedSec + 's 未见新回复（页面可能卡死或发送失败），请重试',
            genSeen,
            thinking: lastDoneState.thinking,
            searching: lastDoneState.searching,
            doneActions: lastDoneState.doneActions,
            thinkStalled: lastDoneState.thinkStalled,
            toolCalls: 0,
            resultLen: 0,
            lastTextLen: lastText.length,
            thinkLen: thinkSent.length,
            dedupedLen: lastDoneState.dedupedLen,
            lastChangeAgoMs: lastChange > 0 ? (Date.now() - lastChange) : null,
            thinkIdleMs: thinkLastChange > 0 ? (Date.now() - thinkLastChange) : null,
          });
          emitEvent('stream-end', { streamId, ok: false, error: 'timeout: 等待 ' + waitedSec + 's 未见新回复（页面可能卡死或发送失败），请重试' });
          return;
        }
        finalText = cleanText(lastText);
        /* 终态兜底收割（v3e）：循环可能因生成中 DOM 突发静默/选择器瞬时失配而稍早
         * break。旧版仅取更长者，适用于"尾部漏抓"，但在 think 模式下可能相反：
         * 较长文本是混入思考后的脏正文，较短文本才是真实最终答案。 */
        try {
          const re = cleanText(await evalJs(pageId, EXPR.extractLast).catch(() => ''));
          const pickShortAnswer = shouldAcceptAnswerShrink(finalText, re, re, thinkSent);
          const shorterPrefixAnswer = !!(re && re.length > 0 && re.length < finalText.length && finalText.startsWith(re));
          if (re.length > finalText.length || pickShortAnswer || shorterPrefixAnswer) {
            logDbg('streamAsk final-harvest: ' + shrinkDiag(finalText, re, re, thinkSent) + ' pickShort=' + pickShortAnswer + ' replace=' + (re.length > finalText.length ? 'longer' : 'shrink'));
            finalText = re;
          } else if (re && re !== finalText && thinkSent && thinkSent.length > 80) {
            logDbg('streamAsk final-harvest skip: ' + shrinkDiag(finalText, re, re, thinkSent) + ' pickShort=' + pickShortAnswer);
          }
        } catch (e) { /* ignore */ }
        finalLastText = lastText;
        finalThinkSent = thinkSent;
        finalThinkLastChange = thinkLastChange;
        finalLastChange = lastChange;
        finalGenSeen = genSeen;
        finalLastDoneReason = lastDoneReason;
        finalLastDoneState = lastDoneState;
        toolCalls = parseToolCalls(finalText, params.tools, { protocol: (params && params.toolProtocol) || (process.env.DSWEB_TOOL_PROTOCOL === 'compat' ? 'compat' : 'strict') });
        const toolIntent = looksLikeToolCall(finalText, params.tools);
        logDbg('streamAsk attempt=' + attempt + ' finalTextLen=' + finalText.length + ' toolCalls=' + toolCalls.length + ' looksLikeTool=' + toolIntent);
        /* 解析成功 → 停止重试；
         * 文本仍强烈像工具调用但未解析成功 → 继续走安全网纠正消息（最多 2 次）；
         * 其余普通回答 → 直接结束。 */
        if (toolCalls.length || !toolIntent) break;
      }
      /* 诊断日志：工具调用解析失败时打印实际输出与工具列表，方便定位 */
      if (toolCalls.length) {
        log('streamAsk toolCalls summary: ' + JSON.stringify(summarizeToolCallsForLog(toolCalls)));
        logDbg('streamAsk emitting stream-end with toolCalls=' + toolCalls.length + ' resultLen=' + finalText.length);
      } else {
        const names = (params.tools || []).map((t) => ((t.function || t).name || '?')).join(',');
        log('streamAsk NO-toolCalls summary: ' + JSON.stringify({ result: summarizeTextForLog(finalText), tools: names.slice(0, 400) }));
        logDbg('streamAsk emitting stream-end ok=true resultLen=' + finalText.length);
      }
      if (limitHit) {
        /* 受限（quota/captcha）：结构化上报网关（errorKind）→ 网关标记账号并切换重试 */
        updateLastStreamSummary({
          streamId,
          profile: profile.name,
          pageKey: (params && params.pageKey) || null,
          pageId,
          attempt: finalAttempt,
          finishBy: 'limitHit',
          ok: false,
          errorKind: limitHit.kind,
          error: 'DeepSeek 风控受限（' + limitHit.kind + '）: ' + String(finalText).slice(0, 200),
          genSeen: finalGenSeen,
          thinking: finalLastDoneState.thinking,
          searching: finalLastDoneState.searching,
          doneActions: finalLastDoneState.doneActions,
          thinkStalled: finalLastDoneState.thinkStalled,
          toolCalls: 0,
          resultLen: finalText.length,
          lastTextLen: finalLastText.length,
          thinkLen: finalThinkSent.length,
          dedupedLen: finalLastDoneState.dedupedLen,
          lastChangeAgoMs: finalLastChange > 0 ? (Date.now() - finalLastChange) : null,
          thinkIdleMs: finalThinkLastChange > 0 ? (Date.now() - finalThinkLastChange) : null,
        });
        emitEvent('stream-end', { streamId, ok: false, errorKind: limitHit.kind, error: 'DeepSeek 风控受限（' + limitHit.kind + '）: ' + String(finalText).slice(0, 200) });
        return;
      }
      if (toolCalls.length) {
        updateLastStreamSummary({
          streamId,
          profile: profile.name,
          pageKey: (params && params.pageKey) || null,
          pageId,
          attempt: finalAttempt,
          finishBy: finalLastDoneReason || 'tool_calls',
          ok: true,
          genSeen: finalGenSeen,
          thinking: finalLastDoneState.thinking,
          searching: finalLastDoneState.searching,
          doneActions: finalLastDoneState.doneActions,
          thinkStalled: finalLastDoneState.thinkStalled,
          toolCalls: toolCalls.length,
          resultLen: finalText.length,
          lastTextLen: finalLastText.length,
          thinkLen: finalThinkSent.length,
          dedupedLen: finalLastDoneState.dedupedLen,
          lastChangeAgoMs: finalLastChange > 0 ? (Date.now() - finalLastChange) : null,
          thinkIdleMs: finalThinkLastChange > 0 ? (Date.now() - finalThinkLastChange) : null,
        });
        emitEvent('stream-end', { streamId, ok: true, result: finalText, toolCalls });
      } else {
        updateLastStreamSummary({
          streamId,
          profile: profile.name,
          pageKey: (params && params.pageKey) || null,
          pageId,
          attempt: finalAttempt,
          finishBy: finalLastDoneReason || 'stop',
          ok: true,
          genSeen: finalGenSeen,
          thinking: finalLastDoneState.thinking,
          searching: finalLastDoneState.searching,
          doneActions: finalLastDoneState.doneActions,
          thinkStalled: finalLastDoneState.thinkStalled,
          toolCalls: 0,
          resultLen: finalText.length,
          lastTextLen: finalLastText.length,
          thinkLen: finalThinkSent.length,
          dedupedLen: finalLastDoneState.dedupedLen,
          lastChangeAgoMs: finalLastChange > 0 ? (Date.now() - finalLastChange) : null,
          thinkIdleMs: finalThinkLastChange > 0 ? (Date.now() - finalThinkLastChange) : null,
        });
        emitEvent('stream-end', { streamId, ok: true, result: finalText });
      }
    } catch (e) {
      /* 登录失效的结构化信号（网关据此走自动登录/切换流程） */
      const isLogin = String(e && e.message || '').startsWith('login required');
      const errorKind = e && e.kind ? e.kind : (isLogin ? 'login' : undefined);
      updateLastStreamSummary({
        streamId,
        profile: profile.name,
        pageKey: (params && params.pageKey) || null,
        pageId,
        attempt: 0,
        finishBy: 'exception',
        ok: false,
        errorKind,
        error: e.message,
        genSeen: false,
        thinking: false,
        searching: false,
        doneActions: false,
        thinkStalled: false,
        toolCalls: 0,
        resultLen: 0,
        lastTextLen: 0,
        thinkLen: 0,
        dedupedLen: 0,
        lastChangeAgoMs: null,
        thinkIdleMs: null,
      });
      emitEvent('stream-end', { streamId, ok: false, errorKind, error: e.message });
    } finally {
      streamStates.delete(streamId);
      streamActive--;
      /* 通道页面不归还（会话亲和：绑定持续到网关回收）；兼容路径的并发页面归还池复用 */
      if (!hasChannel && isConcurrent && pageId && pageInfo(pageId)) {
        try { await newChat(pageId); } catch (e) { /* ignore */ }
        subPages.push(pageId);
      }
    }
  })();
  return { streamId };
};

/** 停止一个进行中的流式问答（网关在客户端断开时调用）：置 stopped 标志，
 * streamAsk 轮询循环检测到后中断（防浏览器空转生成）。 */
handlers.streamStop = async (params) => {
  const st = streamStates.get(params && params.streamId);
  if (st) st.stopped = true;
  return { stopped: !!st };
};

/** 回收会话通道（网关在会话 TTL 超时/驱逐时调用）：
 * newChat 清掉该通道的网页版历史（避免下个复用者看到残留上下文）；
 * main 通道常驻只清历史；其他通道解绑后页面归还空闲池（池满则关闭 tab 控制资源）。 */
handlers.releaseChannel = async (params) => {
  const key = params && params.pageKey;
  const providerId = (params && params.providerId) || 'deepseek';
  const identity = channelKey(providerId, key);
  if (!key) return { released: false };
  if (key === 'main' && providerId === 'deepseek') {
    if (thePage && pageInfo(thePage)) {
      try { await newChat(thePage); } catch (e) { /* ignore */ }
    }
    return { released: true, main: true };
  }
  const ch = channels.get(identity);
  channels.delete(identity);
  if (ch && pageInfo(ch.pageId)) {
    try { await newChat(ch.pageId); } catch (e) { /* ignore */ }
    if (subPages.length < 2) subPages.push(ch.pageId);
    else { try { await closePage(ch.pageId); } catch (e) { /* ignore */ } }
  }
  return { released: true };
};

/* ------------------------------------------------------------------ */
/* calibration: record user's manual model-switch, then replay it      */
/* ------------------------------------------------------------------ */
const CALIB_FILE = () => path.join(CFG.baseDir, 'calibration.json');

handlers.calibrateList = async () => {
  try {
    const raw = fs.readFileSync(CALIB_FILE(), 'utf8');
    return JSON.parse(raw);
  } catch (e) { return {}; }
};

handlers.calibrateRecord = async (params) => {
  const profile = { name: (params && params.profile) || 'default', headless: false };
  await ensureBrowser(profile);
  const pageId = await newPage();
  try { await navigate(pageId, DS_URL); } catch (e) { /* ignore */ }
  await waitReady(pageId, 30000);
  await evalJs(pageId, `(() => {
    if (!window.__calibRec) {
      window.__calibRec = [];
      document.addEventListener('click', (e) => {
        let el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
        if (el && el.nodeType !== 1) el = el.parentElement;
        if (!el || !el.tagName) return;
        let best = el;
        let bt = (el.textContent || '').trim().replace(/\\s+/g, ' ');
        let walk = el.parentElement;
        while (walk && walk !== document.body && walk !== document.documentElement) {
          const t = (walk.textContent || '').trim().replace(/\\s+/g, ' ');
          if (t && t.length >= 2 && t.length <= 40) { best = walk; bt = t; break; }
          walk = walk.parentElement;
        }
        window.__calibRec.push({
          tag: best.tagName.toLowerCase(),
          cls: String(best.className || '').slice(0, 150),
          text: bt.slice(0, 80),
          aria: best.getAttribute('aria-label') || '',
          role: best.getAttribute('role') || '',
        });
      }, true);
    }
    return window.__calibRec.length;
  })()`);
  /* 非阻塞：立即返回，录制在后台继续，用户操作完成后调 calibrateCollect */
  return { ok: true, pageId, message: 'recording started — 请在窗口内手动切换模型，完成后调用 calibrateCollect' };
};

handlers.calibrateCollect = async (params) => {
  const pageId = params && params.pageId;
  if (!pageId || !pageInfo(pageId)) {
    return { ok: false, message: '校准窗口已关闭（可能是浏览器重建或窗口被手动关闭）。请重新点"开始校准"。', code: 'page-gone' };
  }
  const rec = await evalJs(pageId, `(() => window.__calibRec || [])()`).catch(() => []);
  return { ok: true, clicks: rec };
};

handlers.calibrateClose = async (params) => {
  const pageId = params && params.pageId;
  if (pageId && pageInfo(pageId)) { try { await closePage(pageId); } catch (e) { /* ignore */ } }
  return { ok: true };
};

handlers.calibrateSave = async (params) => {
  const clicks = params && params.clicks;
  if (!Array.isArray(clicks)) throw new Error('clicks array required');
  const key = (params && params.key) || 'default';
  let store = {};
  try { store = JSON.parse(fs.readFileSync(CALIB_FILE(), 'utf8')); } catch (e) { store = {}; }
  store[key] = clicks;
  fs.writeFileSync(CALIB_FILE(), JSON.stringify(store, null, 2));
  return { ok: true, key, clicks: clicks.length };
};

handlers.calibrateApply = async (params) => {
  const key = (params && params.key) || 'default';
  let store = {};
  try { store = JSON.parse(fs.readFileSync(CALIB_FILE(), 'utf8')); } catch (e) { /* none */ }
  const clicks = store[key];
  if (!clicks || !clicks.length) return { ok: false, message: 'no calibration for ' + key };
  /* 用实际使用页面（thePage）回放——模型切换必须作用在真实页面上才生效 */
  const pageId = await ensurePage({ name: 'default', headless: false });
  const login = await ensureLoggedIn(pageId);
  if (login.needsLogin || !login.hasChatInput) return { ok: false, message: 'login required' };
  /* 打开模型选择器（点当前模型按钮），确保面板可见 */
  try {
    await evalJs(pageId, `(() => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find((e) => {
        const t = (e.textContent || '').trim().replace(/\\s+/g, ' ');
        return t.length > 0 && t.length < 30 && /快速|专家|识图|deepseek|r1|v3|v4|flash|pro|模型/i.test(t);
      });
      if (btn) btn.click();
      return !!btn;
    })()`);
  } catch (e) { /* ignore */ }
  await sleep(600);
  let applied = 0;
  for (const step of clicks) {
    const found = await evalJs(pageId, `(() => {
      const text = ${JSON.stringify(step.text || '')};
      const aria = ${JSON.stringify(step.aria || '')};
      const cls = ${JSON.stringify(step.cls || '')};
      const all = Array.from(document.querySelectorAll('*')).filter((e) => e.childElementCount < 3 && (e.textContent || '').length < 150);
      const cands = [];
      const tKey = text.slice(0, 25);
      if (tKey) cands.push(...all.filter((e) => {
        const t = (e.textContent || '').trim().replace(/\\s+/g, ' ');
        return t.indexOf(tKey) >= 0 && t.length <= 60;
      }));
      if (aria) cands.push(...all.filter((e) => (e.getAttribute('aria-label') || '') === aria));
      if (cls) { const c = cls.split(' ')[0]; if (c) cands.push(...Array.from(document.querySelectorAll('.' + CSS.escape(c)))); }
      const rank = (el) => {
        const r = el.getAttribute('role') || '';
        const tag = el.tagName.toLowerCase();
        if (r === 'radio' || r === 'option' || r === 'menuitem' || r === 'button') return 3;
        if (tag === 'label' || tag === 'li' || tag === 'a') return 2;
        return 1;
      };
      cands.sort((a, b) => rank(b) - rank(a));
      for (const el of cands) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { el.click(); return true; } }
      return false;
    })()`);
    if (found) applied++;
    await sleep(700);
  }
  /* 验证回放后模型状态 + 新会话是否保持（诊断模型选择是会话级还是账号级） */
  let badge1 = null;
  try { badge1 = await evalJs(pageId, EXPR.modelBadge); } catch (e) { /* ignore */ }
  let afterNewChat = null;
  try {
    await newChat(pageId);
    await sleep(1500);
    afterNewChat = await evalJs(pageId, EXPR.modelBadge);
  } catch (e) { /* ignore */ }
  return { ok: true, applied, total: clicks.length, modelBadge: badge1, afterNewChat };
};

handlers.shutdown = async () => { shutdown(0); return { ok: true }; };

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function readJsonFile(p) {
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

/* standalone single-run mode: node driver.js --run <task.json> */
if (RUN_ONCE) {
  (async () => {
    try {
      const taskFile = process.argv[3];
      if (!taskFile) throw new Error('usage: node driver.js --run <task.json>');
      const task = readJsonFile(taskFile);
      const t = makeTask(task);
      t.runOnce = true;
      tasks.set(t.id, t);
      await runTask(t);
      process.stdout.write(JSON.stringify(await handlers.result({ taskId: t.id })) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ fatal: e.message, stack: e.stack }) + '\n');
    }
    await shutdown(0);
  })();
  return;
}

if (IS_MAIN) {
  if (CFG.chromePath) log('using chrome path', CFG.chromePath);
  log('driver ready', VERSION, 'base=' + CFG.baseDir, 'profiles=' + JSON.stringify(CFG.profiles));
  emitEvent('ready', { version: VERSION, baseDir: CFG.baseDir, pid: process.pid });
}

module.exports = { profileKey, channelKey, resolveProviderAdapter, providerUrl, ProviderDriverError, shouldFinishAdapterResponse, shouldSkipAdapterBaseline, computeAdapterDelta, summarizeTextForLog, summarizeToolCallsForLog };