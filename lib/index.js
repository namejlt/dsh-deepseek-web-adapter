/**
 * dsh-deepseek-web-adapter — Host half (standard Cordis plugin)
 *
 * 作用：插件被 DSH 加载时，自动拉起本地网关（resources/dsweb-gateway.js + driver.js），
 * 卸载时回收。网关提供 OpenAI 兼容 API（http://127.0.0.1:5688/v1/），
 * 让 DSH 用 DeepSeek 网页版（chat.deepseek.com）作为免 API Key 的模型提供方。
 *
 * 使用步骤（装完插件后）：
 *  1. 插件加载 → 网关自动启动（约 3-8 秒，日志见 dsh 终端）
 *  2. 在 ~/.dsh/settings.yaml 加 dsweb provider（见 README）→ 模型选择器出现 DeepSeek 网页版
 *  3. 浏览器打开 http://127.0.0.1:5688/login 登录 chat.deepseek.com（勾选保持登录）
 *  4. 在 DSH 选 DeepSeek 网页版模型使用（工具调用由网关解析，DSH 原生执行）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_PORT = 5688;
const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const GATEWAY_FILE = path.join(RESOURCES_DIR, 'dsweb-gateway.js');
const BASE_DIR = path.join(RESOURCES_DIR, 'runtime');

export const name = 'dsh-deepseek-web-adapter';
export const inject = [];

/* ── 网关进程管理（单例） ─────────────────────────────────────────── */

let gwProcess = null;
let gwStartedByUs = false;
let gwEnsurePromise = null;

function gatewayAlive() {
  return fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/models`)
    .then((r) => r.ok)
    .catch(() => false);
}

function waitGatewayReady(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await gatewayAlive()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });
}

async function doEnsureGateway() {
  if (await gatewayAlive()) return { started: false, message: `gateway already running on ${GATEWAY_PORT}` };
  if (!fs.existsSync(GATEWAY_FILE)) {
    throw new Error(`cannot locate ${GATEWAY_FILE} — resources not installed`);
  }
  if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
  const cp = spawn(process.execPath, [GATEWAY_FILE, '--port', String(GATEWAY_PORT), '--base', BASE_DIR], {
    cwd: RESOURCES_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  gwProcess = cp;
  gwStartedByUs = true;
  let errTail = '';
  cp.stderr.setEncoding('utf8');
  cp.stderr.on('data', (c) => { errTail = (errTail + c).slice(-2000); });
  const ready = await waitGatewayReady(25000);
  if (!ready) {
    try { cp.kill(); } catch (e) { /* ignore */ }
    gwProcess = null;
    gwStartedByUs = false;
    throw new Error(`gateway failed to become ready in 25s — ${errTail.slice(-300) || '(no stderr)'}`);
  }
  return { started: true, message: 'gateway spawned on ' + GATEWAY_PORT };
}

function ensureGateway() {
  if (gwEnsurePromise) return gwEnsurePromise;
  gwEnsurePromise = doEnsureGateway().finally(() => { gwEnsurePromise = null; });
  return gwEnsurePromise;
}

function stopGateway() {
  if (gwProcess && gwStartedByUs) {
    try { gwProcess.kill(); } catch (e) { /* ignore */ }
  }
  gwProcess = null;
  gwStartedByUs = false;
  gwEnsurePromise = null;
}

/* ── Cordis apply：加载时拉起网关，卸载时回收 ───────────────────────── */

export function apply(ctx) {
  ctx.effect(() => {
    const started = ensureGateway();
    started.then((r) => {
      try { ctx.emit?.('dsweb/gateway-status', r); } catch (e) { /* ignore */ }
    }).catch((e) => {
      try { ctx.emit?.('dsweb/gateway-error', String(e.message || e)); } catch (e2) { /* ignore */ }
    });
    return () => { stopGateway(); };
  });
}
