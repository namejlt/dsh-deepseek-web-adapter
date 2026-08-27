'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const testFiles = fs.readdirSync(__dirname)
  .filter((file) => /^test-.*\.js$/.test(file))
  .sort();

let failures = 0;
for (const file of testFiles) {
  console.log('\n===== tests/' + file + ' =====');
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) failures++;
}
console.log('\n===== test summary =====');
console.log('files=' + testFiles.length + ' failures=' + failures);
process.exitCode = failures ? 1 : 0;
