'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'npm pack --dry-run failed');
  process.exit(result.status || 1);
}
const reports = JSON.parse(result.stdout);
assert.ok(Array.isArray(reports) && reports.length === 1, 'npm pack must emit exactly one report');
const files = reports[0].files.map((entry) => entry.path).sort();
const forbidden = files.filter((file) => /^(resources\/runtime\/|tests\/|output\/|\.playwright-cli\/)/.test(file));
assert.deepStrictEqual(forbidden, [], 'npm package must not include mutable runtime, tests, or local verification artifacts: ' + forbidden.join(', '));
for (const required of ['lib/index.js', 'resources/dsweb-gateway.js', 'resources/driver.js', 'resources/state-store.js', 'resources/providers/chatgpt.js', 'resources/providers/qwen.js']) {
  assert.ok(files.includes(required), 'runtime package missing ' + required);
}
console.log('PASS npm package contains runtime sources only (' + files.length + ' files)');
