'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../resources/state-store');

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log('PASS ' + name);
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

check('resolves platform user state directories with explicit environment overrides', () => {
  assert.strictEqual(
    store.resolveStateDir({ platform: 'linux', home: '/home/tester', env: {} }),
    '/home/tester/.local/state/dsh-web-adapter',
  );
  assert.strictEqual(
    store.resolveStateDir({ platform: 'linux', home: '/home/tester', env: { XDG_STATE_HOME: '/state' } }),
    '/state/dsh-web-adapter',
  );
  assert.strictEqual(
    store.resolveStateDir({ platform: 'darwin', home: '/Users/tester', env: {} }),
    '/Users/tester/Library/Application Support/dsh-web-adapter',
  );
  assert.strictEqual(
    store.resolveStateDir({ platform: 'win32', home: 'C:\\Users\\tester', env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' } }),
    path.win32.join('C:\\Users\\tester\\AppData\\Local', 'dsh-web-adapter'),
  );
  assert.strictEqual(
    store.resolveStateDir({ platform: 'linux', home: '/home/tester', env: { DSWEB_STATE_DIR: '/explicit' } }),
    '/explicit',
  );
});

check('creates a stable private gateway secret', () => {
  const dir = makeTemp('dsweb-state-token-');
  const file = path.join(dir, 'gateway-token');
  const first = store.readOrCreateSecret(file);
  const second = store.readOrCreateSecret(file);
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  assert.strictEqual(first, second);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), first);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

check('writes JSON atomically without leaving temporary files', () => {
  const dir = makeTemp('dsweb-state-json-');
  const file = path.join(dir, 'accounts.json');
  const payload = { version: 1, accounts: [{ name: 'default', state: 'active' }] };
  store.writeJsonAtomic(file, payload);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), payload);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['accounts.json']);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

check('migrates legacy profiles and JSON only into an empty destination', () => {
  const legacy = makeTemp('dsweb-state-legacy-');
  const destination = makeTemp('dsweb-state-destination-');
  fs.mkdirSync(path.join(legacy, 'profiles', 'deepseek-default'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'profiles', 'deepseek-default', 'marker.txt'), 'legacy-profile');
  fs.writeFileSync(path.join(legacy, 'accounts.json'), '{"accounts":[]}');
  fs.writeFileSync(path.join(legacy, 'calibration.json'), '{}');

  const first = store.migrateLegacyState({ legacyDir: legacy, destinationDir: destination });
  assert.deepStrictEqual(first.copied.sort(), ['accounts.json', 'calibration.json', 'profiles']);
  assert.strictEqual(fs.readFileSync(path.join(destination, 'profiles', 'deepseek-default', 'marker.txt'), 'utf8'), 'legacy-profile');

  fs.writeFileSync(path.join(destination, 'accounts.json'), '{"accounts":["new"]}');
  const second = store.migrateLegacyState({ legacyDir: legacy, destinationDir: destination });
  assert.deepStrictEqual(second.copied, []);
  assert.deepStrictEqual(second.skipped.sort(), ['accounts.json', 'calibration.json', 'profiles']);
  assert.strictEqual(fs.readFileSync(path.join(destination, 'accounts.json'), 'utf8'), '{"accounts":["new"]}');
});

console.log('\n结果: ' + pass + ' 通过, 0 失败');
