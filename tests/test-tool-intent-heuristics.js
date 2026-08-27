'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'resources', 'driver.js'), 'utf8');
const start = source.indexOf('function looksLikeToolCall');
const end = source.indexOf('/**\n * 流式问答', start);
assert(start >= 0 && end > start, 'looksLikeToolCall extraction boundary missing');
const looksLikeToolCall = new Function(source.slice(start, end) + '\nreturn looksLikeToolCall;')();

const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } }];
assert.strictEqual(looksLikeToolCall('```text\nLIVE_SMOKE_QWEN_CODE_OK\n```', tools), false, 'plain fenced code block must not trigger tool retry');
assert.strictEqual(looksLikeToolCall('```tool_call\n{"name":"read","arguments":{"file_path":"a.txt"}}\n```', tools), true, 'explicit tool_call block must still trigger tool retry');

console.log('PASS tool-intent heuristic ignores plain fenced code blocks');
