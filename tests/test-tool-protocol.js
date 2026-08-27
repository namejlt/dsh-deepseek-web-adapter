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
