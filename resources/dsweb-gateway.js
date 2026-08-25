'use strict';
/* dsweb-gateway.js — DeepSeek 网页版网关（v3 重写）
 * 把 chat.deepseek.com 伪装成正常的 OpenAI 兼容模型提供方。
 * DSH 通过 settings.yaml 配置 provider=dsweb → pi-ai → 本网关 → driver → 网页版。
 *
 * API:
 *   POST /v1/chat/completions    OpenAI 兼容（流式 SSE，支持 tool_calls）
 *   GET  /v1/models              模型列表（chat/reasoner/search/think-search/expert/expert-reasoner/vision/vision-reasoner）
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
 *   4. 并发 = 会话亲和：指纹识别会话 → 专属页面通道；同会话串行、异会话并行，
 *      全局信号量限流 + 通道数上限 + 空闲 TTL 回收
 *   5. 会话策略 = 首轮发全量上下文（system + runtime context + 工具说明 + 用户消息），
 *      后续只发增量（用户消息 / 工具结果）——网页版页面自己保留历史
 * 用法: node dsweb-gateway.js [--port 5688] [--base <dir>]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { MODELS, resolveModel, listModels, getProvider, defaultProfile } = require('./provider-registry');

/* ---------- 配置 ---------- */
const args = process.argv.slice(2);
/** 解析命令行参数：支持 `--name value` 与 `--name=value` 两种形式。 */
function argVal(name) {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}
const PORT = parseInt(argVal('--port') || '5688', 10) || 5688;
const BASE_DIR = argVal('--base') || path.join(__dirname, '.gw');
/* DRIVER_PATH 默认指向 resources/driver.js（单一源码；测试/诊断均读此文件）。
 * 历史上曾在 BASE_DIR 下维护一份 runtime/driver.js 副本，易与源分叉（修复失效），
 * 现已统一为单一文件：网关直接执行源，本地数据仍经 DS_WEB_BASE=BASE_DIR 落在 runtime/。
 * 可用 --driver 覆盖（向后兼容手动调试）。 */
const DRIVER_PATH = argVal('--driver') || path.join(__dirname, 'driver.js');
const DRIVER_MARKER = 'deepseek-web-driver.js';
const CALIB_FILE = path.join(BASE_DIR, 'calibration.json');
const ACCOUNTS_FILE = path.join(BASE_DIR, 'accounts.json');
const state = {
  headless: false, maxConcurrent: 2, maxTurnsPerChat: 50, maxPages: 4, sessionTtlMs: 10 * 60 * 1000,
  /* 账号池（动态风控应对）：公平使用风控无固定数值/重置时间 → 只信页面信号 +
   * 指数退避 + 探测恢复（SPEC-v2 §0/§5.1） */
  accountPool: true, maxAccounts: 3, autoRelogin: true,
  quotaBackoffBaseMs: 5 * 60 * 1000, quotaBackoffMaxMs: 6 * 60 * 60 * 1000,
  quotaConfirmWindowMs: 10 * 60 * 1000, maxAccountSwitchesPerRequest: 2,
};
let gatewayStartTime = Date.now();
let gatewayRequestCount = 0;
/* 单次 streamAsk 结果等待兜底超时：driver 正常路径最长 ≈3×240s 重试 + 前置开销 ≈13min；
 * 超此值视为 driver 卡死（防会话锁/信号量被挂起请求永久占用，SPEC-v2 稳定性） */
const ASK_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
/* 全局生成并发槽位等待超时：并发上限被占满时，新请求在队列中最多等待这么久，
 * 超时即明确报错返回（而非无限挂起——后者在 DSH 侧表现为「对话阻塞」）。
 * 默认 120s：单账号下并发=2，一个慢生成（搜索+思考/工具循环）约数十秒，
 * 120s 足以让前方请求释放槽位；若仍拿不到说明确有积压，明确告知优于静默卡死。 */
const SEM_WAIT_TIMEOUT_MS = 120 * 1000;

/* 模型映射（2026-08 页面重构：三模式入口 + pill 开关组合）：
 *   模式入口三选一（applyConfig 幂等切换）：
 *     quick  快速模式（V3）—— 可选 pill：深度思考、智能搜索（可同开）
 *     expert 专家模式（R1 推理模型，原生输出 thinking）—— 可选 pill：深度思考
 *     vision 识图模式 —— 可选 pill：深度思考
 *   说明（三模式均可选深度思考，与 chat.deepseek.com 当前页面一致）：
 *     - 深度思考 = 开启对应模式的"深度思考"pill：quick 下为 V3 增强 CoT；
 *       expert/vision 下为在 R1 推理模型上开启深度思考。applyConfig 对三模式
 *       均会尝试点击该 pill（pill 不存在时静默跳过，不告警）。
 *     - 智能搜索 pill 仅 quick 入口提供；expert/vision 页面无此开关。
 *   组合即模型（8 种，与官方 API 命名对齐）：
 *     deepseek-chat             快速 V3（无附加开关，默认）
 *     deepseek-reasoner        快速 V3 + 深度思考（quick 的 深度思考 pill，V3 增强 CoT）
 *     deepseek-search           快速 V3 + 智能搜索
 *     deepseek-think-search     快速 V3 + 深度思考 + 智能搜索（仅 quick 有搜索 pill）
 *     deepseek-expert          专家模式（R1，原生思考输出）
 *     deepseek-expert-reasoner 专家模式 + 深度思考（R1 上开启深度思考 pill）
 *     deepseek-vision           识图（纯识图，不带思考）
 *     deepseek-vision-reasoner  识图 + 深度思考（识图模式下开启深度思考 pill）
 * driver 侧 applyConfig 幂等切换模式入口与 pill（先读状态不一致才点击）。 */
/* Public models are defined once in provider-registry.js. */

/** Resolve an OpenAI model id to immutable provider-aware registry metadata. */
function resolveProviderModel(modelId) { return resolveModel(modelId || 'deepseek-chat'); }

/** Browser profiles and logical channels are provider-scoped to prevent cross-site reuse. */
function profileKey(providerId, requestedProfile) {
  if (!getProvider(providerId)) return null;
  const requested = String(requestedProfile || '').trim();
  if (!requested) return defaultProfile(providerId);
  if (providerId === 'deepseek' && requested === 'default') return 'default'; // legacy direct profile
  if (requested.startsWith(providerId + '-')) return requested;
  return providerId + '-' + requested;
}
function channelKey(providerId, pageKey) { return String(providerId || 'deepseek') + ':' + String(pageKey || 'main'); }
function providerProfile(providerId, accountName) {
  const account = String(accountName || '').trim();
  return !account || account === 'default' ? defaultProfile(providerId) : profileKey(providerId, account);
}
function providerFromQuery(searchParams) {
  const providerId = (searchParams.get('provider') || 'deepseek').trim() || 'deepseek';
  return getProvider(providerId) ? providerId : null;
}
function driverErrorResponse(kind, message) {
  const map = {
    challenge_required: [403, 'permission_error', 'provider_challenge_required'],
    login_required: [401, 'authentication_error', 'provider_login_required'],
    mode_unavailable: [422, 'invalid_request_error', 'provider_mode_unavailable'],
    dom_unavailable: [503, 'api_error', 'provider_dom_unavailable'],
    unavailable: [503, 'api_error', 'provider_unavailable'],
  };
  const row = map[kind];
  return row ? { status: row[0], type: row[1], code: row[2], message } : null;
}

/** 网关日志（带时间戳与 [gw] 前缀，stdout）。 */
const GW_DEBUG = !!process.env.DS_WEB_DEBUG;
function log(...a) { console.log('[' + new Date().toISOString().slice(11, 19) + '][gw]', ...a); }
function logDbg(...a) { if (GW_DEBUG) console.log('[' + new Date().toISOString().slice(11, 19) + '][gw][dbg]', ...a); }

/* ---------- driver 生命周期（单一常驻） ---------- */
let D = null;
let driverPromise = null;
let terminating = false;
/* driver 代数（每次 respawn 递增）：会话记录所属代数，失配 → driver 重启过，
 * 网页版会话历史已丢失，该会话下一个请求走 recovery 重建。 */
let driverEpoch = 0;

/** 确保 driver 进程存活（单例 Promise）：不存在/上次启动失败 → 重新拉起。
 * 并发调用复用同一启动 Promise，失败时清空以便下次重试。 */
function ensureDriver() {
  if (!driverPromise) driverPromise = spawnDriver().catch((e) => { driverPromise = null; throw e; });
  return driverPromise;
}

/** 启动 driver 子进程并建立 RPC 通道。
 * - 校验 driver.js 完整性（DRIVER_MARKER）后以 stdio pipe 方式 spawn
 * - 挂载 stdout（RPC 响应/事件分发）、stderr（日志转发）监听
 * - 进程退出：拒绝全部在途 RPC、终结全部流消费者，1.5s 后自动 respawn
 * - driverEpoch 递增：所有旧会话自动 epoch 失配 → 下轮 recovery 重建
 * @returns {Promise<object>} 就绪后的 driver 连接对象（D） */
function spawnDriver() {
  driverEpoch++;
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

/** driver stdout 数据分发（JSON-lines 协议解析）。
 * 按行切分后路由四类消息：
 * - RPC 响应（带 id）：resolve 对应 pending 请求
 * - ready 事件：driver 初始化完成
 * - stream-delta 事件：转发给对应流消费者（伪流式增量）
 * - stream-end 事件：终结对应流消费者（携带 ok/errorKind/result/toolCalls）
 * - channels-reset 事件：profile 切换通知，重置全部会话 epoch */
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
      if (c) c.push(m.delta || '', m.kind);
      logDbg('stream-delta: streamId=' + m.streamId + ' kind=' + (m.kind || 'content') + ' deltaLen=' + (m.delta || '').length);
    } else if (m.event === 'channels-reset') {
      /* driver 因 profile 切换重启浏览器：所有通道的网页版历史已销毁。
       * 把全部会话标记为 epoch 失配 → 各会话下一请求强制 recovery 重建上下文，
       * 否则 delta 增量发进空白页面，模型文不对题（profile 切换的连带伤害）。 */
      log('driver 通道重置（profile ' + (m.from || '?') + ' → ' + (m.to || '?') + '）：全部会话转 recovery');
      for (const s of sessions.values()) s.epoch = -1;
    } else if (m.event === 'stream-end' && m.streamId) {
      const c = d.consumers.get(m.streamId);
      if (c) c.end({ ok: !!m.ok, error: m.error, errorKind: m.errorKind, result: m.result, toolCalls: m.toolCalls });
      logDbg('stream-end: streamId=' + m.streamId + ' ok=' + !!m.ok + ' toolCalls=' + ((m.toolCalls && m.toolCalls.length) || 0) + ' resultLen=' + ((m.result && m.result.length) || 0));
    }
  }
}

/** 轮询等待 driver 就绪（ready 事件），超时抛出（附带 stderr 尾部便于诊断）。 */
function waitReady(d, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (d.ready) return resolve();
    const t = setTimeout(() => reject(new Error('driver not ready: ' + (d.errTail || '').slice(-300))), timeoutMs);
    const iv = setInterval(() => { if (d.ready) { clearTimeout(t); clearInterval(iv); resolve(); } }, 200);
  });
}

/** 调用 driver RPC 方法（请求-响应模式，自增 id 关联）。
 * 通过 stdin 写入 JSON 行，超时（默认 120s）或进程退出时 reject 并清理 pending。
 * 流式方法（streamAsk）的增量结果不经此返回，而是走 makeConsumer 事件通道。
 * @param {string} method RPC 方法名
 * @param {object} params 参数
 * @param {number} [timeoutMs] 超时毫秒
 * @returns {Promise<any>} driver 返回的 result */
function rpc(method, params, timeoutMs) {
  return ensureDriver().then((d) => new Promise((resolve, reject) => {
    const id = ++d.seq;
    const t = setTimeout(() => { d.pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, timeoutMs || 120000);
    d.pending.set(id, { r: resolve, j: reject, t });
    try { d.cp.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n'); }
    catch (e) { d.pending.delete(id); clearTimeout(t); reject(e); }
  }));
}

/** 创建流式事件消费者（streamAsk 的增量/结束事件通道）。
 * push(delta, kind)：driver 侧 stream-delta 到达时入队（或唤醒等待者）；
 *   kind='thinking' 为思考流增量（网关转 reasoning_content），缺省为正文增量；
 * end(info)：stream-end 到达，终结消费者（info 含 ok/errorKind/result/toolCalls）；
 * next()：异步取下一个事件（delta 或结束信息），供 askOnce 循环消费。
 * 内部队列 + 等待者数组实现，事件先到与先等均正确。
 * @param {object} d driver 连接
 * @param {string} streamId driver 侧流标识 */
function makeConsumer(d, streamId) {
  const c = {
    q: [], w: [], ended: false, endInfo: null,
    push(delta, kind) { if (this.ended) return; const w = this.w.shift(); if (w) w({ delta, kind }); else this.q.push({ delta, kind }); },
    end(info) {
      if (this.ended) return;
      this.ended = true;
      this.endInfo = info;
      while (this.w.length) {
        const w = this.w.shift();
        if (w) w(info);
      }
    },
    next() { if (this.q.length) return Promise.resolve(this.q.shift()); if (this.ended) return Promise.resolve(this.endInfo || { ok: false }); return new Promise((r) => this.w.push(r)); },
  };
  d.consumers.set(streamId, c);
  return c;
}

/* ---------- 账号池（多账号 · 限流自动切换核心，SPEC-v2 §5.1/§5.2） ----------
 * 动态风控原则（§0）：无固定配额数值、无固定解冻时间 →
 *  - 受限信号只来自 driver streamAsk 的 errorKind（页面文案检测）
 *  - 恢复策略 = 指数退避（base×2^(n-1) 封顶 max）+ 探测恢复（到期后由真实请求探测）
 * 状态机：active →（二次 quota 确认）→ cooling →（到期）→ probing →（请求成功）→ active
 *          needs_login（登录失效）/ disabled（captcha 或手动禁用，转人工）
 * 落盘 runtime/accounts.json：只含名字/状态/统计，不含任何凭据（FF8）。
 * accountPool=false → 完全旁路（恒用 default，v1 行为）。 */
const pool = {
  accounts: new Map(), // name -> acct 记录
  loginBusy: null,     /* 登录互斥：同时只允许一个登录窗口（Promise 链） */
};

/** 将逻辑账号名映射到 provider 独立的池/profile 键。
 * DeepSeek 继续使用历史 `default`/`acc2` 键，避免升级后丢失既有账号状态；
 * 新 provider 则始终使用 `chatgpt-*` / `qwen-*`，使限流和登录失效不会跨站传播。 */
function providerAccountName(providerId, requestedName) {
  const id = getProvider(providerId) ? providerId : 'deepseek';
  const requested = String(requestedName || 'default').trim() || 'default';
  if (id === 'deepseek') return requested; // legacy DeepSeek names remain stable across the upgrade
  return requested.startsWith(id + '-') ? requested : id + '-' + requested;
}

/** 新建账号记录（内部）。`name` 是唯一池键，也是对应的浏览器 profile 名。 */
function newAcct(name, providerId) {
  return {
    name, providerId: getProvider(providerId) ? providerId : 'deepseek', state: 'active', addedAt: Date.now(),
    backoffCount: 0, cooldownUntil: 0, quotaHits: 0, lastQuotaAt: 0,
    lastUsedAt: 0, requestCount: 0,
  };
}

/** 确保 provider 的逻辑账号存在。首次访问 ChatGPT/Qwen 时创建各自 default，
 * 不把一个站点的 quota/captcha 状态复用于另一个站点。 */
function poolEnsure(providerId, requestedName) {
  const id = getProvider(providerId) ? providerId : 'deepseek';
  const name = providerAccountName(id, requestedName);
  let acct = pool.accounts.get(name);
  if (!acct) {
    acct = newAcct(name, id);
    pool.accounts.set(name, acct);
    poolSave();
  }
  return acct;
}

/** 账号池落盘（原子写：tmp + rename，防写一半损坏）。 */
function poolSave() {
  try {
    const data = { version: 2, accounts: [...pool.accounts.values()].map((a) => ({
      name: a.name, providerId: a.providerId, state: a.state, addedAt: a.addedAt, backoffCount: a.backoffCount,
      cooldownUntil: a.cooldownUntil, quotaHits: a.quotaHits, lastQuotaAt: a.lastQuotaAt,
      lastUsedAt: a.lastUsedAt, requestCount: a.requestCount,
    })) };
    const tmp = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (e) { log('accounts.json 落盘失败: ' + e.message); }
}

/** 账号池加载（启动时；v1 记录默认视作 DeepSeek，损坏/缺失 → 仅 default）。 */
function poolLoad() {
  pool.accounts.clear();
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const a of data.accounts || []) {
      if (!a || !a.name) continue;
      const providerId = getProvider(a.providerId) ? a.providerId : 'deepseek';
      const acct = newAcct(providerAccountName(providerId, a.name), providerId);
      Object.assign(acct, {
        state: ['active', 'cooling', 'probing', 'needs_login', 'disabled'].includes(a.state) ? a.state : 'active',
        addedAt: a.addedAt || Date.now(), backoffCount: a.backoffCount || 0,
        cooldownUntil: a.cooldownUntil || 0, quotaHits: a.quotaHits || 0,
        lastQuotaAt: a.lastQuotaAt || 0, lastUsedAt: a.lastUsedAt || 0,
        requestCount: a.requestCount || 0,
      });
      pool.accounts.set(acct.name, acct);
    }
    log('账号池加载: ' + [...pool.accounts.values()].map((a) => a.name + '(' + a.providerId + '/' + a.state + ')').join(', '));
  } catch (e) { /* 首次运行无文件 */ }
  if (!pool.accounts.has('default')) pool.accounts.set('default', newAcct('default', 'deepseek'));
}

/** 当前退避时长（指数：base × 2^(n-1)，封顶 max）。 */
function backoffMs(count) {
  const b = Math.max(60000, state.quotaBackoffBaseMs);
  const m = Math.max(b, state.quotaBackoffMaxMs);
  return Math.min(b * Math.pow(2, Math.max(0, count - 1)), m);
}

/** 惰性状态刷新：cooling 到期 → probing（探测候选，可被调度选中）。 */
function poolRefresh(acct) {
  if (acct.state === 'cooling' && Date.now() >= acct.cooldownUntil) {
    acct.state = 'probing';
    log('账号 ' + acct.name + ' 退避到期 → probing（探测候选）');
  }
  return acct;
}

/** 受限信号处理（动态风控核心）。 */
function poolMarkQuota(name) {
  const a = pool.accounts.get(name);
  if (!a) return null;
  const now = Date.now();
  a.quotaHits++;
  const inWindow = now - a.lastQuotaAt < state.quotaConfirmWindowMs;
  a.lastQuotaAt = now;
  if (a.state === 'probing') {
    a.backoffCount += 1;
    a.state = 'cooling';
    a.cooldownUntil = now + backoffMs(a.backoffCount);
    log('账号 ' + name + ' 探测失败 → cooling ' + Math.round(backoffMs(a.backoffCount) / 60000) + 'min（退避第 ' + a.backoffCount + ' 次）');
  } else if (a.state === 'active' && inWindow) {
    a.backoffCount = Math.max(1, a.backoffCount + 1);
    a.state = 'cooling';
    a.cooldownUntil = now + backoffMs(a.backoffCount);
    log('账号 ' + name + ' 受限二次确认 → cooling ' + Math.round(backoffMs(a.backoffCount) / 60000) + 'min（退避第 ' + a.backoffCount + ' 次，到期 ' + new Date(a.cooldownUntil).toISOString().slice(11, 19) + '）');
  } else if (a.state === 'active') {
    log('账号 ' + name + ' 首次受限信号（' + Math.round(state.quotaConfirmWindowMs / 60000) + 'min 内再现才确认 cooling）');
  } else {
    log('账号 ' + name + ' 收到受限信号（当前 ' + a.state + '，不改变退避）');
  }
  poolSave();
  return a;
}

/** 请求成功（probing 探测成功 / 登录恢复 / 正常使用）：清零退避回 active（disabled 不自动恢复）。 */
function poolMarkOk(name) {
  const a = pool.accounts.get(name);
  if (!a) return;
  if (a.state !== 'active' && a.state !== 'disabled') {
    log('账号 ' + name + '（' + a.state + '）恢复 → active（退避清零）');
    a.state = 'active';
    a.backoffCount = 0;
    a.cooldownUntil = 0;
    a.lastQuotaAt = 0;
  }
  a.lastUsedAt = Date.now();
  a.requestCount++;
  poolSave();
}

/** captcha / 登录失效标记。kind='captcha' → disabled（转人工）；'login' → needs_login。 */
function poolMarkDown(name, kind) {
  const a = pool.accounts.get(name);
  if (!a) return;
  a.state = kind === 'captcha' ? 'disabled' : 'needs_login';
  log('账号 ' + name + ' → ' + a.state + (kind === 'captcha' ? '（验证码，转人工，可通过 /accounts/enable 重新启用）' : '（登录失效）'));
  poolSave();
}

/** 账号管理操作（/accounts API 用）。 */
function poolAdd(name, providerId) {
  if (!name || !/^[\w-]{1,32}$/.test(name)) throw new Error('账号名无效（字母数字-_，≤32 字符）');
  const id = getProvider(providerId) ? providerId : 'deepseek';
  const accountName = providerAccountName(id, name);
  if (pool.accounts.has(accountName)) throw new Error('账号已存在: ' + accountName);
  const providerCount = [...pool.accounts.values()].filter((a) => a.providerId === id).length;
  if (providerCount >= state.maxAccounts) throw new Error('账号数已达上限 ' + state.maxAccounts + '（可通过 /config 调大 maxAccounts）');
  const a = newAcct(accountName, id);
  a.state = 'needs_login';
  pool.accounts.set(accountName, a);
  poolSave();
  return a;
}
function poolRemove(name, confirm, providerId) {
  const accountName = providerAccountName(providerId || 'deepseek', name);
  const a = pool.accounts.get(accountName);
  if (!a) throw new Error('账号不存在: ' + accountName);
  if (accountName === 'default' || /^(chatgpt|qwen)-default$/.test(accountName)) throw new Error('default 账号不可删除（可 disable）');
  if (!confirm) throw new Error('需 confirm=true（将删除该账号的浏览器 profile 目录，登录态不可恢复）');
  pool.accounts.delete(accountName);
  poolSave();
  return a;
}
function poolSetEnabled(name, enabled, providerId) {
  const accountName = providerAccountName(providerId || 'deepseek', name);
  const a = pool.accounts.get(accountName);
  if (!a) throw new Error('账号不存在: ' + accountName);
  a.state = enabled ? 'needs_login' : 'disabled';
  poolSave();
  return a;
}

/** 可用性判定：active/probing 且不在二次确认窗口内（窗口内 = 刚收到首次信号，优先绕开）。 */
function poolUsable(a) {
  poolRefresh(a);
  if (a.state !== 'active' && a.state !== 'probing') return false;
  if (a.state === 'active' && a.lastQuotaAt && Date.now() - a.lastQuotaAt < state.quotaConfirmWindowMs) return false;
  return true;
}

/** 调度选账号：provider 内 sticky > 当前浏览器 profile > lastUsedAt 最旧。 */
let currentProfile = 'default';
function poolPick(stickyName, exclude, providerId) {
  const id = getProvider(providerId) ? providerId : 'deepseek';
  if (!state.accountPool) return poolEnsure(id, 'default');
  const accounts = [...pool.accounts.values()].filter((a) => a.providerId === id);
  if (!accounts.length) accounts.push(poolEnsure(id, 'default'));
  if (stickyName) {
    const s = pool.accounts.get(providerAccountName(id, stickyName));
    if (s && s.providerId === id && poolUsable(s) && !(exclude && exclude.has(s.name))) return s;
  }
  let best = null;
  let bestCur = null;
  for (const a of accounts) {
    if (!poolUsable(a)) continue;
    if (exclude && exclude.has(a.name)) continue;
    if (!best || a.lastUsedAt < best.lastUsedAt) best = a;
    if (providerProfile(id, a.name) === currentProfile && (!bestCur || a.lastUsedAt < bestCur.lastUsedAt)) bestCur = a;
  }
  return bestCur || best;
}

/** 最早退避到期时间（全受限时给用户的提示信息用）。 */
function poolEarliestRetry(providerId) {
  const id = getProvider(providerId) ? providerId : 'deepseek';
  let min = null;
  for (const a of pool.accounts.values()) {
    if (a.providerId !== id || (a.state !== 'cooling' && a.state !== 'probing')) continue;
    poolRefresh(a);
    if (a.state !== 'cooling') continue;
    if (!min || a.cooldownUntil < min.cooldownUntil) min = a;
  }
  return min;
}

/** 账号池状态描述（/accounts、/health）。 */
function poolDescribe() {
  return {
    enabled: state.accountPool,
    total: pool.accounts.size,
    accounts: [...pool.accounts.values()].map((a) => {
      poolRefresh(a);
      return {
        name: a.name, providerId: a.providerId, state: a.state, backoffCount: a.backoffCount,
        cooldownRemainMs: a.state === 'cooling' ? Math.max(0, a.cooldownUntil - Date.now()) : 0,
        quotaHits: a.quotaHits, requestCount: a.requestCount,
        lastUsedAt: a.lastUsedAt, suspectWindowMs: (a.state === 'active' && a.lastQuotaAt && Date.now() - a.lastQuotaAt < state.quotaConfirmWindowMs) ? state.quotaConfirmWindowMs - (Date.now() - a.lastQuotaAt) : 0,
      };
    }),
  };
}

/** 登录互斥（同时只一个登录窗口）：串行执行登录 rpc。 */
function poolLogin(name, timeoutMs, providerId) {
  const prev = pool.loginBusy || Promise.resolve();
  let done;
  pool.loginBusy = new Promise((r) => { done = r; });
  return prev.then(() => rpc('login', { profile: name, providerId: providerId || 'deepseek', timeoutMs }, timeoutMs + 15000))
    .finally(() => { done(); });
}

poolLoad();

/* ---------- 并发信号量 ---------- */
let semActive = 0;
const semQueue = [];
/* P0 单浏览器模型：多账号时切换 profile 需重启浏览器 → 全局串行；
 * 单账号（或账号池关闭）保持 v1 并发不变（FF1）。P1 多 Chrome 实例后放开。 */
/** 实际生效的并发上限：多账号时退化为 1（单浏览器切 profile 需重启，并发切换会互踩）。 */
function effectiveConcurrent() {
  return (state.accountPool && pool.accounts.size > 1) ? 1 : state.maxConcurrent;
}
/** 槽位释放函数（统一实现，供即时获取与排队获取复用）。 */
function makeSemRelease() {
  return () => { semActive--; const n = semQueue.shift(); if (n) n(); };
}
/** 获取全局生成并发槽位（FIFO 排队，带超时）。
 * - 拿到槽位：返回释放函数，槽位归还时唤醒队首等待者；
 * - 槽位满且 timeoutMs 内未获槽位：reject('concurrency-full')，
 *   调用方据此明确报错返回（而非无限挂起 → DSH 侧「对话阻塞」）。
 * @param {number} [timeoutMs] 排队超时（毫秒）；≤0 或不传则无限等待（兼容旧行为） */
function acquireSem(timeoutMs) {
  if (semActive < effectiveConcurrent()) { semActive++; return Promise.resolve(makeSemRelease()); }
  if (!timeoutMs || timeoutMs <= 0) {
    return new Promise((resolve) => semQueue.push(() => { semActive++; resolve(makeSemRelease()); }));
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const release = makeSemRelease();
    const waiter = () => { if (timer) { clearTimeout(timer); timer = null; } semActive++; resolve(release); };
    timer = setTimeout(() => {
      const i = semQueue.indexOf(waiter);
      if (i >= 0) semQueue.splice(i, 1);
      reject(new Error('concurrency-full'));
    }, timeoutMs);
    semQueue.push(waiter);
  });
}

/* ---------- 会话注册表（并发核心：会话亲和 + 页面通道） ----------
 * 设计：
 * 1. DSH 每轮请求携带完整 messages → 用 system 提示词 + 首条非 ctx user 消息生成指纹，
 *    服务端即可识别"同一逻辑会话"（无需 DSH 配合传会话 ID）
 * 2. 每个会话绑定一个专属网页通道（pageKey → driver 侧固定 tab）：
 *    会话内连续对话（网页版历史保持），不同会话并行（各自通道），互不污染
 * 3. 互斥层次：会话锁（同会话串行——网页版一个会话无法并行生成）
 *    → 全局信号量 maxConcurrent（同时在途生成数上限）
 *    → 通道数上限 maxPages（满则驱逐最久空闲的会话）
 * 4. 生命周期：会话空闲超过 sessionTtlMs → 通道 newChat 清历史后回收复用；
 *    driver 重启（epoch 失配）/通道被回收 → 下个请求走 recovery 压缩重建 */
const sessions = new Map(); // sessionId -> { id, pageKey, fpFull, fpLoose, epoch, busy, lock, lastSeen }
let sessionSeq = 0;
let pageKeySeq = 0;
const freePageKeys = []; // 已回收可复用的通道名（不含 main）
let mainInUse = false;

/** 计算文本指纹（md5 前 16 位，区分会话足够）。 */
function hashText(s) {
  return crypto.createHash('md5').update(String(s || '')).digest('hex').slice(0, 16);
}

/** 提取请求的会话指纹（full + loose 两级）：
 * full  = hash(system + 首条非 ctx user 全文) —— 精确匹配；
 * loose = hash(system + 首条非 ctx user 前 300 字符) —— 宽松匹配，
 *         抗 runtime-context 拼接在首条 user 里且每轮变化导致的指纹漂移。 */
function sessionFingerprint(payload, providerId) {
  const msgs = payload.messages || [];
  const { sysText } = extractBaseline(msgs);
  const inputs = [];
  for (const m of msgs) {
    if (m.role === 'assistant') break;
    if (m.role !== 'user' && m.role !== 'tool') continue;
    const text = blockText(m.content);
    if (!text || isRuntimeContext(text)) continue;
    if (text.indexOf('Current runtime context') === 0) continue; /* ctx 失配兜底：防指纹漂移 */
    const tag = m.role === 'tool' ? '[工具结果]' : '[用户]';
    inputs.push(tag + '\n' + text);
    if (inputs.length >= 3) break; /* 取首批有效输入：比只看首条 user 稳定，仍控制成本 */
  }
  const basis = inputs.join('\n\n');
  return {
    full: hashText(String(providerId || 'deepseek') + '\x00' + sysText + '\x00' + basis),
    loose: hashText(String(providerId || 'deepseek') + '\x00' + sysText + '\x00' + basis.slice(0, 600)),
  };
}

/** 当前占用的通道数（活跃会话的去重 pageKey 数）。 */
function activeChannelCount() {
  const keys = new Set();
  for (const s of sessions.values()) keys.add(s.pageKey);
  return keys.size;
}

/** 回收会话：通知 driver 清通道历史，pageKey 进复用池（main 特殊：常驻不关闭）。 */
async function releaseSession(s) {
  sessions.delete(s.id);
  try {
    await rpc('releaseChannel', { pageKey: s.pageKey, providerId: s.providerId || 'deepseek' }, 15000);
  } catch (e) {
    log('releaseChannel warn (' + s.pageKey + '): ' + e.message);
  }
  if (s.pageKey === 'main') mainInUse = false;
  else freePageKeys.push(s.pageKey);
}

/** 分配一个通道名：优先复用回收池，其次 main，最后新建 ch-N。
 * 通道满（>= maxPages）→ 驱逐最久空闲的非 busy 会话（30s 内活跃的不驱逐）；
 * 无可驱逐 → 轮询等待（会话完成/TTL 回收会释放）；总超时 5 分钟报错。 */
async function allocPageKey() {
  const deadline = Date.now() + 300000;
  for (;;) {
    if (freePageKeys.length) return freePageKeys.pop();
    if (!mainInUse) { mainInUse = true; return 'main'; }
    if (activeChannelCount() < state.maxPages) return 'ch-' + (++pageKeySeq);
    /* 通道满：找最久未使用且空闲的会话驱逐 */
    const now = Date.now();
    let victim = null;
    for (const s of sessions.values()) {
      if (s.busy || now - s.lastSeen < 30000) continue;
      if (!victim || s.lastSeen < victim.lastSeen) victim = s;
    }
    if (victim) {
      log('通道满，驱逐空闲会话 ' + victim.id + '（通道 ' + victim.pageKey + '，闲置 ' + Math.round((now - victim.lastSeen) / 1000) + 's）');
      await releaseSession(victim);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error('并发会话过多：通道数已达上限 ' + state.maxPages + '（可通过 POST /config 调大 maxPages）');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 解析请求所属会话（并发核心入口）。
 * - 首轮（messages 无 assistant 历史）→ 新建会话 + 分配专属通道，mode='first'
 * - 后续轮 → 两级指纹匹配已有会话：
 *   命中且 epoch 一致 → mode='delta'（网页版历史保持，只发增量）
 *   命中但 epoch 失配（driver 重启过）→ mode='recovery'（网页历史已丢，压缩重建）
 *   未命中（通道被 TTL 回收/驱逐/网关重启）→ 孤儿会话，mode='recovery'
 * @param {object} payload OpenAI chat/completions 请求体
 * @returns {Promise<{session: object, mode: string}>}
 */
async function resolveSession(payload, providerId) {
  const fp = sessionFingerprint(payload, providerId);
  if (!isNewConversation(payload)) {
    for (const s of sessions.values()) {
      if (s.fpFull === fp.full || s.fpLoose === fp.loose) {
        const mode = s.epoch !== driverEpoch ? 'recovery' : 'delta';
        s.epoch = driverEpoch;
        s.lastSeen = Date.now();
        return { session: s, mode };
      }
    }
  }
  const pageKey = await allocPageKey();
  const s = {
    id: 's' + (++sessionSeq), pageKey, channelId: channelKey(providerId, pageKey), providerId, fpFull: fp.full, fpLoose: fp.loose,
    epoch: driverEpoch, busy: false, lock: null, lastSeen: Date.now(),
    acctName: null, /* 会话-账号粘性绑定（SPEC-v2 §5.2 调度第 1 步） */
  };
  sessions.set(s.id, s);
  log('新会话: ' + s.id + ' 通道=' + pageKey + '（活跃通道 ' + activeChannelCount() + '/' + state.maxPages + '）');
  return { session: s, mode: isNewConversation(payload) ? 'first' : 'recovery' };
}

/** 获取会话互斥锁（同一会话串行：网页版一个会话同时只能有一轮生成）。
 * 返回释放函数；上一个在途请求完成前，本请求在此排队。 */
function acquireSessionLock(s) {
  const prev = s.lock || Promise.resolve();
  let release;
  s.lock = new Promise((r) => { release = r; });
  s.busy = true;
  s.lastSeen = Date.now();
  return prev.then(() => release);
}

/** 空闲会话回收定时器：超过 sessionTtlMs 无请求的会话 → 通道清历史回收复用。 */
setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.busy || now - s.lastSeen < state.sessionTtlMs) continue;
    log('会话 ' + s.id + '（通道 ' + s.pageKey + '）空闲超时回收');
    releaseSession(s).catch(() => {});
  }
}, 60000).unref();

/* ---------- 提示词组装 ---------- */
/** 把 OpenAI 多模态消息内容（string / blocks 数组）压成纯文本。
 * text 块取文本；tool-call 块压成占位标记；tool-result 块截断到 2000 字
 * （网页版输入框对超长文本发送失败，工具结果只需模型知道要点）。 */
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

/** 识别 DSH 注入的 runtime context 快照消息。
 * 文案随 approval 策略变化：ask → "Approval policy: ..."；
 * never → "Approval prompts are disabled ..."（不含 "Approval policy" 字样）。
 * 判定改为多特征任一命中——单一关键词失配曾导致 ctx 被误当用户消息、
 * 首轮用户问题丢失（模型只回"运行环境信息已更新"）。 */
function isRuntimeContext(text) {
  if (typeof text !== 'string' || text.indexOf('Current runtime context') !== 0) return false;
  return text.indexOf('runtime-context snapshot') > 0 ||
    text.indexOf('DSH file policy') > 0 ||
    text.indexOf('Approval policy') > 0 ||
    text.indexOf('Approval prompts are disabled') > 0;
}

/** 超长文本截断（网页版输入框对超长文本会发送失败，必须限长保护）。 */
function clipText(text, max, tag) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…(' + tag + '过长已截断)';
}

/**
 * 判断是否为 DSH 新会话的首轮请求：messages 中尚无任何 assistant 回复。
 * 首轮 → 新建网页会话，一次性下发 system + runtime context + 工具说明 + 用户消息；
 * 后续轮（工具循环 / 多轮对话）→ 网页版页面自己保留历史，只发增量。
 * @param {object} payload OpenAI chat/completions 请求体
 * @returns {boolean} true 表示新会话首轮
 */
function isNewConversation(payload) {
  const msgs = payload.messages || [];
  return !msgs.some((m) => {
    if (m.role !== 'assistant') return false;
    const text = blockText(m.content);
    return !!text || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
  });
}

/** 从 messages 中提取 system/developer 提示词与 runtime context（首轮/重建时注入网页版用）。 */
function extractBaseline(msgs) {
  let sysText = '';
  let ctxText = '';
  for (const m of msgs) {
    const text = blockText(m.content);
    if (!text) continue;
    if (isRuntimeContext(text)) ctxText = ctxText ? ctxText + '\n\n' + text : text;
    else if (m.role === 'system' || m.role === 'developer') sysText = sysText ? sysText + '\n\n' + text : text;
  }
  return { sysText, ctxText };
}

/**
 * 组装发给网页版的文本（核心会话策略）。
 * mode='first'    新会话首轮：system + runtime context + 用户消息一次性灌入（网页版建立上下文）；
 * mode='delta'    后续轮：仅最后一条增量（用户消息或工具结果），历史由网页版自己保留；
 * mode='recovery' driver 重启后网页历史已丢失：system + runtime context + 压缩后的最近对话，重建上下文。
 * @param {object} payload OpenAI chat/completions 请求体
 * @param {string} mode first | delta | recovery
 * @returns {string} 发送给网页版的文本（空串表示无可发送内容）
 */
function buildContext(payload, mode, toolsText) {
  const msgs = payload.messages || [];
  if (mode === 'first' || mode === 'recovery') {
    const { sysText, ctxText } = extractBaseline(msgs);
    const parts = [];
    if (sysText) parts.push('[系统设定]\n' + clipText(sysText, mode === 'first' ? 8000 : 4000, '系统设定'));
    if (ctxText) parts.push(clipText(ctxText, mode === 'first' ? 6000 : 3000, '运行时上下文'));
    if (mode === 'recovery') {
      /* 压缩最近对话（assistant 短些，user/tool 长些，整体限长），让网页版恢复到中断前的状态 */
      const body = [];
      for (const m of msgs) {
        if (m.role === 'system' || m.role === 'developer') continue;
        const text = blockText(m.content);
        if (!text || isRuntimeContext(text)) continue;
        if (text.indexOf('Current runtime context') === 0) continue; /* ctx 失配兜底：不进压缩历史 */
        const tag = m.role === 'user' ? '[用户]' : m.role === 'assistant' ? '[助手]' : '[工具结果]';
        body.push(tag + '\n' + clipText(text, m.role === 'assistant' ? 400 : 800, m.role));
      }
      if (body.length) {
        parts.push('[此前的对话（网页会话中断，以下是压缩后的记录，请据此继续）]\n' + clipText(body.slice(-10).join('\n\n'), 8000, '对话历史'));
      }
      /* 工具协议块放最后（紧邻回复点）：sys → ctx → 历史 → 工具 */
      if (toolsText) parts.push(toolsText);
    } else {
      /* 首轮：收集 ALL 非 system/runtime-context 的 user/tool 消息（按时间顺序）。
       * 旧版只取最后一条 user——DSH 首轮发多条 user 消息（如"项目背景"+
       * "参考资料"+"实际问题"）时前面全丢，上下文不完整导致模型回答驴唇不对马嘴。
       * isRuntimeContext + 字符串前缀双保险，绝不把 runtime ctx 当用户输入。 */
      const body = [];
      for (const m of msgs) {
        if (m.role === 'system' || m.role === 'developer') continue;
        const text = blockText(m.content);
        if (!text || isRuntimeContext(text)) continue;
        if (text.indexOf('Current runtime context') === 0) continue;
        const tag = m.role === 'user' ? '[用户]' : m.role === 'tool' ? '[工具结果]' : '[' + m.role + ']';
        body.push(tag + '\n' + text);
      }
      if (body.length) parts.push(body.join('\n\n'));
      /* 工具协议块插在回复点（body 最后一段消息）之前：格式指令离回复点最近，
       * 注意力最强，工具协议遵守率最高；无 body 则直接追加。 */
      if (toolsText) {
        if (body.length) parts.splice(parts.length - 1, 0, toolsText);
        else parts.push(toolsText);
      }
    }
    return parts.join('\n\n');
  }
  /* delta：从后往前取第一条有效增量（最后一条通常是 tool 结果或用户新消息），
   * 跳过 system 与 runtime context——这些首轮已注入，网页版历史里已有，
   * 绝不把 DSH 完整历史灌进网页版（超长会发送失败）。 */
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant') return ''; /* 末尾无新输入（协议异常），不发 */
    if (m.role === 'system' || m.role === 'developer') continue;
    const text = blockText(m.content);
    if (isRuntimeContext(text)) continue; /* 轮中更新的 runtime context：跳过，继续找真正的输入 */
    if (text && text.indexOf('Current runtime context') === 0) continue; /* ctx 失配兜底 */
    if (!text && m.role !== 'tool') continue;
    const tag = m.role === 'user' ? '[用户]' : m.role === 'tool' ? '[工具结果]' : '[' + m.role + ']';
    return tag + '\n' + text;
  }
  return '';
}

/**
 * 组装工具提示词（提示工程核心——模型只靠这段话学会工具调用协议）。
 * 优化点（相对旧版）：
 *   1. 每工具描述压缩（句子边界截断 ~110 字）——30+ 工具时全部工具名保得住，
 *      旧版不裁剪描述靠 driver 端全局截断，尾部工具被整体截掉（模型不知道它们存在）；
 *   2. 参数带类型与枚举：`file_path(必填,string)` / `mode(string: fast|slow)`，
 *      旧版只有名字，模型猜不到值类型；
 *   3. 示例从真实工具生成（取参数最少的）——旧版硬编码 "write" 工具 + Windows
 *      路径，不在工具列表里 = 邀请幻觉调用；
 *   4. 说明 [工具结果] 回传标签（delta 轮以此标记，模型需提前建立对应关系）；
 *   5. 明确"无需工具直接文本回答"分支，防过度调用；
 *   6. 总预算 5500：先压描述、再砍示例，工具清单永不牺牲。
 * @param {Array} tools OpenAI tools 数组
 * @returns {string} 工具提示词（无工具返回空串）
 */
function buildToolsText(tools) {
  if (!tools || !tools.length) return '';
  const FENCE = '```';
  const BUDGET = 5500;

  /* 单工具描述压缩：首句优先，超长截到句子/标点边界 */
  function clipDesc(s, max) {
    const t = String(s || '').trim().replace(/\s+/g, ' ');
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const m = cut.match(/^(.*[。.!?;；])/); /* 最后一个句末标点 */
    return (m && m[1].length > max * 0.5 ? m[1] : cut) + '…';
  }

  /* 参数规格：name(必填,type) / name(string: a|b|c) */
  function paramSpec(fn) {
    try {
      const props = (fn.parameters && fn.parameters.properties) || {};
      const req = (fn.parameters && fn.parameters.required) || [];
      const specs = Object.keys(props).map((k) => {
        const p = props[k] || {};
        let s = k + (req.includes(k) ? '(必填,' : '(') + (p.type || 'any');
        if (Array.isArray(p.enum) && p.enum.length) {
          s += ':' + p.enum.slice(0, 5).map(String).join('|') + (p.enum.length > 5 ? '|…' : '');
        }
        return s + ')';
      });
      return specs.length ? '  参数: ' + specs.join(', ') : '';
    } catch (e) { return ''; }
  }

  const head = [
    '你可以调用工具来完成用户任务。工具由系统执行，你只负责输出调用指令。',
    '',
    '当你需要调用工具时，你的整个回复必须 ONLY 是一个 tool_call 代码块——前后不要有任何文字、解释或标点：',
    '',
    FENCE + 'tool_call',
    '{',
    '  "name": "工具名",',
    '  "args": {',
    '    "参数": "值"',
    '  }',
    '}',
    FENCE,
    '',
    '关键规则：',
    '- 需要工具时整个回复 ONLY 代码块（无散文）；不需要工具时直接用纯文本回答。',
    '- 一次只调用一个工具。必须包含 "name" 和 "args" 两个键，参数值类型按下方标注。',
    '- 工具执行结果会以 [工具结果] 标签回传给你；收到后继续调用下一个工具或给出最终回答。',
    '- 任务完成后用纯文本作答（不要输出代码块）。',
    '',
    '可用工具：',
  ];

  /* 工具清单构建（descMax 控制描述与参数行的保留度，供渐进降级）：
   * 110=全量描述+参数；30=短描述+参数；0=仅工具名。
   * 渐进降级保证总长受 BUDGET 硬上限约束——旧实现 body 无上限，30+ 工具时
   * 总长轻松破万，触发网页版超长发送失败（toolsText 6000 截断的教训）。 */
  const buildBody = (descMax) => {
    const lines = [];
    for (const t of tools) {
      const fn = t.function || t;
      lines.push('- ' + (fn.name || '?') + (descMax > 0 ? ': ' + clipDesc(fn.description, descMax) : ''));
      if (descMax > 0) {
        const ps = paramSpec(fn);
        if (ps) lines.push(ps);
      }
    }
    return head.join('\n') + '\n' + lines.join('\n');
  };
  let body = buildBody(110);
  if (body.length > BUDGET) body = buildBody(30);
  if (body.length > BUDGET) body = buildBody(0);

  /* 示例：从真实工具生成（参数最简单的优先），构造类型合法的 args */
  function realExample() {
    let best = null;
    let bestN = Infinity;
    for (const t of tools) {
      const fn = t.function || t;
      if (!fn.name) continue;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const req = (fn.parameters && fn.parameters.required) || [];
      /* 只要必填参数个数最少的（且 ≤3，示例简洁） */
      if (req.length < bestN && req.length <= 3) { best = { fn, props, req }; bestN = req.length; }
    }
    if (!best) return '';
    const args = {};
    for (const k of best.req) {
      const p = best.props[k] || {};
      if (Array.isArray(p.enum) && p.enum.length) args[k] = p.enum[0];
      else if (p.type === 'number' || p.type === 'integer') args[k] = 1;
      else if (p.type === 'boolean') args[k] = false;
      else if (p.description) args[k] = String(p.description).slice(0, 20); /* 描述当值：比"示例值"更有信息量 */
      else args[k] = '示例值';
    }
    return FENCE + 'tool_call\n' + JSON.stringify({ name: best.fn.name, args }, null, 2) + '\n' + FENCE;
  }

  const example = realExample();
  /* 预算控制：超限时牺牲示例（工具清单永不截断——名字不可见=模型不会用） */
  if (body.length + example.length + 20 > BUDGET) {
    return body + '\n（工具说明已达长度上限，省略示例；严格按上方格式输出）';
  }
  return body + '\n\n调用示例（真实工具）：\n' + example;
}

/* ---------- SSE 输出 ---------- */
/** 写 SSE 响应头（text/event-stream，附 CORS）。只能在响应开始前调用一次
 * —— headersSent 守卫依赖此约定（异常路径二次 writeHead 会抛错导致连接悬挂）。 */
function sseHeaders(res) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    /* no-transform 防反代压缩改写 SSE 帧；no-cache 防中间缓存 */
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    /* 禁用 nginx 等反代缓冲 SSE：否则多包被合并成大块，表现为「内容攒齐后一起输出」 */
    'X-Accel-Buffering': 'no',
  });
  /* 禁用 Nagle 算法：每个 chunk 立即发包，避免小帧被 TCP 合并导致流式延迟 */
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
}
/** 写一条 SSE data 帧（OpenAI chunk 格式由调用方构造）。 */
function sseChunk(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

/* ---------- 核心：一次模型调用 ---------- */
/** 判断流式首段文本是否像工具调用（提示工程 JSON——网页版无原生 function calling）。
 * 命中 → 该轮正文静默累计不转发（工具 JSON 不外泄进 content，
 * DSH 只应收到终态 tool_calls chunks）。
 * 误判代价 = 该轮退回一次性输出（终态全量补发），无正确性风险。
 *
 * v2 修复：减少误判导致 silent 卡死——
 * 1. 仅当文本以 ```tool_call 或 ```json 开头时才判定（模型被提示工程约束只输出这两种格式）
 * 2. 裸 JSON（不以代码块开头）仅在同时含 name+args 且不含散文特征时判定
 * 3. 排除代码块内的 JSON 示例（前面有文字说明的） */
function looksLikeToolCallText(t, tools) {
  const s = String(t || '').trim();
  if (!s) return false;
  function matchToolByParamsStrict(j) {
    if (!tools || !Array.isArray(tools) || !j || typeof j !== 'object' || Array.isArray(j)) return null;
    const keys = Object.keys(j).filter((k) => k !== 'name' && k !== 'arguments' && k !== 'function' && k !== 'tool');
    if (!keys.length) return null;
    const PARAM_ALIAS = { path: 'file_path', file: 'file_path', filepath: 'file_path', filename: 'file_path', cmd: 'command', code: 'command', script: 'command', text: 'content', data: 'content', body: 'content' };
    let best = null, bestScore = 0, tied = false;
    for (const tool of tools) {
      const fn = tool.function || tool;
      if (!fn || !fn.name) continue;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const propKeys = Object.keys(props);
      if (!propKeys.length) continue;
      let score = 0, hit = 0, miss = 0;
      for (const k of keys) {
        if (propKeys.includes(k)) { score += 2; hit++; }
        else if (propKeys.includes(PARAM_ALIAS[k] || '')) { score += 2; hit++; }
        else { score -= 1.5; miss++; }
      }
      if (miss > hit) continue;
      if (keys.length > 1 && miss > 0) continue;
      score += (hit / propKeys.length) * 2;
      if (hit > 0 && score > bestScore) { bestScore = score; best = fn.name; tied = false; }
      else if (hit > 0 && score === bestScore && score > 0 && best && best !== fn.name) tied = true;
    }
    if (tied) return null;
    return bestScore >= 2 ? best : null;
  }
  if (/^```tool_call/i.test(s)) return true;
  if (/^<tool_calls>/i.test(s) || /^<invoke\b/i.test(s)) return true;
  if (/^<tool_call>\s*\{/.test(s) || /^<tool_call>function/.test(s)) return true;
  /* 裸 tool_call 标记：只在回复起始位置命中，避免把解释性散文误判成工具调用 */
  if (/^tool_call\b/i.test(s)) return true;
  /* ```json 代码块：必须是代码块起始且含 name+args 特征，防正文里引用 JSON 示例 */
  if (/^```json/i.test(s)) {
    const body = s.replace(/^```json\s*\n?/i, '');
    if (/"name"\s*:/.test(body.slice(0, 500)) && (/"args"\s*:/.test(body.slice(0, 500)) || /"arguments"\s*:/.test(body.slice(0, 500)))) return true;
    try {
      const obj = JSON.parse(body.replace(/```\s*$/m, '').trim());
      if (matchToolByParamsStrict(obj)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  /* 无代码块的裸 JSON：仅当同时含 name+args 且无散文特征时判定。
   * 对纯参数 JSON，仅在唯一匹配到已授权工具时才命中，避免误把普通 JSON 静默吞掉。 */
  if (s.startsWith('{')) {
    const head = s.slice(0, 300);
    const hasName = /"name"\s*:/.test(head);
    const hasArgs = /"args"\s*:/.test(head) || /"arguments"\s*:/.test(head);
    if (hasName && hasArgs) {
      const hasProse = /\n[^"{\[\s]/.test(head) || /\.\s+[A-Z]/.test(head) || /^#{1,6}\s/.test(head);
      if (!hasProse) return true;
    }
    try {
      const obj = JSON.parse(s.length > 2000 ? s.slice(0, 2000) + '}' : s);
      if (obj && (obj.tool !== undefined || obj.function !== undefined)) return true;
      if (matchToolByParamsStrict(obj)) return true;
    } catch (e) { /* incomplete JSON, already checked above */ }
  }
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s.length > 2000 ? s.slice(0, 2000) + ']' : s);
      if (Array.isArray(arr) && arr.length > 0 && arr[0] && (arr[0].name !== undefined || arr[0].tool !== undefined)) return true;
      if (Array.isArray(arr) && arr.length === 1 && arr[0] && matchToolByParamsStrict(arr[0])) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

/** 判断短缓冲是否仍可能拼成支持的工具调用标记。
 * 仅在首个分片尚不完整时短暂延迟，避免将 `` ` `` / `<` / `tool_`
 * 等前缀先作为 content 发出，后续又以 tool_calls 结束同一轮。 */
function isPossibleToolCallPrefix(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s || s.length > 96) return false;
  const prefixes = [
    '`', '``', '```', '```t', '```to', '```too', '```tool', '```tool_', '```tool_c', '```tool_ca', '```tool_cal',
    '```j', '```js', '```jso',
    '<', '<t', '<to', '<too', '<tool', '<tool_', '<tool_c', '<tool_ca', '<tool_cal', '<tool_call', '<tool_call>', '<tool_calls', '<tool_calls>',
    '<i', '<in', '<inv', '<invo', '<invok', '<invoke',
    't', 'to', 'too', 'tool', 'tool_', 'tool_c', 'tool_ca', 'tool_cal', 'tool_call',
    '{', '[',
  ];
  return prefixes.includes(s);
}

/** 校验 OpenAI chat/completions 请求。此校验必须发生在 SSE/driver 之前，
 * 这样无效请求始终获得 JSON 错误，且不会启动浏览器或污染会话。 */
function validateChatPayload(payload, allowWorkBuddy) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, code: 'invalid_request', message: 'request body must be a JSON object' };
  }
  const isWorkBuddy = !!allowWorkBuddy && payload.model === 'workbuddy-agent';
  if (typeof payload.model !== 'string' || (!isWorkBuddy && !resolveProviderModel(payload.model))) {
    return { status: 404, code: 'model_not_found', message: 'model not found: ' + String(payload.model || '') };
  }
  const msgs = payload.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.some((m) => !m || typeof m !== 'object' || Array.isArray(m) || typeof m.role !== 'string' || !m.role)) {
    return { status: 400, code: 'invalid_messages', message: 'messages must be a non-empty array of role-bearing objects' };
  }
  return null;
}
/**
 * 处理 /v1/chat/completions（网关主流程，OpenAI 兼容契约的唯一实现点）。
 * 流程：会话识别 → 会话锁/信号量 → 账号调度 → askOnce 循环
 * （buildContext + rpc streamAsk + 等 stream-end，errorKind 触发换号 recovery 重试）
 * → SSE/JSON 输出 → 释放资源。
 * 关键防线：非流式聚合 JSON；客户端断开停止生成；异常路径 epoch=-1 + [DONE]；
 * askOnce 20min 兜底超时（防 driver 卡死锁死会话锁）。
 * @param {object} req HTTP 请求
 * @param {object} res HTTP 响应
 * @param {object} payload 已解析的请求体（model/messages/tools/stream）
 */
async function handleChatCompletion(req, res, payload, resolvedModel) {
  const validation = validateChatPayload(payload);
  if (validation) {
    return sendJson(res, { error: { message: validation.message, type: 'invalid_request_error', code: validation.code } }, validation.status);
  }
  const model = payload.model;
  /* `resolvedModel` is an optional server-side cache only; never let a mismatched
   * caller-selected record route a request to another provider/model. */
  const cfg = resolvedModel && resolvedModel.id === model ? resolvedModel : resolveProviderModel(model);
  if (!cfg) return sendJson(res, { error: { message: 'unknown model: ' + model, type: 'invalid_request_error', code: 'model_not_found' } }, 404);
  const created = Math.floor(Date.now() / 1000);
  const cid = 'chatcmpl-' + created;
  /* OpenAI 兼容：stream=false → 完整 JSON 响应（旧实现一律 SSE，非流式客户端解析必炸） */
  const wantStream = payload.stream !== false;
  const sendChunk = (obj) => sseChunk(res, obj);
  /* 输出抽象：流式边收集边推送；非流式只收集，最后一次性 JSON 返回 */
  const out = { text: '', tools: [] };
  /* v3 真流式状态（askOnce 每轮重置）：
   * - accContent：本轮正文累计（终态前缀对齐补尾的基准）
   * - toolMode：buffer=攒首段判工具 / stream=正文直通 / silent=像工具 JSON 静默累计
   *   （网页版工具调用是提示工程 JSON 文本，外泄进 content 会污染 DSH 显示）
   * - toolBuf：buffer 模式的首段缓冲 */
  let accContent = '';
  let toolMode = 'buffer';
  let toolBuf = '';
  let silentStart = 0; /* silent 模式开始时间（超时回退 stream 用） */
  const SILENT_TIMEOUT_MS = 60000; /* silent 模式最长等待 60s，超时回退 stream */
  let finished = false; /* 响应已结束（客户端断开检测用） */
  let curStreamId = null; /* driver 侧当前 streamId（客户端断开时停止生成） */
  const emitText = (t) => {
    if (t === undefined || t === null) return;
    out.text += t;
    if (wantStream) sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
  };
  const emitTool = (i, tc) => {
    out.tools.push(tc);
    if (wantStream) sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] });
  };
  const emitToolArgs = (i, args) => {
    if (wantStream) sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args } }] }, finish_reason: null }] });
  };
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (wantStream) {
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sendJson(res, {
        id: cid, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: out.text || null, tool_calls: out.tools.length ? out.tools : undefined }, finish_reason: reason }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  };
  const apiError = (status, type, message, code) => ({
    error: {
      message: String(message || 'unknown error'),
      type: type || 'api_error',
      code: code || undefined,
    },
  });
  const failJson = (status, type, message, code) => {
    if (wantStream) {
      emitText('[错误] ' + String(message || 'unknown'));
      finish('stop');
      return;
    }
    finished = true;
    sendJson(res, apiError(status, type, message, code), status);
  };
  /* 客户端断开（DSH 取消/超时）：停止 driver 侧生成，别让浏览器空转 4 分钟。
   * 防御：非 http req（测试 fake）无 on 方法时跳过 */
  if (req && typeof req.on === 'function') {
    req.on('close', () => {
      if (finished || !curStreamId) return;
      log('客户端断开，停止生成 streamId=' + curStreamId);
      rpc('streamStop', { streamId: curStreamId }, 5000).catch(() => {});
    });
  }
  let session0 = null; /* 当前请求绑定的会话（try 内赋值，finally 刷新/解锁） */
  let releaseLock = null; /* 会话锁释放（try 内赋值，finally 防御性释放） */
  let release = null; /* 信号量释放（同上） */
  try {
    /* 先抢全局生成并发槽位：槽位满则在 SEM_WAIT_TIMEOUT_MS 内排队，超时明确报错返回
     * （而非无限挂起——后者在 DSH 侧表现为「对话阻塞」）。放在会话解析之前，
     * 避免排队的请求提前分配页面通道、占用 maxPages 名额、甚至误驱逐健康空闲会话。 */
    try {
      release = await acquireSem(SEM_WAIT_TIMEOUT_MS);
    } catch (e) {
      const limit = effectiveConcurrent();
      log('并发槽位等待超时（' + Math.round(SEM_WAIT_TIMEOUT_MS / 1000) + 's，并发上限 ' + limit + '）：明确报错返回，避免请求无限挂起');
      if (wantStream) {
        sseHeaders(res);
        sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      }
      return failJson(429, 'rate_limit_error', '[并发已满] 当前 DeepSeek 网页版并发上限为 ' + limit + '，请求排队超过 ' + Math.round(SEM_WAIT_TIMEOUT_MS / 1000) + 's 仍未获得生成槽位。可能原因：其他对话正在跑长任务（智能搜索+深度思考/工具循环）或 driver 卡住。可稍后重试，或通过 POST /config 调大 maxConcurrent（注意：多账号下会退化为 1）。', 'concurrency_full');
    }
    /* 会话解析（并发核心：指纹识别 → 专属通道绑定）。
     * mode: first=新会话首轮 / delta=增量（网页版历史保持） / recovery=压缩重建 */
    const { session, mode } = await resolveSession(payload, cfg.providerId);
    session0 = session;
    log('会话: ' + session.id + ' 通道=' + session.pageKey + ' mode=' + mode + ' msgs=' + (payload.messages || []).length);
    releaseLock = await acquireSessionLock(session); /* 同一会话串行 */
    const d = await ensureDriver();
    /* 账号调度（SPEC-v2 §5.2）：会话粘性 → 当前浏览器 profile（避免重启）→ 最旧；无可用 → 429 语义提示 */
    let acct = poolPick(session.acctName, null, cfg.providerId);
    if (!acct) {
      const er = poolEarliestRetry(cfg.providerId);
      const msg = er
        ? '[账号暂时受限] 所有账号均在指数退避中（动态风控无固定解冻时间，到期后由真实请求探测恢复）。最早探测时间约 ' + Math.max(1, Math.ceil((er.cooldownUntil - Date.now()) / 60000)) + ' 分钟后。可稍后重试，或通过 POST /accounts/add 添加账号。'
        : '[无可用账号] 全部账号未登录或已禁用。请打开 http://127.0.0.1:5688/login 登录，或通过 /accounts 管理账号。';
      log('无可用账号: ' + msg);
      if (wantStream) {
        sseHeaders(res);
        sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      }
      /* 本次未向 driver 发送任何内容：通道页面不存在，下轮必须走 recovery 重建
       * （否则 delta 增量发进 ensureChannelPage 新建的空白页，模型文不对题） */
      session0.epoch = -1;
      return failJson(er ? 429 : 401, er ? 'rate_limit_error' : 'authentication_error', msg, er ? 'all_accounts_cooling' : 'no_available_account');
    }
    session.acctName = acct.name;
    log('账号: ' + acct.name + (acct.state === 'probing' ? '（probing 探测）' : '') + ' mode=' + mode);
    /* 单次 streamAsk（带 profile 账号绑定）。v3 真流式：driver 轮询差分的
     * stream-delta 实时转发为 SSE chunk（正文 content / 思考 reasoning_content），
     * 终态与已发增量前缀对齐补尾。限流文案 driver 侧检测先行（先检测后发增量）
     * → 切号重试不会产生残留文本污染。 */
    const askOnce = async (profileName, askMode) => {
      /* 切号重试轮重置：新一轮从零累计（客户端看到上一轮已流出内容 + 本轮完整流式） */
      accContent = ''; toolMode = 'buffer'; toolBuf = ''; silentStart = 0;
      /* 工具提示词：first/recovery 随首包注入（网页版此时是空白会话），
       * delta 不重复携带——网页版历史里已有首轮的工具说明。
       * 工具块由 buildContext 内嵌到 [用户] 之前（位置优化），不再单独传 driver。 */
      const toolsText = askMode === 'delta' ? '' : buildToolsText(payload.tools);
      const q = buildContext(payload, askMode, toolsText);
      /* 无可发送内容（协议异常：末尾无新输入）→ 显式报错而非静默空回复。
       * 网页版页面从未收到消息，绝不能当成功（poolMarkOk 会污染账号统计，
       * 且空回复让 DSH 侧无从排查）。 */
      if (!q) return { evt: { ok: false, error: 'nothing to send: messages 末尾无新输入（协议异常）' } };
      /* 模式联动：driver 每次请求幂等应用 pill 开关（2026-08 页面重构后
       * 无模型选择器）。calibKey=model 保留为 pill 未找到时的校准回放 fallback。 */
      const { streamId } = await rpc('streamAsk', {
        question: q, providerId: cfg.providerId, model: cfg, mode: cfg.mode, deepThink: cfg.deepThink, search: cfg.search === true,
        headless: state.headless, tools: payload.tools,
        /* 会话亲和：driver 侧把 pageKey 固定映射到同一浏览器 tab */
        pageKey: session.pageKey,
        /* 多账号：driver 按 profile 绑定浏览器 user-data-dir（cookie 隔离） */
        profile: providerProfile(cfg.providerId, profileName),
        /* first/recovery → 强制 newChat（清掉网页版残留的旧会话，避免上下文污染）；
         * delta → 'auto'（续当前会话，超限 driver 自动迁移+摘要）。 */
        reset: askMode === 'delta' ? 'auto' : true,
        calibKey: model, maxTurnsPerChat: state.maxTurnsPerChat,
      }, 30000);
      curStreamId = streamId; /* 客户端断开时据此停止 driver 侧生成 */
      const consumer = makeConsumer(d, streamId);
      /* 兜底超时：driver 进程 hang（不死不退、stdio 堵塞）时 stream-end 永不到达，
       * consumer.next() 永久挂起 → 会话锁/信号量永不释放 → 该会话后续请求全部
       * 排队饿死。driver 正常路径最长 ≈3×240s 重试 + 前置开销 ≈13min，20min 兜底足够宽。 */
      let evt;
      let waitTimer = null;
      const waitTimeout = new Promise((r) => { waitTimer = setTimeout(() => r({ __waitTimeout: true }), ASK_WAIT_TIMEOUT_MS); });
      try {
        for (;;) {
          evt = await Promise.race([consumer.next(), waitTimeout]);
          if (evt.__waitTimeout) {
            evt = { ok: false, error: 'gateway timeout: 等待 driver 流式结果超时（' + Math.round(ASK_WAIT_TIMEOUT_MS / 60000) + 'min，driver 可能已卡死）' };
            break;
          }
          /* v3 真流式核心：仅正文/工具相关增量对 DSH 可见；thinking 仅供 driver
           * 内部完成判定使用，在网关层静默，不再转 reasoning_content。 */
          if (evt.delta !== undefined) {
            if (evt.kind === 'thinking') {
              continue;
            } else {
              accContent += evt.delta;
              if (wantStream) {
                let emitCurrentDelta = true;
                if (toolMode === 'buffer') {
                  toolBuf += evt.delta;
                  if (looksLikeToolCallText(toolBuf, payload.tools) && toolBuf.length < 400) {
                    toolMode = 'silent';
                    silentStart = Date.now();
                    emitCurrentDelta = false;
                    log('toolMode → silent (toolBuf[:80]=' + toolBuf.slice(0, 80).replace(/\n/g, '\\n') + ')');
                  } else if (isPossibleToolCallPrefix(toolBuf)) {
                    /* 标记可能跨 delta 才完整；在此之前不能把前缀泄漏为 content。 */
                    emitCurrentDelta = false;
                  } else {
                    toolMode = 'stream';
                    log('toolMode → stream (toolBuf len=' + toolBuf.length + ')');
                    if (toolBuf) sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: toolBuf }, finish_reason: null }] });
                    emitCurrentDelta = false; /* toolBuf 已含当前 evt.delta，避免首块重复发送 */
                  }
                } else if (toolMode === 'silent') {
                  /* silent 超时回退：如果 silent 模式持续超过 SILENT_TIMEOUT_MS，
                   * 说明 driver 侧可能解析失败在重试，或模型输出的不是真正的工具调用。
                   * 回退到 stream 模式，补发已缓冲的全部内容，避免客户端无限卡死。 */
                  if (silentStart && Date.now() - silentStart > SILENT_TIMEOUT_MS) {
                    log('toolMode silent timeout (' + Math.round(SILENT_TIMEOUT_MS / 1000) + 's), fallback → stream (accContentLen=' + accContent.length + ')');
                    toolMode = 'stream';
                    if (accContent) sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: accContent }, finish_reason: null }] });
                    emitCurrentDelta = false; /* accContent 已含当前 evt.delta，避免回退轮重复发送 */
                  }
                }
                if (toolMode === 'stream' && emitCurrentDelta) {
                  sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: evt.delta }, finish_reason: null }] });
                }
                /* silent：工具 JSON 静默累计不转发（accContent 继续累计供终态对齐判断） */
              }
              logDbg('delta kind=' + (evt.kind || 'content') + ' len=' + evt.delta.length + ' toolMode=' + toolMode + ' accContentLen=' + accContent.length);
            }
            continue;
          }
          if (evt.ok !== undefined || evt.error !== undefined || evt.toolCalls !== undefined) {
            log('stream-end received: ok=' + evt.ok + ' toolCalls=' + (evt.toolCalls ? evt.toolCalls.length : 0) + ' resultLen=' + (evt.result ? evt.result.length : 0) + ' toolMode=' + toolMode + ' accContentLen=' + accContent.length);
            break;
          }
        }
      } finally { clearTimeout(waitTimer); }
      d.consumers.delete(streamId);
      return { evt };
    };
    if (wantStream) {
      sseHeaders(res);
      sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    }
    /* 账号切换重试循环（SPEC-v2 §5.4）：errorKind 结构化信号 → 账号生命周期处理 → 换号 recovery 重建 */
    let evt;
    {
      let askMode = mode;
      const exclude = new Set();
      for (;;) {
        evt = (await askOnce(acct.name, askMode)).evt;
        if (evt.ok) {
          poolMarkOk(acct.name);
          currentProfile = providerProfile(cfg.providerId, acct.name); /* driver 浏览器当前绑定该 profile（调度优先，减少重启） */
          break;
        }
        const kind = evt.errorKind;
        if (!kind) break; /* 普通错误：原样上报（v1 行为） */
        if (kind === 'quota') {
          poolMarkQuota(acct.name);
        } else if (kind === 'captcha') {
          poolMarkDown(acct.name, 'captcha');
        } else if (kind === 'login') {
          poolMarkDown(acct.name, 'login');
          /* 自动登录（SPEC-v2 §5.5）：互斥弹有头窗口，成功后同账号 recovery 重试（不消耗切换预算） */
          if (state.autoRelogin && exclude.size < state.maxAccountSwitchesPerRequest) {
            log('自动登录: ' + acct.name + '（已打开浏览器登录窗口，等待完成…超时 5 分钟）');
            try {
              const r = await poolLogin(providerProfile(cfg.providerId, acct.name), 300000, cfg.providerId);
              if (r && r.ok) {
                poolMarkOk(acct.name);
                log('自动登录成功: ' + acct.name + ' → recovery 模式重试');
                askMode = 'recovery';
                continue;
              }
              log('自动登录未完成: ' + acct.name);
            } catch (e) { log('自动登录异常: ' + e.message); }
          }
        }
        /* 切换下一可用账号（排除本请求已失败的） */
        exclude.add(acct.name);
        if (exclude.size > state.maxAccountSwitchesPerRequest) { log('账号切换预算已用尽（' + state.maxAccountSwitchesPerRequest + ' 次）'); break; }
        const next = poolPick(null, exclude, cfg.providerId);
        if (!next) { log('无可切换账号（其余账号受限/未登录/禁用）'); break; }
        log('切换账号: ' + acct.name + ' → ' + next.name + '（recovery 重建上下文）');
        acct = next;
        session.acctName = next.name;
        askMode = 'recovery';
      }
    }
    if (evt.toolCalls && evt.toolCalls.length) {
      evt.toolCalls.forEach((tc, i) => {
        const callId = 'call_gw_' + i + '_' + Date.now().toString(36);
        const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {});
        const tool = { id: callId, type: 'function', function: { name: tc.name, arguments: argsStr } };
        emitTool(i, tool);
        for (let k = 0; k < argsStr.length; k += 60) emitToolArgs(i, argsStr.slice(k, k + 60));
      });
      finish('tool_calls');
    } else if (evt.ok) {
      const result = evt.result || '';
      /* v3 真流式终态对齐：流式增量与终态 result 同为 cleanText 基准（driver 保证），
       * 公共前缀之后补发差异尾部（流式期间页面文本微调/尾部清理的兜底）。
       * 正文未流式（silent 工具误判回退 / buffer 未判定 / 非流式 / 无增量）
       * → 全量输出，完整性优先。
       * silent 误判修复：toolMode=silent 但 toolCalls 为空 = 误判为工具调用，
       * 此时 accContent 已累计全部文本但未转发客户端，必须全量补发。 */
      if (wantStream && toolMode === 'silent' && !evt.toolCalls) {
        log('silent misfire: toolCalls empty, emitting accContent (len=' + accContent.length + ')');
        emitText(accContent || result);
      } else if (wantStream && toolMode === 'stream' && accContent) {
        let i = 0;
        const n = Math.min(accContent.length, result.length);
        while (i < n && accContent.charCodeAt(i) === result.charCodeAt(i)) i++;
        if (i < result.length) emitText(result.slice(i));
      } else {
        emitText(result);
      }
      finish('stop');
    } else {
      /* 请求失败（timeout/受限切换预算用尽等）：通道页面状态未知 → 下轮强制 recovery */
      session0.epoch = -1;
      const msg = evt.error || 'unknown';
      const kind = evt.errorKind || '';
      const providerError = driverErrorResponse(kind, msg);
      const status = providerError ? providerError.status : kind === 'quota' ? 429 : kind === 'login' ? 401 : kind === 'captcha' ? 403 : /^nothing to send/.test(String(msg)) ? 400 : /^timeout:/.test(String(msg)) ? 504 : 502;
      const type = providerError ? providerError.type : kind === 'quota' ? 'rate_limit_error' : kind === 'login' ? 'authentication_error' : kind === 'captcha' ? 'permission_error' : /^nothing to send/.test(String(msg)) ? 'invalid_request_error' : /^timeout:/.test(String(msg)) ? 'timeout_error' : 'api_error';
      const code = providerError ? providerError.code : kind || (/^nothing to send/.test(String(msg)) ? 'nothing_to_send' : /^timeout:/.test(String(msg)) ? 'driver_timeout' : 'driver_error');
      return failJson(status, type, msg, code);
    }
  } catch (e) {
    /* 异常路径下会话通道状态未知（rpc 失败/driver 未就绪）→ epoch 置失配，
     * 强制下一请求 recovery 重建上下文，防 delta 增量发进不存在的网页历史 */
    if (session0) session0.epoch = -1;
    try {
      /* SSE 已开始（headers 已 flush）时二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT
       * 且被内层 catch 吞掉 → finish 不执行 → 客户端收不到 [DONE] 连接悬挂。
       * headersSent 守卫：头未发过才补发 SSE 头，已发过直接续写错误文本。 */
      if (wantStream && !res.headersSent) {
        sseHeaders(res);
        sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      }
      return failJson(wantStream ? 200 : 502, 'api_error', String(e.message || e), 'gateway_exception');
    } catch (e2) { /* ignore */ }
  } finally {
    /* 释放顺序与获取相反：信号量 → 会话锁；同时刷新会话活跃时间 */
    if (release) release();
    if (releaseLock) {
      session0.lastSeen = Date.now();
      session0.busy = false;
      releaseLock();
    }
  }
}

/* ---------- WorkBuddy 落盘模式（workbuddy-agent / localproxy，注册驱动用） ---------- */
const WB_REQ_DIR = path.join(__dirname, 'mock-api', 'requests');
const WB_RES_DIR = path.join(__dirname, 'mock-api', 'responses');
for (const d of [WB_REQ_DIR, WB_RES_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ } }
let wbSeq = 0;
/** 轮询等待 WorkBuddy 回应文件出现（800ms 间隔），超时 reject。 */
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
/** WorkBuddy 落盘模式：请求写入 mock-api/requests/，轮询 mock-api/responses/
 * 读取回应（外部进程消费），转成 OpenAI 兼容 SSE/JSON 输出。超时 900s。
 * 与浏览器引擎完全无关——纯本地文件通信通道。 */
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


function gatewayBaseURL() {
  return 'http://127.0.0.1:' + PORT;
}
function gatewayApiBaseURL() {
  return gatewayBaseURL() + '/v1/';
}
function providerModelsYaml() {
  return Object.entries(MODELS).map(([id, m]) => '        { id: ' + id + ', name: ' + m.name.replace('（网页版）', '') + ' }').join(',\n');
}
function providerSnippet() {
  return [
    'dsweb:',
    '  {',
    '    displayName: DeepSeek 网页版 (免 API),',
    '    apiKeyEnv: MOCK_LLM_KEY,',
    '    api: openai-completions,',
    '    baseURL: ' + gatewayApiBaseURL() + ',',
    '    models:',
    '      [',
    providerModelsYaml(),
    '      ]',
    '  }',
  ].join('\n');
}
function credentialsSnippet() {
  return 'MOCK_LLM_KEY: sk-mock-any-value';
}
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function jsonHtml(obj) {
  return htmlEscape(JSON.stringify(obj, null, 2));
}
function fmtDuration(ms) {
  const n = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + s + 's';
  return s + 's';
}
function fmtAgo(ts) {
  if (!ts) return '从未';
  const d = Date.now() - ts;
  if (d < 0) return '刚刚';
  return fmtDuration(d) + ' 前';
}
function healthSummary(health) {
  const sessions = health.sessions || {};
  const driver = health.driver || {};
  const login = health.login || {};
  const accounts = health.accounts || {};
  const cooling = (accounts.accounts || []).filter((a) => a.state === 'cooling').length;
  const needsLogin = (accounts.accounts || []).filter((a) => a.state === 'needs_login').length;
  return {
    gateway: driver.ready ? 'ready' : (driver.running ? 'starting' : 'down'),
    login: login.needsLogin ? 'needs_login' : 'logged_in',
    sessions: sessions.count || 0,
    channels: sessions.channels || 0,
    freeChannels: sessions.freeChannels || 0,
    accounts: accounts.total || 0,
    coolingAccounts: cooling,
    needsLoginAccounts: needsLogin,
  };
}
function summarizeLastStream(last) {
  if (!last) return { text: '暂无', detail: '', kind: 'muted' };
  function finishLabel(finishBy) {
    switch (finishBy) {
      case 'doneSignal': return '检测到完成信号';
      case 'stable1500ms': return '文本稳定后结束';
      case 'timeout5s': return '5 秒兜底结束';
      case 'timeout30s': return '30 秒兜底结束';
      case 'timeoutNoFirstSeen': return '超时且未见首段输出';
      case 'lengthRetryExhausted': return '对话过长且重试用尽';
      case 'limitHit': return '触发限流/风控';
      case 'tool_calls': return '输出工具调用';
      case 'stop': return '正常结束';
      case 'exception': return '异常中断';
      default: return finishBy || (last.ok ? '正常结束' : '失败');
    }
  }
  const parts = [];
  if (last.at) parts.push(fmtAgo(last.at));
  parts.push(finishLabel(last.finishBy));
  if (last.ok === false && last.errorKind) parts.push('错误：' + last.errorKind);
  if (last.ok === false && !last.errorKind && last.error) parts.push('请求失败');
  if (last.toolCalls) parts.push('工具 ' + last.toolCalls + ' 次');
  if (last.resultLen) parts.push('输出 ' + last.resultLen + ' 字');
  if (last.thinkStalled) parts.push('思考区静止后放行');
  const detail = [
    'profile=' + (last.profile || '-'),
    'pageKey=' + (last.pageKey || '-'),
    'finishBy=' + (last.finishBy || '-'),
    'genSeen=' + !!last.genSeen,
    'thinking=' + !!last.thinking,
    'searching=' + !!last.searching,
    'toolCalls=' + (last.toolCalls || 0),
    'resultLen=' + (last.resultLen || 0),
    'thinkLen=' + (last.thinkLen || 0),
    'dedupedLen=' + (last.dedupedLen || 0),
  ].join(' · ');
  return { text: parts.join(' · '), detail, kind: last.ok === false ? 'bad' : (last.thinkStalled ? 'warn' : 'ok') };
}
function accountActionHint(a) {
  if (!a) return '';
  if (a.state === 'needs_login') return '需要重新登录';
  if (a.state === 'cooling') return '冷却中，等待探测恢复';
  if (a.state === 'probing') return '已到探测窗口，下一次真实请求会验证是否恢复';
  if (a.state === 'disabled') return '已禁用，可重新启用后登录';
  if (a.suspectWindowMs > 0) return '刚出现一次疑似风控信号，调度会暂时绕开';
  return '可用';
}
function buildAccountsPayload() {
  const desc = poolDescribe();
  const enriched = desc.accounts.map((a) => Object.assign({}, a, {
    cooldownRemainText: a.cooldownRemainMs ? fmtDuration(a.cooldownRemainMs) : '',
    lastUsedAgo: fmtAgo(a.lastUsedAt),
    actionHint: accountActionHint(a),
  }));
  const summary = {
    active: enriched.filter((a) => a.state === 'active').length,
    cooling: enriched.filter((a) => a.state === 'cooling').length,
    probing: enriched.filter((a) => a.state === 'probing').length,
    needsLogin: enriched.filter((a) => a.state === 'needs_login').length,
    disabled: enriched.filter((a) => a.state === 'disabled').length,
  };
  return {
    ok: true,
    enabled: desc.enabled,
    total: desc.total,
    accounts: enriched,
    summary,
    backoff: { baseMs: state.quotaBackoffBaseMs, maxMs: state.quotaBackoffMaxMs, confirmWindowMs: state.quotaConfirmWindowMs },
    note: '受限信号只来自页面文案检测（动态风控无固定数值）；恢复=指数退避到期后真实请求探测',
  };
}
async function getLoginSnapshot(providerId) {
  let st = { needsLogin: true };
  const id = providerId || 'deepseek';
  try {
    const insp = await rpc('inspect', { providerId: id, profile: providerProfile(id) }, 8000);
    st = (insp && insp.login) || { needsLogin: true };
  } catch (e) { /* driver not ready */ }
  return st;
}
async function getInspectSnapshot() {
  try { return await rpc('inspect', {}, 8000); } catch (e) { return null; }
}
async function buildHealthPayload() {
  const uptime = Math.floor((Date.now() - gatewayStartTime) / 1000);
  const inspect = await getInspectSnapshot();
  const login = (inspect && inspect.login) || { needsLogin: true };
  const accounts = poolDescribe();
  const payload = {
    ok: true,
    uptime,
    requests: gatewayRequestCount,
    driver: { running: !!D, ready: !!(D && D.ready), pid: D && D.cp ? D.cp.pid : null, lastStreamSummary: inspect && inspect.lastStreamSummary ? inspect.lastStreamSummary : null },
    login,
    accounts,
    sessions: {
      count: sessions.size,
      channels: activeChannelCount(),
      freeChannels: freePageKeys.length,
      list: [...sessions.values()].map((s) => ({ id: s.id, pageKey: s.pageKey, busy: s.busy, idleMs: Date.now() - s.lastSeen, account: s.acctName })),
    },
    config: { headless: state.headless, maxConcurrent: state.maxConcurrent, maxTurnsPerChat: state.maxTurnsPerChat, maxPages: state.maxPages, accountPool: state.accountPool, maxAccounts: state.maxAccounts, autoRelogin: state.autoRelogin, quotaBackoffBaseMs: state.quotaBackoffBaseMs, quotaBackoffMaxMs: state.quotaBackoffMaxMs },
  };
  payload.driver.lastStream = summarizeLastStream(payload.driver.lastStreamSummary);
  payload.summary = healthSummary(payload);
  return payload;
}
function buildSetupPayload(health, accountsPayload) {
  const accounts = (accountsPayload && accountsPayload.accounts) || [];
  const summary = (health && health.summary) || {};
  return {
    ok: true,
    gateway: {
      baseURL: gatewayBaseURL(),
      apiBaseURL: gatewayApiBaseURL(),
      port: PORT,
      running: true,
    },
    setup: {
      providerSnippet: providerSnippet(),
      credentialsSnippet: credentialsSnippet(),
      checklist: [
        { key: 'gateway', label: '网关已启动', done: true, detail: gatewayBaseURL() },
        { key: 'provider', label: '已在 ~/.dsh/settings.yaml 添加 dsweb provider', done: false, detail: '复制下方 provider 片段到 llm-pi-ai.providers' },
        { key: 'credentials', label: '已在 ~/.dsh/.credentials.yaml 添加 MOCK_LLM_KEY', done: false, detail: '网关不校验该值，只需存在即可' },
        { key: 'login', label: 'DeepSeek 已登录', done: summary.login === 'logged_in', detail: summary.login === 'logged_in' ? '当前检查通过' : '请点击“默认账号登录”或登录其它账号' },
      ],
      quickLinks: {
        home: '/',
        login: '/login',
        loginStatus: '/login-status',
        health: '/health',
        accounts: '/accounts',
        config: '/config',
        debug: '/debug',
      },
    },
    cards: {
      login: {
        loggedIn: summary.login === 'logged_in',
        hint: summary.login === 'logged_in' ? '登录态正常，可直接在 DSH 中选用模型。' : '未检测到可用登录态，请先完成浏览器登录。',
      },
      runtime: {
        gateway: summary.gateway,
        sessions: summary.sessions,
        channels: summary.channels,
        freeChannels: summary.freeChannels,
      },
      accounts: {
        total: accounts.length,
        needsLogin: accounts.filter((a) => a.state === 'needs_login').length,
        cooling: accounts.filter((a) => a.state === 'cooling').length,
      },
    },
  };
}
function sendHtml(res, html) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function renderManagementPage(setup) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DeepSeek 网页版插件管理</title>
<style>
:root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --link:#58a6ff; }
* { box-sizing:border-box; }
body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
a { color:var(--link); text-decoration:none; }
a:hover { text-decoration:underline; }
.wrap { max-width:1280px; margin:0 auto; padding:24px; }
.hero { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; justify-content:space-between; margin-bottom:20px; }
.hero h1 { margin:0 0 6px; font-size:28px; }
.hero p { margin:0; color:var(--muted); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:16px; box-shadow:0 10px 30px rgba(0,0,0,.18); }
.card h2 { margin:0 0 10px; font-size:18px; }
.card h3 { margin:14px 0 8px; font-size:14px; color:var(--muted); }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.stat { display:flex; justify-content:space-between; gap:12px; border-top:1px solid rgba(255,255,255,.06); padding-top:8px; margin-top:8px; }
.badge { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; background:#21262d; color:var(--text); border:1px solid var(--line); }
.badge.ok { color:#aff5b4; border-color:rgba(63,185,80,.4); }
.badge.warn { color:#f2cc60; border-color:rgba(210,153,34,.4); }
.badge.bad { color:#ffb3ad; border-color:rgba(248,81,73,.4); }
button, .btn, input, textarea { font:inherit; }
button, .btn { background:#238636; color:white; border:0; padding:8px 12px; border-radius:10px; cursor:pointer; }
button.secondary, .btn.secondary { background:#21262d; color:var(--text); border:1px solid var(--line); }
button.warn { background:#9e6a03; }
button.bad { background:#da3633; }
button:disabled { opacity:.6; cursor:not-allowed; }
pre { overflow:auto; padding:12px; border-radius:12px; background:#0b0f14; border:1px solid var(--line); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
small, .muted { color:var(--muted); }
input[type="text"], input[type="number"] { width:100%; background:#0b0f14; color:var(--text); border:1px solid var(--line); border-radius:10px; padding:8px 10px; }
label.field { display:block; margin:8px 0; }
label.field span { display:block; margin-bottom:6px; color:var(--muted); }
.table { width:100%; border-collapse:collapse; }
.table th, .table td { text-align:left; vertical-align:top; padding:8px 6px; border-top:1px solid rgba(255,255,255,.08); }
.table th { color:var(--muted); font-weight:600; }
.notice { padding:10px 12px; border-radius:12px; background:rgba(88,166,255,.08); border:1px solid rgba(88,166,255,.25); }
.footer { margin-top:18px; color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div>
      <h1>DeepSeek 网页版插件管理</h1>
      <p>安装完成后，这里就是本插件的统一管理入口：快速登录、状态检查、账户检查、配置管理与诊断。</p>
    </div>
    <div class="row">
      <span id="gatewayBadge" class="badge">网关检查中</span>
      <span id="loginBadge" class="badge">登录态检查中</span>
      <a class="btn secondary" href="/health" target="_blank" rel="noreferrer">查看 /health JSON</a>
    </div>
  </div>
  <div id="lastErrorNotice" class="notice" style="display:none; margin-bottom:16px; background:rgba(248,81,73,.10); border-color:rgba(248,81,73,.35);"></div>

  <div class="grid">
    <section class="card">
      <h2>安装与接入</h2>
      <div id="checklist" class="notice">正在读取 setup 信息…</div>
      <h3>settings.yaml provider 片段</h3>
      <pre><code>${htmlEscape(setup.setup.providerSnippet)}</code></pre>
      <h3>.credentials.yaml 片段</h3>
      <pre><code>${htmlEscape(setup.setup.credentialsSnippet)}</code></pre>
    </section>

    <section class="card">
      <h2>快速登录</h2>
      <p id="loginHint" class="muted">正在检查登录态…</p>
      <div class="row">
        <a class="btn" href="/login" target="_blank" rel="noreferrer">默认账号登录</a>
        <button class="secondary" id="loginOtherBtn">登录其它账号</button>
        <a class="btn secondary" href="/login-status" target="_blank" rel="noreferrer">查看登录状态 JSON</a>
      </div>
      <div class="footer">其它账号登录可直接访问 <code>/login?profile=你的账号名</code>。</div>
    </section>

    <section class="card">
      <h2>运行状态</h2>
      <div class="stat"><span>网关地址</span><code>${htmlEscape(setup.gateway.baseURL)}</code></div>
      <div class="stat"><span>OpenAI 兼容入口</span><code>${htmlEscape(setup.gateway.apiBaseURL)}</code></div>
      <div class="stat"><span>请求数</span><span id="requestsText">-</span></div>
      <div class="stat"><span>运行时长</span><span id="uptimeText">-</span></div>
      <div class="stat"><span>会话 / 通道 / 空闲通道</span><span id="sessionText">-</span></div>
      <div class="stat"><span>driver</span><span id="driverText">-</span></div>
      <div class="stat"><span>最近一次请求</span><span id="lastStreamText" class="badge">-</span></div>
      <div class="footer" id="lastStreamDetail">-</div>
    </section>

    <section class="card">
      <h2>账户检查与管理</h2>
      <div class="row" style="margin-bottom:10px;">
        <input id="newAccountName" type="text" placeholder="输入新账号名，例如 acc2" />
        <button id="addAccountBtn">添加账号</button>
      </div>
      <div id="accountSummary" class="muted">正在读取账号池…</div>
      <div style="overflow:auto; margin-top:10px;">
        <table class="table" id="accountTable">
          <thead><tr><th>账号</th><th>状态</th><th>使用情况</th><th>建议</th><th>操作</th></tr></thead>
          <tbody><tr><td colspan="5" class="muted">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>运行配置</h2>
      <div class="row"><button id="refreshConfigBtn" class="secondary">刷新配置</button><button id="saveConfigBtn">保存配置</button></div>
      <label class="field"><span>headless（修改后需重启网关并重新登录）</span><input id="cfgHeadless" type="text" placeholder="true / false" /></label>
      <label class="field"><span>maxConcurrent</span><input id="cfgConcurrent" type="number" min="1" max="5" /></label>
      <label class="field"><span>maxPages</span><input id="cfgPages" type="number" min="1" max="8" /></label>
      <label class="field"><span>maxTurnsPerChat</span><input id="cfgTurns" type="number" min="2" max="500" /></label>
      <label class="field"><span>accountPool（true / false）</span><input id="cfgAccountPool" type="text" /></label>
      <label class="field"><span>maxAccounts</span><input id="cfgMaxAccounts" type="number" min="1" max="8" /></label>
      <label class="field"><span>autoRelogin（true / false）</span><input id="cfgAutoRelogin" type="text" /></label>
      <label class="field"><span>quotaBackoffBaseMs</span><input id="cfgBackoffBase" type="number" min="60000" /></label>
      <label class="field"><span>quotaBackoffMaxMs</span><input id="cfgBackoffMax" type="number" min="1800000" /></label>
      <div id="configNote" class="footer">配置会通过 <code>/config</code> 立即生效。</div>
    </section>

    <section class="card">
      <h2>诊断与维护</h2>
      <div class="row">
        <a class="btn secondary" href="/debug" target="_blank" rel="noreferrer">DOM 结构诊断</a>
        <a class="btn secondary" href="/accounts" target="_blank" rel="noreferrer">账号 JSON</a>
        <a class="btn secondary" href="/config" target="_blank" rel="noreferrer">配置 JSON</a>
        <a class="btn secondary" href="/calibrate/list" target="_blank" rel="noreferrer">校准列表</a>
      </div>
      <div class="footer">
        常见限制：多账号时并发会退化为串行；需要本机真实 Chrome；DeepSeek 网页改版时可能需要更新选择器或重做校准。
      </div>
    </section>

    <section class="card">
      <h2>接口快照</h2>
      <p class="muted">便于未来接入 DSH 原生设置卡片：本页面只是插件内前端，卡片数据以 JSON 接口为准。</p>
      <pre id="snapshotPre"><code>正在加载…</code></pre>
    </section>
  </div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const boolText = (v) => v ? 'true' : 'false';
  const fmtDuration = (ms) => {
    const n = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60); const s = n % 60;
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  };
  const api = async (url, init) => {
    const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, init || {}));
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(text || ('HTTP ' + r.status)); }
  };
  const badge = (el, text, kind) => { el.textContent = text; el.className = 'badge ' + (kind || ''); };

  async function refreshAll() {
    const [setup, health, accounts, config] = await Promise.all([
      api('/setup'), api('/health'), api('/accounts'), api('/config')
    ]);
    renderSetup(setup);
    renderHealth(health);
    renderAccounts(accounts);
    renderConfig(config);
    $('snapshotPre').innerHTML = '<code>' + escapeHtml(JSON.stringify({ setup, health: { summary: health.summary, config: health.config }, accounts: { summary: accounts.summary, total: accounts.total } }, null, 2)) + '</code>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderSetup(setup) {
    badge($('gatewayBadge'), setup.cards.runtime.gateway === 'ready' ? '网关 ready' : '网关启动中', setup.cards.runtime.gateway === 'ready' ? 'ok' : 'warn');
    badge($('loginBadge'), setup.cards.login.loggedIn ? '已登录' : '未登录', setup.cards.login.loggedIn ? 'ok' : 'warn');
    $('loginHint').textContent = setup.cards.login.hint;
    $('checklist').innerHTML = setup.setup.checklist.map((x) => '<div style="margin:6px 0;"><strong>' + (x.done ? '✅' : '⬜️') + ' ' + escapeHtml(x.label) + '</strong><div class="muted">' + escapeHtml(x.detail || '') + '</div></div>').join('');
  }

  function renderHealth(health) {
    $('requestsText').textContent = String(health.requests || 0);
    $('uptimeText').textContent = fmtDuration((health.uptime || 0) * 1000);
    $('sessionText').textContent = [health.sessions.count || 0, health.sessions.channels || 0, health.sessions.freeChannels || 0].join(' / ');
    $('driverText').textContent = (health.driver.ready ? 'ready' : (health.driver.running ? 'running' : 'down')) + (health.driver.pid ? ' · pid ' + health.driver.pid : '');
    const ls = health.driver.lastStream || { text: '暂无', detail: '最近一次请求完成快照会显示在这里', kind: 'muted' };
    $('lastStreamText').textContent = ls.text || '暂无';
    $('lastStreamText').className = 'badge ' + (ls.kind || '');
    $('lastStreamDetail').textContent = ls.detail || '最近一次请求完成快照会显示在这里';
    const lastError = $('lastErrorNotice');
    if (ls.kind === 'bad') {
      lastError.style.display = 'block';
      lastError.innerHTML = '<strong>最近失败：</strong>' + escapeHtml(ls.text || '请求失败') + '<div class="muted" style="margin-top:6px;">' + escapeHtml(ls.detail || '') + '</div>';
    } else {
      lastError.style.display = 'none';
      lastError.textContent = '';
    }
  }

  function renderAccounts(accounts) {
    $('accountSummary').textContent = '总账号 ' + accounts.total + ' · active ' + accounts.summary.active + ' · cooling ' + accounts.summary.cooling + ' · needs_login ' + accounts.summary.needsLogin + ' · disabled ' + accounts.summary.disabled;
    const tbody = $('accountTable').querySelector('tbody');
    tbody.innerHTML = accounts.accounts.map((a) => '<tr>' +
      '<td><strong>' + escapeHtml(a.name) + '</strong></td>' +
      '<td>' + escapeHtml(a.state) + (a.cooldownRemainText ? '<div class="muted">剩余 ' + escapeHtml(a.cooldownRemainText) + '</div>' : '') + '</td>' +
      '<td>请求 ' + (a.requestCount || 0) + '<div class="muted">最近使用 ' + escapeHtml(a.lastUsedAgo || '从未') + '</div></td>' +
      '<td>' + escapeHtml(a.actionHint || '') + '</td>' +
      '<td class="row">' +
        '<a class="btn secondary" target="_blank" rel="noreferrer" href="/login?profile=' + encodeURIComponent(a.name) + '">登录</a>' +
        (a.state === 'disabled' ? '<button class="secondary" data-enable="' + escapeHtml(a.name) + '">启用</button>' : '<button class="secondary" data-disable="' + escapeHtml(a.name) + '">禁用</button>') +
        (a.name === 'default' ? '' : '<button class="bad" data-remove="' + escapeHtml(a.name) + '">删除</button>') +
      '</td>' +
    '</tr>').join('') || '<tr><td colspan="5" class="muted">暂无账号</td></tr>';
  }

  function renderConfig(configResp) {
    const cfg = configResp.config || {};
    $('cfgHeadless').value = boolText(!!cfg.headless);
    $('cfgConcurrent').value = cfg.maxConcurrent ?? 2;
    $('cfgPages').value = cfg.maxPages ?? 4;
    $('cfgTurns').value = cfg.maxTurnsPerChat ?? 50;
    $('cfgAccountPool').value = boolText(cfg.accountPool !== false);
    $('cfgMaxAccounts').value = cfg.maxAccounts ?? 3;
    $('cfgAutoRelogin').value = boolText(cfg.autoRelogin !== false);
    $('cfgBackoffBase').value = cfg.quotaBackoffBaseMs ?? 300000;
    $('cfgBackoffMax').value = cfg.quotaBackoffMaxMs ?? 21600000;
    $('configNote').textContent = configResp.note || '配置会通过 /config 立即生效。';
  }

  function parseBool(v) {
    return /^(1|true|yes|on)$/i.test(String(v).trim());
  }

  $('saveConfigBtn').addEventListener('click', async () => {
    const payload = {
      headless: parseBool($('cfgHeadless').value),
      maxConcurrent: Number($('cfgConcurrent').value),
      maxPages: Number($('cfgPages').value),
      maxTurnsPerChat: Number($('cfgTurns').value),
      accountPool: parseBool($('cfgAccountPool').value),
      maxAccounts: Number($('cfgMaxAccounts').value),
      autoRelogin: parseBool($('cfgAutoRelogin').value),
      quotaBackoffBaseMs: Number($('cfgBackoffBase').value),
      quotaBackoffMaxMs: Number($('cfgBackoffMax').value),
    };
    const r = await api('/config', { method: 'POST', body: JSON.stringify(payload) });
    renderConfig(r);
    await refreshAll();
  });
  $('refreshConfigBtn').addEventListener('click', () => refreshAll());
  $('addAccountBtn').addEventListener('click', async () => {
    const name = $('newAccountName').value.trim();
    if (!name) return alert('请先输入账号名');
    const r = await api('/accounts/add', { method: 'POST', body: JSON.stringify({ name }) });
    if (!r.ok) return alert(r.error || '添加失败');
    $('newAccountName').value = '';
    alert(r.message || '账号已添加');
    await refreshAll();
  });
  $('loginOtherBtn').addEventListener('click', () => {
    const name = window.prompt('请输入账号名，例如 acc2');
    if (!name) return;
    window.open('/login?profile=' + encodeURIComponent(name.trim()), '_blank', 'noopener');
  });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.enable) {
      const r = await api('/accounts/enable', { method: 'POST', body: JSON.stringify({ name: t.dataset.enable }) });
      if (!r.ok) alert(r.error || '启用失败');
      await refreshAll();
    }
    if (t.dataset.disable) {
      const r = await api('/accounts/disable', { method: 'POST', body: JSON.stringify({ name: t.dataset.disable }) });
      if (!r.ok) alert(r.error || '禁用失败');
      await refreshAll();
    }
    if (t.dataset.remove) {
      if (!window.confirm('确认删除账号 ' + t.dataset.remove + ' 吗？浏览器 profile 目录会保留。')) return;
      const r = await api('/accounts/remove', { method: 'POST', body: JSON.stringify({ name: t.dataset.remove, confirm: true }) });
      if (!r.ok) alert(r.error || '删除失败');
      await refreshAll();
    }
  });

  refreshAll().catch((e) => {
    $('snapshotPre').innerHTML = '<code>' + escapeHtml(String(e && e.message || e)) + '</code>';
    badge($('gatewayBadge'), '页面加载失败', 'bad');
  });
  setInterval(() => refreshAll().catch(() => {}), 15000);
})();
</script>
</body>
</html>`;
}


/* ---------- HTTP 服务 ---------- */
/** 设置 CORS 响应头（本机调试场景，放开全部来源）。 */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
/** 发送 JSON 响应（默认 200 + CORS）。 */
function sendJson(res, obj, statusCode) {
  cors(res);
  res.writeHead(statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
/** 读取请求体（字符串），8MB 上限防滥用。 */
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
      gatewayRequestCount++;
      return sendJson(res, { object: 'list', data: listModels().map((m) => ({ id: m.id, object: 'model', owned_by: m.providerId + '-web', name: m.name })) });
    }
    /* OpenAI chat completions */
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      gatewayRequestCount++;
      const payload = JSON.parse((await readBody(req)) || '{}');
      const validation = validateChatPayload(payload, true);
      if (validation) return sendJson(res, { error: { message: validation.message, type: 'invalid_request_error', code: validation.code } }, validation.status);
      log('请求: model=' + payload.model + ' msgs=' + payload.messages.length + ' tools=' + ((payload.tools || []).length));
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
      const resolvedModel = resolveProviderModel(payload.model);
      if (!resolvedModel) return sendJson(res, { error: { message: 'unknown model: ' + payload.model, type: 'invalid_request_error', code: 'model_not_found' } }, 404);
      return handleChatCompletion(req, res, payload, resolvedModel);
    }
    if (req.method === 'GET' && p === '/') {
      gatewayRequestCount++;
      const health = await buildHealthPayload();
      const setup = buildSetupPayload(health, buildAccountsPayload());
      return sendHtml(res, renderManagementPage(setup));
    }
    if (req.method === 'GET' && p === '/setup') {
      gatewayRequestCount++;
      const health = await buildHealthPayload();
      const payload = buildSetupPayload(health, buildAccountsPayload());
      return sendJson(res, payload);
    }
    /* 登录（支持 ?provider=deepseek|chatgpt|qwen 与 ?profile=xxx）。 */
    if (req.method === 'GET' && p === '/login') {
      const providerId = providerFromQuery(u.searchParams);
      if (!providerId) return sendJson(res, { error: { message: 'unknown provider', type: 'invalid_request_error', code: 'provider_not_found' } }, 400);
      const accountName = (u.searchParams.get('profile') || 'default').trim() || 'default';
      const account = poolEnsure(providerId, accountName);
      const profileName = providerProfile(providerId, account.name);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#17181c;color:#ddd"><h2>' + getProvider(providerId).label + ' 网页版登录（账号: ' + profileName + '）</h2><p>已打开浏览器窗口，请在其中登录该提供方网站。登录完成后会自动检测。</p><p><a href="/">返回插件管理页</a> · <a href="/login-status?provider=' + providerId + '">查看登录状态</a> · <a href="/accounts">账号列表</a></p></body></html>');
      await ensureDriver();
      poolLogin(profileName, 300000, providerId)
        .then((r) => { if (r && r.ok) poolMarkOk(account.name); log('登录结果(' + providerId + '/' + profileName + '):', JSON.stringify(r).slice(0, 160)); })
        .catch((e) => log('登录失败(' + providerId + '/' + profileName + '):', e.message));
      return;
    }
    /* 账号池管理（SPEC-v2 §5.7）：多账号保存 / 状态查看 / 启停 */
    if (p === '/accounts' && req.method === 'GET') {
      gatewayRequestCount++;
      return sendJson(res, buildAccountsPayload());
    }
    if (p === '/accounts/add' && req.method === 'POST') {
      gatewayRequestCount++;
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        const providerId = b.provider === undefined ? 'deepseek' : (getProvider(String(b.provider)) ? String(b.provider) : null);
        if (!providerId) throw new Error('provider 不存在');
        const a = poolAdd(String(b.name || '').trim(), providerId);
        const profileName = providerProfile(providerId, a.name);
        log('添加账号: ' + a.name + '（provider=' + providerId + '，触发登录窗口）');
        /* 异步触发登录（HTTP 立即返回；登录状态通过 /accounts 查看） */
        ensureDriver().then(() => poolLogin(profileName, 300000, providerId))
          .then((r) => { if (r && r.ok) { poolMarkOk(a.name); log('账号 ' + a.name + ' 登录成功'); } else log('账号 ' + a.name + ' 登录未完成（可打开 /login?provider=' + providerId + '&profile=' + a.name + ' 重试）'); })
          .catch((e) => log('账号 ' + a.name + ' 登录异常: ' + e.message));
        return sendJson(res, { ok: true, account: { name: a.name, providerId: a.providerId, state: a.state }, message: '账号已入池，浏览器登录窗口已打开（5 分钟超时）。登录状态请查看 /accounts' });
      } catch (e) { return sendJson(res, { ok: false, error: String(e.message || e) }); }
    }
    if ((p === '/accounts/disable' || p === '/accounts/enable') && req.method === 'POST') {
      gatewayRequestCount++;
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        const providerId = b.provider === undefined ? 'deepseek' : (getProvider(String(b.provider)) ? String(b.provider) : null);
        if (!providerId) throw new Error('provider 不存在');
        const a = poolSetEnabled(String(b.name || '').trim(), p === '/accounts/enable', providerId);
        return sendJson(res, { ok: true, account: { name: a.name, providerId: a.providerId, state: a.state }, note: p === '/accounts/enable' ? '已启用，需登录验证（/login?provider=' + providerId + '&profile=' + a.name + '）后才可恢复使用' : '已禁用' });
      } catch (e) { return sendJson(res, { ok: false, error: String(e.message || e) }); }
    }
    if (p === '/accounts/remove' && req.method === 'POST') {
      gatewayRequestCount++;
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        const providerId = b.provider === undefined ? 'deepseek' : (getProvider(String(b.provider)) ? String(b.provider) : null);
        if (!providerId) throw new Error('provider 不存在');
        const a = poolRemove(String(b.name || '').trim(), !!b.confirm, providerId);
        return sendJson(res, { ok: true, removed: a.name, providerId: a.providerId, note: '账号已移出池。浏览器 profile 目录保留在 runtime/profiles/' + a.name + '（如需彻底删除请手动清理）' });
      } catch (e) { return sendJson(res, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === 'GET' && p === '/login-status') {
      const providerId = providerFromQuery(u.searchParams);
      if (!providerId) return sendJson(res, { error: { message: 'unknown provider', type: 'invalid_request_error', code: 'provider_not_found' } }, 400);
      gatewayRequestCount++;
      const st = await getLoginSnapshot(providerId);
      return sendJson(res, { ok: true, providerId, login: st });
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
      gatewayRequestCount++;
      const insp = await getInspectSnapshot();
      return sendJson(res, { ok: true, inspect: insp || { error: 'driver not ready' } });
    }
    /* 健康检查 */
    if (p === '/health') {
      gatewayRequestCount++;
      return sendJson(res, await buildHealthPayload());
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
        if (b.maxPages !== undefined) state.maxPages = Math.max(1, Math.min(8, parseInt(b.maxPages, 10) || 4));
        if (b.accountPool !== undefined) state.accountPool = !!b.accountPool;
        if (b.maxAccounts !== undefined) state.maxAccounts = Math.max(1, Math.min(8, parseInt(b.maxAccounts, 10) || 3));
        if (b.autoRelogin !== undefined) state.autoRelogin = !!b.autoRelogin;
        if (b.quotaBackoffBaseMs !== undefined) state.quotaBackoffBaseMs = Math.max(60000, Math.min(3600000, parseInt(b.quotaBackoffBaseMs, 10) || 300000));
        if (b.quotaBackoffMaxMs !== undefined) state.quotaBackoffMaxMs = Math.max(1800000, Math.min(86400000, parseInt(b.quotaBackoffMaxMs, 10) || 21600000));
        return sendJson(res, { ok: true, config: { headless: state.headless, maxConcurrent: state.maxConcurrent, maxTurnsPerChat: state.maxTurnsPerChat, maxPages: state.maxPages, accountPool: state.accountPool, maxAccounts: state.maxAccounts, autoRelogin: state.autoRelogin, quotaBackoffBaseMs: state.quotaBackoffBaseMs, quotaBackoffMaxMs: state.quotaBackoffMaxMs }, note });
      }
      return sendJson(res, { ok: true, config: { headless: state.headless, maxConcurrent: state.maxConcurrent, maxTurnsPerChat: state.maxTurnsPerChat, maxPages: state.maxPages, accountPool: state.accountPool, maxAccounts: state.maxAccounts, autoRelogin: state.autoRelogin, quotaBackoffBaseMs: state.quotaBackoffBaseMs, quotaBackoffMaxMs: state.quotaBackoffMaxMs } });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found: ' + p } }));
  } catch (e) {
    try { sendJson(res, { ok: false, error: String(e.message || e) }); } catch (e2) { /* ignore */ }
  }
});

// server.listen( is intentionally a test extraction boundary for legacy offline VM suites.
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    log('DeepSeek 网页版网关已监听 http://127.0.0.1:' + PORT + '/v1/');
    log('driver: ' + DRIVER_PATH + ' | baseDir: ' + BASE_DIR);
    log('模型: ' + Object.keys(MODELS).join(', '));
    log('配置: headless=' + state.headless + ' maxConcurrent=' + state.maxConcurrent + ' maxTurnsPerChat=' + state.maxTurnsPerChat + ' maxPages=' + state.maxPages + '（会话亲和并发）');
    log('账号池: ' + pool.accounts.size + ' 个账号（限流自动切换开' + (state.accountPool ? '启' : '关') + '，退避 ' + Math.round(state.quotaBackoffBaseMs / 60000) + 'min 起 ×2 封顶 ' + Math.round(state.quotaBackoffMaxMs / 3600000) + 'h）');
    ensureDriver().catch((e) => log('driver 启动失败: ' + e.message));
  });
  process.on('SIGINT', () => { terminating = true; if (D && D.cp) { try { D.cp.kill('SIGTERM'); } catch (e) { /* ignore */ } } process.exit(0); });
  process.on('SIGTERM', () => { terminating = true; if (D && D.cp) { try { D.cp.kill('SIGTERM'); } catch (e) { /* ignore */ } } process.exit(0); });
}

module.exports = { resolveProviderModel, profileKey, providerProfile, channelKey, providerFromQuery, driverErrorResponse, MODELS, server };
