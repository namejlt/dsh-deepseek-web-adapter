'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = path.join(ROOT, 'resources', 'dsweb-gateway.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
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

function waitFor(check, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const result = await check();
        if (result) return resolve(result);
      } catch (_) { /* retry until timeout */ }
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for gateway'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function makeFakeDriver(temp) {
  const file = path.join(temp, 'fake-driver.js');
  fs.writeFileSync(file, `#!/usr/bin/env node
'use strict';
// deepseek-web-driver.js fake offline RPC endpoint
let buffer = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) return;
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'inspect') send({ id: msg.id, ok: true, result: { login: { needsLogin: false, hasChatInput: true, bodySnippet: 'PRIVATE_PAGE_TEXT_MUST_NOT_LEAK', url: 'https://provider.example/private' } } });
    else send({ id: msg.id, ok: true, result: {} });
  }
});
send({ event: 'ready', version: 'security-test' });
`);
  return file;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-gateway-security-'));
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY, '--port', String(port), '--base', temp, '--no-migrate', '--driver', makeFakeDriver(temp)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitFor(async () => {
      const response = await request(port, 'GET', '/v1/models');
      return response.status > 0;
    });

    const unauthenticated = await request(port, 'GET', '/v1/models');
    assert.strictEqual(unauthenticated.status, 401, unauthenticated.text);
    assert.strictEqual(JSON.parse(unauthenticated.text).error.code, 'invalid_api_key');

    const tokenFile = path.join(temp, 'gateway-token');
    assert.ok(fs.existsSync(tokenFile), 'gateway must create a persistent bearer token');
    assert.ok(!fs.existsSync(path.join(temp, 'profiles')), '--no-migrate must keep an isolated state directory empty');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);

    const authorized = await request(port, 'GET', '/v1/models', null, { Authorization: 'Bearer ' + token });
    assert.strictEqual(authorized.status, 200, authorized.text);

    const loginStatus = await request(port, 'GET', '/login-status?provider=deepseek', null, { Authorization: 'Bearer ' + token });
    assert.strictEqual(loginStatus.status, 200, loginStatus.text);
    assert.ok(!loginStatus.text.includes('PRIVATE_PAGE_TEXT_MUST_NOT_LEAK'), loginStatus.text);
    assert.ok(!loginStatus.text.includes('bodySnippet'), loginStatus.text);
    assert.ok(!loginStatus.text.includes('provider.example/private'), loginStatus.text);

    const wrongToken = await request(port, 'POST', '/config', { headless: true }, { Authorization: 'Bearer wrong' });
    assert.strictEqual(wrongToken.status, 401, wrongToken.text);

    const evilPreflight = await request(port, 'OPTIONS', '/v1/models', null, { Origin: 'https://evil.example' });
    assert.strictEqual(evilPreflight.headers['access-control-allow-origin'], undefined);

    const managementRoot = await request(port, 'GET', '/');
    assert.strictEqual(managementRoot.status, 200, managementRoot.text);
    const cookie = Array.isArray(managementRoot.headers['set-cookie']) ? managementRoot.headers['set-cookie'][0] : managementRoot.headers['set-cookie'];
    assert.match(String(cookie), /HttpOnly/i);
    assert.match(String(cookie), /SameSite=Strict/i);
    const cookieHeader = String(cookie).split(';')[0];
    const sameOrigin = 'http://127.0.0.1:' + port;

    const managementHealth = await request(port, 'GET', '/health', null, { Cookie: cookieHeader, Origin: sameOrigin });
    assert.strictEqual(managementHealth.status, 200, managementHealth.text);
    const health = JSON.parse(managementHealth.text);
    assert.ok(health.instanceId);
    assert.ok(health.protocolVersion);

    const crossOriginHealth = await request(port, 'GET', '/health', null, { Cookie: cookieHeader, Origin: 'https://evil.example' });
    assert.strictEqual(crossOriginHealth.status, 403, crossOriginHealth.text);

    console.log('PASS gateway requires bearer API authentication and same-origin management sessions');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
