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
/* “thinking/model-switch” 场景：DeepSeek 用 search 模式验证模式切换；
 * ChatGPT/Qwen 继续验证 thinking 模型。 */
const THINKING_MODELS = {
  deepseek: 'deepseek-search',
  chatgpt: 'chatgpt-thinking',
  qwen: 'qwen-thinking',
};
const SCENARIO_ORDER = ['basicStream', 'nonStream', 'codeBlock', 'thinking'];

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
    const headers = {};
    if (!options.omitAuth) headers.Authorization = 'Bearer ' + token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(options.pathname, url), {
      method: options.method || 'GET',
      headers,
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
  let content = '';
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
      if (delta && typeof delta.content === 'string') content += delta.content;
      if (delta && Array.isArray(delta.tool_calls)) toolCallChunks += delta.tool_calls.length;
    } catch (_) { /* keep hash-only evidence */ }
  }
  return { chunks, firstRole, finishReason, doneCount, toolCallChunks, content, wireSha256: stableHash(text) };
}

function parseJsonCompletion(text) {
  const payload = JSON.parse(String(text || '{}'));
  const choice = payload.choices && payload.choices[0];
  const message = choice && choice.message;
  return {
    role: message && message.role || null,
    finishReason: choice && choice.finish_reason || null,
    content: message && typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message && message.tool_calls) ? message.tool_calls.length : 0,
    bodySha256: stableHash(text),
  };
}

function chooseModel(providerId, models, preference) {
  const preferred = preference === 'thinking' ? THINKING_MODELS[providerId] : DEFAULT_MODELS[providerId];
  return models.find((model) => model.id === preferred) || (preference === 'default' ? models.find((model) => model.owned_by === providerId + '-web') || null : null);
}

function buildScenarioSpec(providerId, name, models) {
  const upper = providerId.toUpperCase();
  if (name === 'basicStream') {
    return {
      name,
      transport: 'sse',
      model: chooseModel(providerId, models, 'default'),
      expected: 'LIVE_SMOKE_' + upper + '_STREAM_OK',
      prompt: 'Reply with exactly this marker and no other text: LIVE_SMOKE_' + upper + '_STREAM_OK',
    };
  }
  if (name === 'nonStream') {
    return {
      name,
      transport: 'json',
      model: chooseModel(providerId, models, 'default'),
      expected: 'LIVE_SMOKE_' + upper + '_JSON_OK',
      prompt: 'Reply with exactly this marker and no other text: LIVE_SMOKE_' + upper + '_JSON_OK',
    };
  }
  if (name === 'codeBlock') {
    return {
      name,
      transport: 'sse',
      model: chooseModel(providerId, models, 'default'),
      expected: '```text\nLIVE_SMOKE_' + upper + '_CODE_OK\n```',
      prompt: 'Reply with exactly one fenced Markdown code block and no prose. Do not explain. The full response must be exactly:\n```text\nLIVE_SMOKE_' + upper + '_CODE_OK\n```',
      fallbackPrompt: '请只输出下面这一个 Markdown 代码块，不要解释，不要添加任何前后文字：\n```text\nLIVE_SMOKE_' + upper + '_CODE_OK\n```',
    };
  }
  if (name === 'thinking') {
    return {
      name,
      transport: 'sse',
      model: chooseModel(providerId, models, 'thinking'),
      expected: 'LIVE_SMOKE_' + upper + '_THINKING_OK',
      prompt: 'Reply with exactly this marker and no other text after completing the thinking-or-mode-switch request: LIVE_SMOKE_' + upper + '_THINKING_OK',
    };
  }
  throw new Error('unknown scenario: ' + name);
}

function summarizeMatch(content, expected) {
  return {
    contentLength: content.length,
    contentSha256: stableHash(content),
    exactMatch: content === expected,
  };
}

function normalizeCodeResponse(content) {
  const raw = String(content == null ? '' : content).replace(/\r/g, '');
  const fenceMatch = raw.match(/```(?:[^\n`]*)\n([\s\S]*?)```/);
  if (fenceMatch) {
    return String(fenceMatch[1] || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(text|plaintext|copy|download|复制|下载)$/i.test(line))
      .join('\n')
      .trim();
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(text|plaintext|copy|download|复制|下载)$/i.test(line))
    .map((line) => line.replace(/^\d+(?=[A-Z_])/, ''))
    .join('\n')
    .trim();
}

function expectedCodeMarker(expectedBlock) {
  const match = String(expectedBlock || '').match(/```[^\n`]*\n([\s\S]*?)```/);
  return match ? String(match[1] || '').trim() : '';
}

function analyzeCodeBlockContent(content, marker) {
  const trimmed = String(content || '').trim();
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  const blocks = [...trimmed.matchAll(fenceRe)];
  const normalized = normalizeCodeResponse(content);
  return {
    codeBlockCount: blocks.length,
    singleCodeBlock: blocks.length === 1,
    codeBlockMarkerMatched: !!marker && normalized === marker,
    normalizedCodeSha256: stableHash(normalized),
    normalizedCodeLength: normalized.length,
  };
}

async function fetchLoginState(url, token, providerId) {
  const login = await request(url, token, { pathname: '/login-status?provider=' + encodeURIComponent(providerId), timeoutMs: 30000 });
  if (login.status !== 200) return { response: login, snapshot: { needsLogin: true } };
  const loginBody = JSON.parse(login.text);
  return { response: login, snapshot: loginBody.login || {} };
}

async function stableLoginState(url, token, providerId) {
  let latest = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    latest = await fetchLoginState(url, token, providerId);
    const snapshot = latest.snapshot || {};
    const ready = snapshot.needsLogin !== true && snapshot.challenge !== true && snapshot.hasChatInput !== false;
    if (ready) return { login: latest.response, snapshot, ready: true, attempts: attempt + 1 };
    if (snapshot.needsLogin === true || snapshot.challenge === true) return { login: latest.response, snapshot, ready: false, attempts: attempt + 1 };
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return { login: latest.response, snapshot: latest.snapshot || {}, ready: false, attempts: 3 };
}

async function runScenario(url, token, providerId, spec) {
  if (!spec.model) {
    return { status: 'skipped', reason: spec.name === 'thinking' ? 'thinking_model_not_advertised' : 'model_not_advertised' };
  }
  const send = (prompt, forceStream) => request(url, token, {
    pathname: '/v1/chat/completions',
    method: 'POST',
    timeoutMs: 180000,
    body: { model: spec.model.id, stream: forceStream, messages: [{ role: 'user', content: prompt }] },
  });
  let response = await send(spec.prompt, spec.transport === 'sse');
  if (spec.transport === 'sse') {
    let parsed = parseSse(response.text);
    let match = summarizeMatch(parsed.content, spec.expected);
    let codeBlock = spec.name === 'codeBlock' ? analyzeCodeBlockContent(parsed.content, expectedCodeMarker(spec.expected)) : null;
    let passed = response.status === 200
      && parsed.firstRole === 'assistant'
      && parsed.doneCount === 1
      && parsed.finishReason === 'stop'
      && parsed.toolCallChunks === 0
      && (match.exactMatch || (codeBlock && codeBlock.codeBlockMarkerMatched));
    if (!passed && spec.name === 'codeBlock' && spec.fallbackPrompt) {
      response = await send(spec.fallbackPrompt, true);
      parsed = parseSse(response.text);
      match = summarizeMatch(parsed.content, spec.expected);
      codeBlock = analyzeCodeBlockContent(parsed.content, expectedCodeMarker(spec.expected));
      passed = response.status === 200
        && parsed.firstRole === 'assistant'
        && parsed.doneCount === 1
        && parsed.finishReason === 'stop'
        && parsed.toolCallChunks === 0
        && (match.exactMatch || (codeBlock && codeBlock.codeBlockMarkerMatched));
    }
    return {
      status: passed ? 'passed' : 'failed',
      model: spec.model.id,
      transport: spec.transport,
      httpStatus: response.status,
      firstRole: parsed.firstRole,
      finishReason: parsed.finishReason,
      doneCount: parsed.doneCount,
      toolCallChunks: parsed.toolCallChunks,
      chunks: parsed.chunks,
      wireSha256: parsed.wireSha256,
      ...match,
      ...(codeBlock || {}),
      normalizedCodeExactMatch: codeBlock ? (normalizeCodeResponse(parsed.content) === expectedCodeMarker(spec.expected)) : undefined,
      reason: passed ? undefined : 'sse_contract_not_met',
    };
  }
  const parsed = parseJsonCompletion(response.text);
  const match = summarizeMatch(parsed.content, spec.expected);
  const status = response.status === 200 && parsed.role === 'assistant' && parsed.finishReason === 'stop' && match.exactMatch && parsed.toolCalls === 0
    ? 'passed' : 'failed';
  return {
    status,
    model: spec.model.id,
    transport: spec.transport,
    httpStatus: response.status,
    role: parsed.role,
    finishReason: parsed.finishReason,
    toolCalls: parsed.toolCalls,
    bodySha256: parsed.bodySha256,
    ...match,
    reason: status === 'passed' ? undefined : 'json_contract_not_met',
  };
}

async function applySmokeConfig(url, token) {
  const response = await request(url, token, {
    pathname: '/config',
    method: 'POST',
    timeoutMs: 20000,
    body: { maxConcurrent: 1, maxPages: 8 },
  });
  let ok = response.status === 200;
  try {
    const parsed = JSON.parse(response.text);
    if (parsed && parsed.ok === false) ok = false;
  } catch (_) { ok = false; }
  return { status: response.status, ok, bodySha256: stableHash(response.text) };
}

async function runErrorContracts(url, token) {
  const unauthenticated = await request(url, token, { pathname: '/v1/models', timeoutMs: 20000, omitAuth: true });
  let unauthCode = null;
  try { unauthCode = JSON.parse(unauthenticated.text).error.code || null; } catch (_) { /* ignore malformed body */ }
  const invalidModel = await request(url, token, {
    pathname: '/v1/chat/completions',
    method: 'POST',
    timeoutMs: 20000,
    body: { model: 'no-such-model', stream: false, messages: [{ role: 'user', content: 'live smoke invalid model probe' }] },
  });
  let invalidCode = null;
  try { invalidCode = JSON.parse(invalidModel.text).error.code || null; } catch (_) { /* ignore malformed body */ }
  return {
    unauthenticatedModels: { status: unauthenticated.status, code: unauthCode, bodySha256: stableHash(unauthenticated.text) },
    invalidModel: { status: invalidModel.status, code: invalidCode, bodySha256: stableHash(invalidModel.text) },
  };
}

async function run(options) {
  const url = String(options.url || '').replace(/\/+$/, '');
  const stateDir = options.stateDir;
  const token = fs.readFileSync(path.join(stateDir, 'gateway-token'), 'utf8').trim();
  if (!token) throw new Error('gateway-token is empty');
  const requestedProviders = String(options.providers || DEFAULT_PROVIDERS.join(','))
    .split(',').map((item) => item.trim()).filter(Boolean);
  const report = {
    schemaVersion: 2,
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
  report.preflightConfig = await applySmokeConfig(url, token);
  if (!report.preflightConfig.ok) throw new Error('preflight /config failed with HTTP ' + report.preflightConfig.status);
  report.errorContracts = await runErrorContracts(url, token);

  for (const providerId of requestedProviders) {
    const entry = { providerId };
    try {
      const loginState = await stableLoginState(url, token, providerId);
      entry.login = { status: loginState.login.status, bodySha256: stableHash(loginState.login.text), attempts: loginState.attempts, ready: loginState.ready };
      if (loginState.login.status !== 200) throw new Error('login status HTTP ' + loginState.login.status);
      const snapshot = loginState.snapshot || {};
      if (!entry.login.ready) {
        entry.status = 'blocked';
        entry.reason = snapshot.challenge ? 'challenge_required' : 'login_required';
        report.providers.push(entry);
        continue;
      }

      entry.scenarios = {};
      for (const scenarioName of SCENARIO_ORDER) {
        const spec = buildScenarioSpec(providerId, scenarioName, models);
        entry.scenarios[scenarioName] = await runScenario(url, token, providerId, spec);
      }
      const scenarioStates = Object.values(entry.scenarios).map((scenario) => scenario.status);
      entry.status = scenarioStates.includes('failed') ? 'failed' : 'passed';
      if (entry.status !== 'passed') entry.reason = 'scenario_failure';
    } catch (error) {
      entry.status = 'failed';
      entry.reason = sanitizeString(error && error.message, stateDir);
    }
    report.providers.push(entry);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.providers.length > 0
    && report.providers.every((entry) => entry.status === 'passed')
    && report.errorContracts.unauthenticatedModels.status === 401
    && report.errorContracts.invalidModel.status === 404;
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
  console.log(JSON.stringify(sanitizeReport({ ok: report.ok, artifactDir, preflightConfig: report.preflightConfig, errorContracts: report.errorContracts, providers: report.providers }, stateDir), null, 2));
  if (!report.ok) process.exitCode = 1;
}

module.exports = {
  parseArgs,
  sanitizeReport,
  parseSse,
  parseJsonCompletion,
  run,
  runErrorContracts,
  buildScenarioSpec,
  applySmokeConfig,
  normalizeCodeResponse,
  analyzeCodeBlockContent,
};
if (require.main === module) main().catch((error) => { console.error('live-smoke failed: ' + (error.stack || error)); process.exitCode = 1; });
