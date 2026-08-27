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

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

function sse(res, model, content) {
  const created = 1700000000;
  const id = 'chatcmpl-test-' + model;
  const first = Math.max(1, Math.floor(content.length / 2));
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: content.slice(0, first) }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: content.slice(first) }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function completion(res, model, content) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    id: 'chatcmpl-json-' + model,
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }));
}

function makeServer(options = {}) {
  const blocked = new Set(options.blockedProviders || []);
  const transient = Object.assign(Object.create(null), options.transientLoginProviders || {});
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad token', code: 'invalid_api_key' } }));
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, instanceId: 'fake', protocolVersion: '2' }));
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const payload = JSON.parse(await bodyOf(req));
      requests.push({ config: payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, config: payload }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [
        { id: 'deepseek-chat', owned_by: 'deepseek-web' },
        { id: 'deepseek-reasoner', owned_by: 'deepseek-web' },
        { id: 'deepseek-search', owned_by: 'deepseek-web' },
        { id: 'chatgpt-auto', owned_by: 'chatgpt-web' },
        { id: 'chatgpt-thinking', owned_by: 'chatgpt-web' },
        { id: 'qwen-auto', owned_by: 'qwen-web' },
        { id: 'qwen-thinking', owned_by: 'qwen-web' },
      ] }));
    }
    if (req.method === 'GET' && url.pathname === '/login-status') {
      const providerId = url.searchParams.get('provider');
      if (transient[providerId] > 0) {
        transient[providerId]--;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, providerId, login: { needsLogin: false, hasChatInput: false } }));
      }
      const ready = !blocked.has(providerId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, providerId, login: ready ? { needsLogin: false, hasChatInput: true } : { needsLogin: true } }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const payload = JSON.parse(await bodyOf(req));
      requests.push({ model: payload.model, stream: payload.stream !== false, prompt: payload.messages[0].content });
      if (payload.model === 'no-such-model') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' } }));
      }
      const prompt = payload.messages[0].content;
      let content = '';
      const exactMarker = /Reply with exactly this marker and no other text(?: after completing the thinking-or-mode-switch request)?:\s*([^\n]+)/.exec(prompt);
      if (exactMarker) content = exactMarker[1].trim();
      else {
        const exactBlock = /must be exactly:\n([\s\S]+)$/.exec(prompt);
        if (exactBlock) content = '\n' + exactBlock[1].trim() + '\n';
      }
      if (!content) content = 'UNMATCHED_PROMPT_' + payload.model;
      if (payload.stream === false) return completion(res, payload.model, content);
      return sse(res, payload.model, content);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, requests };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-live-matrix-'));
  fs.writeFileSync(path.join(dir, 'gateway-token'), 'test-token\n');
  {
    const port = await freePort();
    const { server, requests } = makeServer();
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const { report } = await run({ url: 'http://127.0.0.1:' + port, stateDir: dir, providers: 'deepseek,chatgpt,qwen' });
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.errorContracts.invalidModel.status, 404);
      for (const [providerId, thinkingModel] of [['deepseek', 'deepseek-search'], ['chatgpt', 'chatgpt-thinking'], ['qwen', 'qwen-thinking']]) {
        const provider = report.providers.find((entry) => entry.providerId === providerId);
        assert.strictEqual(provider.status, 'passed');
        assert.strictEqual(provider.scenarios.basicStream.status, 'passed');
        assert.strictEqual(provider.scenarios.nonStream.status, 'passed');
        assert.strictEqual(provider.scenarios.codeBlock.status, 'passed');
        assert.strictEqual(provider.scenarios.codeBlock.codeBlockMarkerMatched, true);
        assert.strictEqual(provider.scenarios.thinking.status, 'passed');
        assert.strictEqual(provider.scenarios.thinking.model, thinkingModel);
      }
      assert.ok(requests.some((request) => request.config && request.config.maxConcurrent === 1 && request.config.maxPages === 8), 'matrix must pin a stable preflight config');
      assert.ok(requests.some((request) => request.stream === false), 'matrix must exercise non-stream mode');
      assert.ok(requests.some((request) => /code block/i.test(request.prompt)), 'matrix must exercise code prompt');
      assert.ok(requests.some((request) => /thinking/i.test(request.prompt)), 'matrix must exercise thinking/model switch');
    } finally {
      server.close();
    }
  }

  {
    const port = await freePort();
    const { server } = makeServer({ transientLoginProviders: { chatgpt: 1 } });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const { report } = await run({ url: 'http://127.0.0.1:' + port, stateDir: dir, providers: 'chatgpt' });
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.providers[0].status, 'passed');
      assert.strictEqual(report.providers[0].login.ready, true);
    } finally {
      server.close();
    }
  }
  {
    const port = await freePort();
    const { server } = makeServer({ blockedProviders: ['chatgpt'] });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const { report } = await run({ url: 'http://127.0.0.1:' + port, stateDir: dir, providers: 'chatgpt' });
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.providers[0].providerId, 'chatgpt');
      assert.strictEqual(report.providers[0].status, 'blocked');
      assert.strictEqual(report.providers[0].reason, 'login_required');
      assert.strictEqual(report.providers[0].scenarios, undefined);
    } finally {
      server.close();
    }
  }
  console.log('PASS live smoke matrix covers stream, non-stream, code, thinking, and blocked providers');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
