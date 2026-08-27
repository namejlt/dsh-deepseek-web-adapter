'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { run } = require('./live/run-live-smoke');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

function sseResponse(res, model, content) {
  const created = 1700000000;
  const id = 'chatcmpl-' + model;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}

function jsonResponse(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function makeServer(options = {}) {
  const challengeProviders = new Set(options.challengeProviders || []);
  const requests = [];
  let cancelBusy = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad token', code: 'invalid_api_key' } }));
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const payload = JSON.parse(await readBody(req));
      requests.push({ config: payload });
      return jsonResponse(res, { ok: true, config: payload });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(res, { ok: true, instanceId: 'fake', protocolVersion: '2', sessions: { count: cancelBusy ? 1 : 0, list: cancelBusy ? [{ id: 'cancel-1', busy: true }] : [] } });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return jsonResponse(res, { object: 'list', data: [
        { id: 'deepseek-chat', owned_by: 'deepseek-web' },
        { id: 'deepseek-search', owned_by: 'deepseek-web' },
        { id: 'chatgpt-auto', owned_by: 'chatgpt-web' },
        { id: 'chatgpt-thinking', owned_by: 'chatgpt-web' },
        { id: 'qwen-auto', owned_by: 'qwen-web' },
        { id: 'qwen-thinking', owned_by: 'qwen-web' },
      ] });
    }
    if (req.method === 'GET' && url.pathname === '/login-status') {
      const providerId = url.searchParams.get('provider');
      if (challengeProviders.has(providerId)) return jsonResponse(res, { ok: true, providerId, login: { needsLogin: false, hasChatInput: false, challenge: true } });
      return jsonResponse(res, { ok: true, providerId, login: { needsLogin: false, hasChatInput: true } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const payload = JSON.parse(await readBody(req));
      requests.push(payload);
      if (payload.model === 'no-such-model') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }));
      }
      const prompt = payload.messages[0].content;
      if (/cancel smoke/i.test(prompt)) {
        cancelBusy = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write('data: ' + JSON.stringify({ id: 'cancel', object: 'chat.completion.chunk', created: 1700000000, model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
        const timer = setInterval(() => {
          try { res.write('data: ' + JSON.stringify({ id: 'cancel', object: 'chat.completion.chunk', created: 1700000000, model: payload.model, choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }) + '\n\n'); } catch (_) {}
        }, 200);
        const clearBusy = () => { clearInterval(timer); cancelBusy = false; try { res.end(); } catch (_) {} };
        req.on('close', clearBusy);
        res.on('close', clearBusy);
        return;
      }
      if (Array.isArray(payload.tools) && payload.tools.length) {
        const marker = /marker="([^"]+)"/.exec(prompt);
        return jsonResponse(res, {
          id: 'tool-' + payload.model,
          object: 'chat.completion',
          created: 1700000000,
          model: payload.model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: payload.tools[0].function.name, arguments: JSON.stringify({ marker: marker ? marker[1] : 'LIVE_TOOL_OK' }) } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      const exactMarker = /Reply with exactly this marker and no other text(?: after completing the thinking-or-mode-switch request)?:\s*([^\n]+)/.exec(prompt);
      const exactBlock = /must be exactly:\n([\s\S]+)$/.exec(prompt);
      const content = exactMarker ? exactMarker[1].trim() : (exactBlock ? '\n' + exactBlock[1].trim() + '\n' : 'LIVE_SMOKE');
      if (payload.stream === false) {
        return jsonResponse(res, { id: 'json-' + payload.model, object: 'chat.completion', created: 1700000000, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      return sseResponse(res, payload.model, content);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, requests };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-live-advanced-'));
  fs.writeFileSync(path.join(dir, 'gateway-token'), 'test-token\n');
  {
    const port = await freePort();
    const { server, requests } = makeServer();
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const { report } = await run({ url: 'http://127.0.0.1:' + port, stateDir: dir, providers: 'deepseek' });
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.cancelContract.status, 'passed');
      assert.strictEqual(report.cancelContract.healthRecovered, true);
      assert.strictEqual(report.providers[0].scenarios.toolCall.status, 'passed');
      assert.strictEqual(report.providers[0].scenarios.toolCall.finishReason, 'tool_calls');
      assert.strictEqual(report.providers[0].scenarios.toolCall.toolCalls, 1);
      assert.strictEqual(report.providers[0].scenarios.toolCall.functionName, 'echo_marker');
      assert.ok(requests.some((request) => Array.isArray(request.tools) && request.tools.length === 1), 'matrix must issue a tool-call request');
      assert.ok(requests.some((request) => typeof request.messages?.[0]?.content === 'string' && /cancel smoke/i.test(request.messages[0].content)), 'matrix must issue a cancel request');
    } finally {
      server.close();
    }
  }
  {
    const port = await freePort();
    const { server } = makeServer({ challengeProviders: ['chatgpt'] });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const { report } = await run({ url: 'http://127.0.0.1:' + port, stateDir: dir, providers: 'chatgpt' });
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.providers[0].status, 'blocked');
      assert.strictEqual(report.providers[0].reason, 'challenge_required');
    } finally {
      server.close();
    }
  }
  console.log('PASS advanced live smoke covers tool_calls, cancel, and challenge detection');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
