'use strict';

const assert = require('assert');
const { analyzeCodeBlockContent } = require('./live/run-live-smoke');

let result = analyzeCodeBlockContent('```text\nLIVE_SMOKE_DEEPSEEK_CODE_OK\n```\n复制\n下载\n```text\nLIVE_SMOKE_DEEPSEEK_CODE_OK\n```', 'LIVE_SMOKE_DEEPSEEK_CODE_OK');
assert.strictEqual(result.codeBlockMarkerMatched, true, 'duplicate fenced blocks must still count as a marker hit');

result = analyzeCodeBlockContent('检索中...\n1LIVE_SMOKE_QWEN_CODE_OK\n1LIVE_SMOKE_QWEN_CODE_OK', 'LIVE_SMOKE_QWEN_CODE_OK');
assert.strictEqual(result.codeBlockMarkerMatched, true, 'search placeholder plus duplicated marker lines must still count as a marker hit');

console.log('PASS code marker detection tolerates repeated blocks and provider UI chrome');
