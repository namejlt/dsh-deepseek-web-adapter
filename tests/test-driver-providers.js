/* Offline unit tests for provider-scoped driver identities.
 * Run: node tests/test-driver-providers.js */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const driver = require('../resources/driver');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (error) {
    fail++;
    console.error('FAIL ' + name + ' | ' + error.message);
  }
}

check('passive provider inspection never switches profiles or reuses another provider tab', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'resources', 'driver.js'), 'utf8');
  assert(/const passive = !!\(params && params\.passive\) \|\| streamActive > 0;/.test(source));
  assert(/profileInactive: true/.test(source));
  assert(/if \(!pid && passive\) \{/.test(source));
  assert(/else if \(!pid\) \{[\s\S]*?await ensurePage/.test(source));
});

check('skips treating the previous adapter answer as a new reply', () => {
  assert.strictEqual(typeof driver.shouldSkipAdapterBaseline, 'function');
  assert.strictEqual(driver.shouldSkipAdapterBaseline('old response', 'old response', false), true);
  assert.strictEqual(driver.shouldSkipAdapterBaseline('new response', 'old response', false), false);
});

check('computes the first adapter delta against the pre-send baseline', () => {
  assert.strictEqual(typeof driver.computeAdapterDelta, 'function');
  assert.strictEqual(driver.computeAdapterDelta('old response', '', 'old response', false), '');
  assert.strictEqual(driver.computeAdapterDelta('old response\nnew line', '', 'old response', false), '\nnew line');
  assert.strictEqual(driver.computeAdapterDelta('brand new', '', 'old response', false), 'brand new');
  assert.strictEqual(driver.computeAdapterDelta('第一段正文\n第二段正文', '第一段正文', '', true), '\n第二段正文');
});

check('exports pure provider identity helpers', () => {
  assert.strictEqual(typeof driver.profileKey, 'function');
  assert.strictEqual(typeof driver.channelKey, 'function');
  assert.strictEqual(typeof driver.resolveProviderAdapter, 'function');
});

check('finishes a stable adapter response when a stale generating control persists', () => {
  assert.strictEqual(typeof driver.shouldFinishAdapterResponse, 'function');
  assert.strictEqual(driver.shouldFinishAdapterResponse({
    sawText: true, generating: true, lastChangeAt: 1000, now: 6000,
  }), true);
});

check('does not finish an adapter response without extracted text', () => {
  assert.strictEqual(driver.shouldFinishAdapterResponse({
    sawText: false, generating: false, lastChangeAt: 1000, now: 6000,
  }), false);
});

check('waits for the short normal stability window after a confirmed stop', () => {
  assert.strictEqual(driver.shouldFinishAdapterResponse({
    sawText: true, generating: false, lastChangeAt: 1000, now: 2199,
  }), false);
  assert.strictEqual(driver.shouldFinishAdapterResponse({
    sawText: true, generating: false, lastChangeAt: 1000, now: 2200,
  }), true);
});

check('uses provider-default profiles without breaking explicit legacy DeepSeek default', () => {
  assert.strictEqual(driver.profileKey('chatgpt'), 'chatgpt-default');
  assert.strictEqual(driver.profileKey('qwen'), 'qwen-default');
  assert.strictEqual(driver.profileKey('deepseek'), 'deepseek-default');
  assert.strictEqual(driver.profileKey('deepseek', 'default'), 'default');
  assert.strictEqual(driver.profileKey('chatgpt', 'default'), 'chatgpt-default');
});

check('keeps same named channels isolated by provider', () => {
  assert.strictEqual(driver.channelKey('deepseek', 'main'), 'deepseek:main');
  assert.strictEqual(driver.channelKey('chatgpt', 'main'), 'chatgpt:main');
  assert.strictEqual(driver.channelKey('qwen', 'main'), 'qwen:main');
  assert.notStrictEqual(driver.channelKey('deepseek', 'main'), driver.channelKey('chatgpt', 'main'));
});

check('resolves adapter URLs and rejects unknown providers', () => {
  assert.strictEqual(driver.resolveProviderAdapter('chatgpt').siteUrl, 'https://chatgpt.com/');
  assert.strictEqual(driver.resolveProviderAdapter('qwen').siteUrl, 'https://www.qianwen.com/');
  assert.throws(() => driver.resolveProviderAdapter('missing'), /unknown provider: missing/);
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
