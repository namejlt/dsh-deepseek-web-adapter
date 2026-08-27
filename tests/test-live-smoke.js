'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, 'live', 'run-live-smoke.js');
const blocked = spawnSync(process.execPath, [runner, '--url', 'http://127.0.0.1:5689'], { encoding: 'utf8' });
assert.notStrictEqual(blocked.status, 0, 'live runner must refuse accidental execution');
assert.match((blocked.stderr || '') + (blocked.stdout || ''), /DSWEB_LIVE_TEST=1/);

const { sanitizeReport } = require(runner);
const value = sanitizeReport({
  authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
  profile: '/Users/tester/work/.local/live-smoke/profiles/chatgpt-default',
  nested: ['Bearer abcdefghijklmnopqrstuvwxyz', { path: '/Users/tester/work/.local/live-smoke/gateway-token' }],
}, '/Users/tester/work/.local/live-smoke');
const serialized = JSON.stringify(value);
assert.ok(!serialized.includes('abcdefghijklmnop'));
assert.ok(!serialized.includes('/Users/tester/work/.local/live-smoke'));
assert.ok(serialized.includes('<redacted-bearer>'));
assert.ok(serialized.includes('<state-dir>'));

console.log('PASS live smoke requires explicit opt-in and sanitizes local credentials/paths');
