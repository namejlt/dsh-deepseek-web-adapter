'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');
const cut = source.indexOf('server.listen(');
assert(cut > 0, 'gateway server.listen boundary missing');

const sandbox = {
  require: (name) => {
    if (name === './provider-registry') return require(path.join(ROOT, 'resources', 'provider-registry'));
    if (name === './state-store') return require(path.join(ROOT, 'resources', 'state-store'));
    return require(name);
  },
  process: { argv: ['node', 'gateway'], env: {}, on() {}, platform: process.platform },
  __dirname: path.join(ROOT, 'resources'),
  console: { log() {}, error() {}, warn() {} },
  setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math, Buffer,
};
vm.createContext(sandbox);
vm.runInContext(source.slice(0, cut) + '\n;globalThis.__sessionKey = { resolveSession, sessions };', sandbox, { filename: 'dsweb-gateway.js' });

(async () => {
  const api = sandbox.__sessionKey;
  const first = await api.resolveSession({
    metadata: { dsweb_session_key: 'live-smoke-qwen-key' },
    messages: [{ role: 'user', content: 'first prompt' }],
  }, 'qwen');
  const second = await api.resolveSession({
    metadata: { dsweb_session_key: 'live-smoke-qwen-key' },
    messages: [{ role: 'user', content: 'second prompt is intentionally different' }],
  }, 'qwen');
  assert.strictEqual(first.mode, 'first');
  assert.strictEqual(second.mode, 'delta');
  assert.strictEqual(first.session.id, second.session.id);
  assert.strictEqual(api.sessions.size, 1);
  console.log('PASS explicit metadata session key reuses first-turn session');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
