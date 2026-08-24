/* Offline integration test for gateway provider routing with a fake JSON-lines driver.
 * Run: node tests/test-gateway-providers.js */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = path.join(ROOT, 'resources', 'dsweb-gateway.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-provider-gateway-'));
const recordsFile = path.join(temp, 'driver-records.jsonl');
const fakeDriver = path.join(temp, 'fake-driver.js');

fs.writeFileSync(fakeDriver, `#!/usr/bin/env node
// deepseek-web-driver.js fake offline RPC endpoint
'use strict';
const fs = require('fs');
const records = process.env.FAKE_DRIVER_RECORDS;
function out(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function record(value) { fs.appendFileSync(records, JSON.stringify(value) + '\\n'); }
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line); record(msg);
    if (msg.method === 'streamAsk') {
      const streamId = 'fake-' + msg.id;
      const errorKinds = { 'chatgpt-thinking': 'mode_unavailable', 'qwen-chat': 'challenge_required', 'qwen-search': 'dom_unavailable' };
      const errorKind = msg.params && msg.params.model && errorKinds[msg.params.model.id];
      out({ id: msg.id, ok: true, result: { streamId } });
      setTimeout(() => out(errorKind
        ? { event: 'stream-end', streamId, ok: false, errorKind, error: 'fake ' + errorKind }
        : { event: 'stream-end', streamId, ok: true, result: 'fake answer' }), 5);
    } else if (msg.method === 'inspect') {
      out({ id: msg.id, ok: true, result: { login: { needsLogin: false, hasChatInput: true } } });
    } else if (msg.method === 'login') {
      out({ id: msg.id, ok: true, result: { ok: true, loggedIn: true } });
    } else if (msg.method === 'releaseChannel' || msg.method === 'streamStop') {
      out({ id: msg.id, ok: true, result: { ok: true } });
    } else {
      out({ id: msg.id, ok: true, result: {} });
    }
  }
});
out({ event: 'ready', version: 'fake' });
`);

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

function waitFor(check, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch (_) { /* retry */ }
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function driverRecords() {
  if (!fs.existsSync(recordsFile)) return [];
  return fs.readFileSync(recordsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

(async () => {
  const gatewaySource = fs.readFileSync(GATEWAY, 'utf8');
  const bootstrapCut = gatewaySource.indexOf('server.listen(');
  assert(bootstrapCut > 0, 'gateway must expose a server.listen bootstrap boundary');
  assert.doesNotThrow(() => new vm.Script(gatewaySource.slice(0, bootstrapCut), { filename: 'gateway-bootstrap-prefix.js' }), 'prefix before first server.listen must remain syntactically complete for offline VM tests');
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY, '--port', String(port), '--base', temp, '--driver', fakeDriver], {
    cwd: ROOT,
    env: { ...process.env, FAKE_DRIVER_RECORDS: recordsFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await waitFor(async () => (await request(port, 'GET', '/v1/models')).status === 200);

    const modelsResponse = await request(port, 'GET', '/v1/models');
    const models = JSON.parse(modelsResponse.text).data;
    assert.strictEqual(models.length, 13, 'all provider models must be advertised');
    assert.deepStrictEqual(models.map((model) => model.owned_by), models.map((model) => model.id.split('-')[0] + '-web'));

    const beforeUnknown = driverRecords().filter((record) => record.method === 'streamAsk').length;
    const unknown = await request(port, 'POST', '/v1/chat/completions', { model: 'no-such-model', messages: [{ role: 'user', content: 'hello' }], stream: false });
    assert.strictEqual(unknown.status, 404, unknown.text);
    assert.strictEqual(driverRecords().filter((record) => record.method === 'streamAsk').length, beforeUnknown, 'unknown model must not reach the driver');

    for (const expected of [
      { id: 'deepseek-chat', providerId: 'deepseek', profile: 'deepseek-default' },
      { id: 'chatgpt-auto', providerId: 'chatgpt', profile: 'chatgpt-default' },
      { id: 'qwen-thinking', providerId: 'qwen', profile: 'qwen-default' },
    ]) {
      const response = await request(port, 'POST', '/v1/chat/completions', { model: expected.id, messages: [{ role: 'user', content: 'same prompt' }], stream: false });
      assert.strictEqual(response.status, 200, response.text);
      await waitFor(() => driverRecords().some((record) => record.method === 'streamAsk' && record.params && record.params.providerId === expected.providerId));
      const ask = driverRecords().filter((record) => record.method === 'streamAsk' && record.params.providerId === expected.providerId).at(-1).params;
      assert.strictEqual(ask.profile, expected.profile);
      assert.strictEqual(ask.model.id, expected.id);
      assert.strictEqual(ask.model.providerId, expected.providerId);
    }

    const asks = driverRecords().filter((record) => record.method === 'streamAsk').map((record) => record.params);
    assert.notStrictEqual(asks.find((ask) => ask.providerId === 'chatgpt').pageKey, asks.find((ask) => ask.providerId === 'qwen').pageKey, 'same messages must not reuse channels across providers');

    for (const expected of [
      { model: 'chatgpt-thinking', status: 422, code: 'provider_mode_unavailable' },
      { model: 'qwen-chat', status: 403, code: 'provider_challenge_required' },
      { model: 'qwen-search', status: 503, code: 'provider_dom_unavailable' },
    ]) {
      const response = await request(port, 'POST', '/v1/chat/completions', { model: expected.model, messages: [{ role: 'user', content: 'error route' }], stream: false });
      const body = JSON.parse(response.text);
      assert.strictEqual(response.status, expected.status, response.text);
      assert.strictEqual(body.error.code, expected.code, response.text);
    }

    const login = await request(port, 'GET', '/login?provider=qwen');
    assert.strictEqual(login.status, 200);
    await waitFor(() => driverRecords().some((record) => record.method === 'login' && record.params.providerId === 'qwen'));
    const loginRpc = driverRecords().filter((record) => record.method === 'login' && record.params.providerId === 'qwen').at(-1);
    assert.strictEqual(loginRpc.params.profile, 'qwen-default');
    assert.strictEqual((await request(port, 'GET', '/login-status?provider=chatgpt')).status, 200);
    assert.strictEqual((await request(port, 'GET', '/login?provider=missing')).status, 400);

    console.log('PASS gateway provider routing, identities, and login provider selection');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL gateway provider integration | ' + error.stack);
  process.exitCode = 1;
});
