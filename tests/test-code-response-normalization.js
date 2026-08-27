'use strict';

const assert = require('assert');
const { normalizeCodeResponse } = require('./live/run-live-smoke');

assert.strictEqual(normalizeCodeResponse('text\n\n复制\n\n下载\n\n```\nLIVE_SMOKE_DEEPSEEK_CODE_OK\n```'), 'LIVE_SMOKE_DEEPSEEK_CODE_OK');
assert.strictEqual(normalizeCodeResponse('1LIVE_SMOKE_QWEN_CODE_OK'), 'LIVE_SMOKE_QWEN_CODE_OK');
assert.strictEqual(normalizeCodeResponse('LIVE_SMOKE_CHATGPT_CODE_OK'), 'LIVE_SMOKE_CHATGPT_CODE_OK');

console.log('PASS code-response normalization strips widget chrome and line numbers');
