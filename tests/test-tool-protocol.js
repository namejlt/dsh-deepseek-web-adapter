'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const driverSource = fs.readFileSync(path.join(ROOT, 'resources', 'driver.js'), 'utf8');
const start = driverSource.indexOf('function parseToolCalls');
const end = driverSource.indexOf('\nhandlers.streamAsk', start);
assert(start >= 0 && end > start, 'driver parser extraction boundary missing');
const parseToolCalls = new Function(driverSource.slice(start, end) + '\nreturn parseToolCalls;')();

const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } } }];
assert.deepStrictEqual(parseToolCalls('{"name":"read","arguments":{"file_path":"a.txt"}}', tools, { protocol: 'strict' }), []);
assert.deepStrictEqual(parseToolCalls('<tool_call>{"name":"read","arguments":{}}</tool_call>', tools, { protocol: 'strict' }), []);
const explicit = parseToolCalls('```tool_call\n{"name":"read","arguments":{"file_path":"a.txt"}}\n```', tools, { protocol: 'strict' });
assert.strictEqual(explicit.length, 1);
assert.strictEqual(explicit[0].name, 'read');
assert.deepStrictEqual(JSON.parse(explicit[0].arguments), { file_path: 'a.txt' });

const gatewaySource = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');
const cut = gatewaySource.indexOf('server.listen(');
const sandbox = {
  require: (name) => {
    if (name === './provider-registry') return require(path.join(ROOT, 'resources', 'provider-registry'));
    if (name === './state-store') return require(path.join(ROOT, 'resources', 'state-store'));
    return require(name);
  },
  process: { argv: ['node', 'gateway'], env: {}, on() {}, platform: process.platform },
  __dirname: path.join(ROOT, 'resources'),
  console: { log() {}, error() {}, warn() {} },
  setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math, Buffer,
};
vm.createContext(sandbox);
vm.runInContext(gatewaySource.slice(0, cut) + '\n;globalThis.__toolMode = resolveToolMode;', sandbox);
assert.strictEqual(sandbox.__toolMode({ tools, tool_choice: 'none' }), 'disabled');
assert.strictEqual(sandbox.__toolMode({ tools }), 'strict');
assert.strictEqual(sandbox.__toolMode({ tools: [] }), 'disabled');

console.log('PASS strict tool protocol rejects prose JSON and honors tool_choice none');

const qwenToolText = '```tool_call\n{\n  "name": "echo_marker",\n  "args": {\n    "marker": "LIVE_TOOL_QWEN_OK"\n  }\n}\n```';
const echoTools = [{ type: 'function', function: { name: 'echo_marker', parameters: { type: 'object', required: ['marker'], properties: { marker: { type: 'string' } } } } }];
const qwenParsed = parseToolCalls(qwenToolText, echoTools, { protocol: 'strict' });
assert.strictEqual(qwenParsed.length, 1, 'Qwen explicit tool block must parse on adapter finalization');
assert.strictEqual(qwenParsed[0].name, 'echo_marker');
assert.deepStrictEqual(JSON.parse(qwenParsed[0].arguments), { marker: 'LIVE_TOOL_QWEN_OK' });
assert.match(driverSource, /const adapterToolCalls = parseToolCalls\(lastText, params && params\.tools/);
console.log('PASS adapter finalization parses strict Qwen tool-call blocks');

const deepseekUiWrapped = 'tool_call\n\n复制\n\n下载\n\n```\n{\n  "name": "echo_marker",\n  "args": {\n    "marker": "LIVE_TOOL_DEEPSEEK_OK"\n  }\n}\n```';
const deepseekParsed = parseToolCalls(deepseekUiWrapped, echoTools, { protocol: 'strict' });
assert.strictEqual(deepseekParsed.length, 1, 'DeepSeek UI-wrapped tool_call block must parse in strict mode');
assert.strictEqual(deepseekParsed[0].name, 'echo_marker');
assert.deepStrictEqual(JSON.parse(deepseekParsed[0].arguments), { marker: 'LIVE_TOOL_DEEPSEEK_OK' });
console.log('PASS strict parser tolerates DeepSeek UI-wrapped tool_call blocks');

const chatgptXmlInvoke = '<tool_calls><invoke name="echo_marker"><parameter name="marker">LIVE_TOOL_CHATGPT_OK</parameter></invoke></tool_calls>';
const chatgptParsed = parseToolCalls(chatgptXmlInvoke, echoTools, { protocol: 'strict' });
assert.strictEqual(chatgptParsed.length, 1, 'strict mode must accept explicit tool_calls invoke XML');
assert.strictEqual(chatgptParsed[0].name, 'echo_marker');
assert.deepStrictEqual(JSON.parse(chatgptParsed[0].arguments), { marker: 'LIVE_TOOL_CHATGPT_OK' });
console.log('PASS strict parser accepts explicit tool_calls invoke XML');

const chatgptBareToolCall = 'tool_call\n{"name":"echo_marker","args":{"marker":"LIVE_TOOL_CHATGPT_BLOCK"}}';
const chatgptBareParsed = parseToolCalls(chatgptBareToolCall, echoTools, { protocol: 'strict' });
assert.strictEqual(chatgptBareParsed.length, 1, 'strict mode must accept bare tool_call + JSON output');
assert.strictEqual(chatgptBareParsed[0].name, 'echo_marker');
assert.deepStrictEqual(JSON.parse(chatgptBareParsed[0].arguments), { marker: 'LIVE_TOOL_CHATGPT_BLOCK' });
console.log('PASS strict parser accepts bare tool_call plus JSON');
