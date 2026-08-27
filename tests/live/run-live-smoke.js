'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROVIDERS = ['deepseek', 'chatgpt', 'qwen'];
const DEFAULT_MODELS = {
  deepseek: 'deepseek-chat',
  chatgpt: 'chatgpt-auto',
  qwen: 'qwen-auto',
};

function parseArgs(argv) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq >= 0) out[item.slice(2, eq)] = item.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[item.slice(2)] = argv[++i];
    else out[item.slice(2)] = true;
  }
  return out;
}

function sanitizeString(value, stateDir) {
  let out = String(value == null ? '' : value);
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, '<redacted-bearer>');
  if (stateDir) out = out.split(String(stateDir)).join('<state-dir>');
  out = out.replace(/(?:gateway-token|accounts\.json|calibration\.json|profiles\/[A-Za-z0-9_-]+)/gi, '<redacted-state-file>');
  return out;
}

function sanitizeReport(value, stateDir) {
  if (typeof value === 'string') return sanitizeString(value, stateDir);
  if (Array.isArray(value)) return value.map((entry) => sanitizeReport(entry, stateDir));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/authorization|cookie|token|password|secret/i.test(key)) out[key] = '<redacted>';
      else out[key] = sanitizeReport(entry, stateDir);
    }
    return out;
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function request(url, token, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 120000);
  try {
    const response = await fetch(new URL(options.pathname, url), {
      method: options.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text };
  } finally {
    clearTimeout(timer);
  }
}

function parseSse(text) {
  const rows = String(text || '').split(/\r?\n\r?\n/).filter(Boolean);
  let firstRole = null;
  let finishReason = null;
  let doneCount = 0;
  let chunks = 0;
  let toolCallChunks = 0;
  for (const row of rows) {
    const data = row.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { doneCount++; continue; }
    try {
      const json = JSON.parse(data);
      chunks++;
      const choice = json.choices && json.choices[0];
      const delta = choice && choice.delta;
      if (!firstRole && delta && delta.role) firstRole = delta.role;
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      if (delta && Array.isArray(delta.tool_calls)) toolCallChunks += delta.tool_calls.length;
    } catch (_) { /* digest below keeps malformed wire evidence without retaining content */ }
  }
  return { chunks, firstRole, finishReason, doneCount, toolCallChunks, wireSha256: stableHash(text) };
}

function chooseModel(providerId, models) {
  const preferred = DEFAULT_MODELS[providerId];
  return models.find((model) => model.id === preferred) || models.find((model) => model.owned_by === providerId + '-web') || null;
}

async function run(options) {
  const url = String(options.url || '').replace(/\/+$/, '');
  const stateDir = options.stateDir;
  const token = fs.readFileSync(path.join(stateDir, 'gateway-token'), 'utf8').trim();
  if (!token) throw new Error('gateway-token is empty');
  const requestedProviders = String(options.providers || DEFAULT_PROVIDERS.join(','))
    .split(',').map((item) => item.trim()).filter(Boolean);
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    gateway: { url, stateDir: '<state-dir>' },
    providers: [],
  };

  const health = await request(url, token, { pathname: '/health', timeoutMs: 20000 });
  report.health = { status: health.status, bodySha256: stableHash(health.text) };
  if (health.status !== 200) throw new Error('authenticated /health returned HTTP ' + health.status);

  const modelsResponse = await request(url, token, { pathname: '/v1/models', timeoutMs: 20000 });
  if (modelsResponse.status !== 200) throw new Error('authenticated /v1/models returned HTTP ' + modelsResponse.status);
  const models = (JSON.parse(modelsResponse.text).data || []);
  report.models = { count: models.length, ids: models.map((model) => model.id) };

  for (const providerId of requestedProviders) {
    const entry = { providerId };
    try {
      const login = await request(url, token, { pathname: '/login-status?provider=' + encodeURIComponent(providerId), timeoutMs: 30000 });
      entry.login = { status: login.status, bodySha256: stableHash(login.text) };
      if (login.status !== 200) throw new Error('login status HTTP ' + login.status);
      const loginBody = JSON.parse(login.text);
      const snapshot = loginBody.login || {};
      entry.login.ready = snapshot.needsLogin !== true && snapshot.challenge !== true && snapshot.hasChatInput !== false;
      if (!entry.login.ready) {
        entry.status = 'blocked';
        entry.reason = snapshot.challenge ? 'challenge_required' : 'login_required';
        report.providers.push(entry);
        continue;
      }

      const model = chooseModel(providerId, models);
      if (!model) throw new Error('no advertised model for provider');
      entry.model = model.id;
      const marker = 'LIVE_SMOKE_' + providerId.toUpperCase() + '_OK';
      const completion = await request(url, token, {
        pathname: '/v1/chat/completions',
        method: 'POST',
        timeoutMs: 180000,
        body: {
          model: model.id,
          stream: true,
          messages: [{ role: 'user', content: 'Reply with exactly this marker and no other text: ' + marker }],
        },
      });
      entry.completion = { status: completion.status, ...parseSse(completion.text) };
      entry.status = completion.status === 200 && entry.completion.firstRole === 'assistant' && entry.completion.doneCount === 1 && !!entry.completion.finishReason
        ? 'passed' : 'failed';
      if (entry.status !== 'passed') entry.reason = 'sse_contract_not_met';
    } catch (error) {
      entry.status = 'failed';
      entry.reason = sanitizeString(error && error.message, stateDir);
    }
    report.providers.push(entry);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.providers.length > 0 && report.providers.every((entry) => entry.status === 'passed');
  const artifactDir = path.join(ROOT, 'output', 'live-smoke', report.startedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(sanitizeReport(report, stateDir), null, 2) + '\n', { mode: 0o600 });
  return { report, artifactDir };
}

async function main() {
  if (process.env.DSWEB_LIVE_TEST !== '1') throw new Error('Refusing live browser usage. Set DSWEB_LIVE_TEST=1 to run.');
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) throw new Error('usage: node tests/live/run-live-smoke.js --url http://127.0.0.1:5689 [--providers deepseek,chatgpt,qwen]');
  const stateDir = process.env.DSWEB_LIVE_BASE;
  if (!stateDir) throw new Error('DSWEB_LIVE_BASE must point to the isolated gateway state directory');
  const { report, artifactDir } = await run({ url: args.url, providers: args.providers, stateDir });
  console.log(JSON.stringify(sanitizeReport({ ok: report.ok, artifactDir, providers: report.providers }, stateDir), null, 2));
  if (!report.ok) process.exitCode = 1;
}

module.exports = { parseArgs, sanitizeReport, parseSse, run };
if (require.main === module) main().catch((error) => { console.error('live-smoke failed: ' + (error.stack || error)); process.exitCode = 1; });
