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
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-code-fallback-'));
  fs.writeFileSync(path.join(dir, 'gateway-token'), 'test-token\n');
  const port = await freePort();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessions: { count: 0, list: [] } }));
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', owned_by: 'deepseek-web' }, { id: 'deepseek-search', owned_by: 'deepseek-web' }] }));
    }
    if (req.method === 'GET' && url.pathname === '/login-status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, providerId: 'deepseek', login: { needsLogin: false, hasChatInput: true } }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const payload = JSON.parse(await bodyOf(req));
      seen.push({ stream: payload.stream !== false, prompt: payload.messages[0].content });
      if (payload.model === 'no-such-model') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'model_not_found' } }));
      }
      if (/code block/i.test(payload.messages[0].content) && payload.stream !== false) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        return res.end('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n' +
          'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: { content: '[错误] timeout: 等待 10s 未见新回复（页面可能卡死或发送失败），请重试' }, finish_reason: null }] }) + '\n\n' +
          'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n' +
          'data: [DONE]\n\n');
      }
      const content = /code block/i.test(payload.messages[0].content)
        ? 'text\n\n复制\n\n下载\n\n```\nLIVE_SMOKE_DEEPSEEK_CODE_OK\n```'
        : (/thinking-or-mode-switch/i.test(payload.messages[0].content) ? 'LIVE_SMOKE_DEEPSEEK_THINKING_OK' : 'LIVE_SMOKE_DEEPSEEK_STREAM_OK');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ id: 'json', object: 'chat.completion', created: 1, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    const { report } = await run({ url: 'http://127.0.0.1:' + port, stateDir: dir, providers: 'deepseek' });
    assert.strictEqual(report.providers[0].scenarios.codeBlock.status, 'passed');
    assert.ok(seen.some((row) => /code block/i.test(row.prompt) && row.stream === true), 'must try stream first');
    assert.ok(seen.some((row) => /code block/i.test(row.prompt) && row.stream === false), 'must retry code block as non-stream fallback');
    console.log('PASS code-block smoke falls back from stream timeout to non-stream verification');
  } finally {
    server.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
