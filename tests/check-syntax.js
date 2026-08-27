'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const targets = [
  'lib/index.js',
  'resources/driver.js',
  'resources/dsweb-gateway.js',
  'resources/provider-registry.js',
  'resources/state-store.js',
  ...fs.readdirSync(path.join(ROOT, 'resources', 'providers')).filter((file) => file.endsWith('.js')).map((file) => path.join('resources', 'providers', file)),
];
for (const target of targets) {
  const result = spawnSync(process.execPath, ['--check', target], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
console.log('PASS node --check (' + targets.length + ' runtime files)');
