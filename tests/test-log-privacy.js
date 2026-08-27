'use strict';

const assert = require('assert');
const driver = require('../resources/driver');

assert.strictEqual(typeof driver.summarizeTextForLog, 'function', 'driver must export summarizeTextForLog');
assert.strictEqual(typeof driver.summarizeToolCallsForLog, 'function', 'driver must export summarizeToolCallsForLog');

const textSummary = driver.summarizeTextForLog('secret answer text', 120);
assert.deepStrictEqual(Object.keys(textSummary).sort(), ['length', 'sha256']);
assert.strictEqual(textSummary.length, 18);
assert.match(textSummary.sha256, /^[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(textSummary).includes('secret answer text'));

const toolSummary = driver.summarizeToolCallsForLog([
  { function: { name: 'read', arguments: '{"file_path":"/tmp/private.txt"}' } },
  { function: { name: 'pwsh', arguments: '{"command":"cat secret.txt"}' } },
]);
assert.deepStrictEqual(toolSummary, { count: 2, names: ['read', 'pwsh'] });
assert.ok(!JSON.stringify(toolSummary).includes('private.txt'));
assert.ok(!JSON.stringify(toolSummary).includes('cat secret.txt'));

console.log('PASS driver log summaries omit response text and tool arguments');
