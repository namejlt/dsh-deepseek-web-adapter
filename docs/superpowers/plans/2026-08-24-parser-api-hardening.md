# Parser and OpenAI API Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every parsed tool call is authorized, prevent fragmented tool markup from leaking into OpenAI SSE content, and return OpenAI-style errors before invalid requests reach the browser driver.

**Architecture:** Keep the existing gateway/driver split. `resources/driver.js` remains responsible for parsing web text into tool-call candidates, but every syntax path is routed through its existing authorization and schema-normalization function. `resources/dsweb-gateway.js` adds pure request/prefix predicates around the current response loop, preserving session, account-pool, and driver transport behavior.

**Tech Stack:** Node.js CommonJS driver, Node.js HTTP/SSE gateway, VM-backed offline JavaScript tests run with `node`.

---

## File structure

- Modify: `resources/driver.js` — funnel XML and Python parser candidates through `pushCall()`.
- Modify: `resources/dsweb-gateway.js` — validate chat payloads and buffer incomplete tool-call prefixes in streaming responses.
- Modify: `tests/test-parser-all.js` — parser authorization regression cases.
- Modify: `tests/test-account-pool.js` — mocked gateway API/error and streaming-boundary regression cases.

### Task 1: Lock down XML and Python tool parser paths

**Files:**
- Modify: `tests/test-parser-all.js:120-172`
- Modify: `resources/driver.js:2603-2629,2802-2823`

- [ ] **Step 1: Add parser failures for unapproved compatibility formats**

Append these cases after the existing XML/Python compatibility cases in `tests/test-parser-all.js`:

```javascript
checkWith(
  'G15 XML 未授权工具不转发',
  '<tool_calls><invoke name="fantasy_tool"><parameter name="x">1</parameter></invoke></tool_calls>',
  '',
  tools,
);
checkWith(
  'G16 Python 未授权工具不转发',
  '```\nfantasy_tool(x="1")\n```',
  '',
  tools,
);
check(
  'G17 Python 已授权工具仍可恢复',
  '```\nwrite(file_path="a.txt", content="hi")\n```',
  'write',
);
```

- [ ] **Step 2: Run the parser test to verify the new cases fail**

Run:

```bash
node tests/test-parser-all.js
```

Expected: the two unapproved-format assertions fail because XML and Python branches currently bypass the authorization path.

- [ ] **Step 3: Route XML candidates through `pushCall()`**

In `resources/driver.js`, change `recoverInvokeXmlCalls()` to return raw candidates rather than final OpenAI calls:

```javascript
if (Object.keys(args).length) out.push({ name, arguments: args });
```

Then replace the direct append in `parseFromText()` with authorization-aware handling:

```javascript
const xmlCalls = recoverInvokeXmlCalls(sourceText);
for (const candidate of xmlCalls) {
  if (pushCall(candidate)) break;
}
```

This preserves XML parsing but makes `nameKnown`, schema inference, and `normalizeArgsForTool()` mandatory.

- [ ] **Step 4: Route Python candidates through `pushCall()`**

Replace the direct `calls.push()` in the Python-fallback branch with:

```javascript
if (fname && Object.keys(args).length) pushCall({ name: fname, arguments: args });
```

This rejects invented tool names while preserving authorized Python-style calls and parameter normalization.

- [ ] **Step 5: Run the parser test to verify it passes**

Run:

```bash
node tests/test-parser-all.js
```

Expected: exit code 0; `G15`, `G16`, and `G17` pass along with all existing parser cases.

- [ ] **Step 6: Commit parser hardening**

```bash
git add resources/driver.js tests/test-parser-all.js
git commit -m "fix: authorize all parsed tool call formats"
```

### Task 2: Validate chat-completions requests before stream setup

**Files:**
- Modify: `tests/test-account-pool.js:22-85,197-295`
- Modify: `resources/dsweb-gateway.js:1052-1120`

- [ ] **Step 1: Make the response mock record HTTP status and add invalid-payload tests**

Change `makeResMock()` so its `writeHead` records the status:

```javascript
function makeResMock() {
  return {
    statusCode: null,
    headers: null,
    setHeader() {},
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers || null; },
    chunks: [],
    write(c) { this.chunks.push(String(c)); },
    end() { this.ended = true; },
  };
}
```

Add a separate async test block that asserts all of the following without installing an RPC mock:

```javascript
const unknown = makeResMock();
await gw.handleChatCompletion({}, unknown, { model: 'not-a-real-model', messages: PAYLOAD_FIRST.messages });
check('2g1 未知模型返回 404', unknown.statusCode === 404, String(unknown.statusCode));
check('2g2 未知模型返回 JSON 错误', /"code":"model_not_found"/.test(sseText(unknown)) && !/data: /.test(sseText(unknown)));

const emptyMessages = makeResMock();
await gw.handleChatCompletion({}, emptyMessages, { model: 'deepseek-chat', messages: [] });
check('2g3 空 messages 返回 400', emptyMessages.statusCode === 400, String(emptyMessages.statusCode));
check('2g4 空 messages 返回 JSON 错误', /"code":"invalid_messages"/.test(sseText(emptyMessages)) && !/data: /.test(sseText(emptyMessages)));
```

- [ ] **Step 2: Run the gateway test to verify the new cases fail**

Run:

```bash
node tests/test-account-pool.js
```

Expected: `2g1`–`2g4` fail because an unknown model currently falls back to `deepseek-chat` and empty messages are reported only after deep request processing.

- [ ] **Step 3: Add a pure request validator in the gateway**

Add this helper immediately before `handleChatCompletion()` in `resources/dsweb-gateway.js`:

```javascript
function validateChatPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, code: 'invalid_request', message: 'request body must be a JSON object' };
  }
  if (typeof payload.model !== 'string' || !MODELS[payload.model]) {
    return { status: 404, code: 'model_not_found', message: 'model not found: ' + String(payload.model || '') };
  }
  if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m) || typeof m.role !== 'string' || !m.role)) {
    return { status: 400, code: 'invalid_messages', message: 'messages must be a non-empty array of role-bearing objects' };
  }
  return null;
}
```

At the first line of `handleChatCompletion()`, validate and send an ordinary JSON error before calculating `wantStream` or writing SSE headers:

```javascript
const validation = validateChatPayload(payload);
if (validation) {
  return sendJson(res, {
    error: { message: validation.message, type: 'invalid_request_error', code: validation.code },
  }, validation.status);
}
```

Then use the now-guaranteed mapping directly:

```javascript
const model = payload.model;
const cfg = MODELS[model];
```

- [ ] **Step 4: Run the gateway test to verify it passes**

Run:

```bash
node tests/test-account-pool.js
```

Expected: exit code 0; the invalid requests return JSON errors before `ensureDriver()` or `rpc('streamAsk')` can run.

- [ ] **Step 5: Commit request validation**

```bash
git add resources/dsweb-gateway.js tests/test-account-pool.js
git commit -m "fix: validate OpenAI chat requests early"
```

### Task 3: Prevent fragmented tool markup from leaking into SSE content

**Files:**
- Modify: `tests/test-account-pool.js:52-85,197-295`
- Modify: `resources/dsweb-gateway.js:971-1051,1221-1251`

- [ ] **Step 1: Extend the RPC mock to emit scripted deltas before `stream-end`**

In `makeRpcMock()`, permit each scripted request response to carry `events` and emit them in sequence:

```javascript
const resp = script.length ? script.shift() : { ok: true, result: '' };
for (const event of resp.events || []) c.push(event);
c.end({ ok: resp.ok !== false, result: resp.result || '', toolCalls: resp.toolCalls, error: resp.error, errorKind: resp.errorKind });
```

Use the consumer’s existing `push()` method; retain the current default behavior for tests that supply only a terminal response.

- [ ] **Step 2: Add an SSE regression for split tool syntax and normal Markdown**

Add test data that sends the following deltas before a successful terminal response containing one `write` tool call:

```javascript
events: [
  { delta: '`' },
  { delta: '``tool_call\n{"name":"write","args":{"file_path":"a.txt","content":"hi"}}\n```' },
]
```

Assert the assembled SSE stream has `tool_calls` and does **not** contain a content delta whose value starts with a backtick.

Add a second response with these events and no tool calls:

```javascript
events: [
  { delta: '`' },
  { delta: '``javascript\nconst x = 1;\n```' },
]
```

Assert the full Markdown content is emitted exactly once and `finish_reason` is `stop`.

- [ ] **Step 3: Run the gateway test to verify the split-tool assertion fails**

Run:

```bash
node tests/test-account-pool.js
```

Expected: the split-tool test fails because the first backtick is emitted as `delta.content` before the rest of the tool marker arrives.

- [ ] **Step 4: Add a pure incomplete-prefix predicate**

Add `isPossibleToolCallPrefix(text)` next to `looksLikeToolCallText()` in `resources/dsweb-gateway.js`. It must return true only for short, unfinished prefixes of supported formats:

```javascript
function isPossibleToolCallPrefix(text) {
  const s = String(text || '').trimStart();
  if (!s || s.length > 96) return false;
  const prefixes = ['`', '``', '```', '```t', '```to', '```too', '```tool', '```tool_', '```tool_c', '```tool_ca', '```tool_cal', '```j', '```js', '```jso', '<', '<t', '<to', '<too', '<tool', '<tool_', '<tool_c', '<tool_ca', '<tool_cal', '<tool_call', '<tool_calls', '<i', '<in', '<inv', '<invo', '<invok', '<invoke', 't', 'to', 'too', 'tool', 'tool_', 'tool_c', 'tool_ca', 'tool_cal', 'tool_call', '{', '['];
  return prefixes.includes(s.toLowerCase());
}
```

- [ ] **Step 5: Preserve the buffer while the prefix remains incomplete**

Replace the `toolMode === 'buffer'` decision with this order:

```javascript
toolBuf += evt.delta;
if (looksLikeToolCallText(toolBuf, payload.tools) && toolBuf.length < 400) {
  toolMode = 'silent';
  silentStart = Date.now();
  emitCurrentDelta = false;
} else if (isPossibleToolCallPrefix(toolBuf)) {
  emitCurrentDelta = false;
} else {
  toolMode = 'stream';
  if (toolBuf) sendChunk({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: toolBuf }, finish_reason: null }] });
  emitCurrentDelta = false;
}
```

This leaves the existing silent timeout and terminal full-content fallback unchanged.

- [ ] **Step 6: Run the gateway test to verify it passes**

Run:

```bash
node tests/test-account-pool.js
```

Expected: exit code 0; split tool syntax generates only `tool_calls`, while normal fenced Markdown is emitted once as content.

- [ ] **Step 7: Commit streaming hardening**

```bash
git add resources/dsweb-gateway.js tests/test-account-pool.js
git commit -m "fix: buffer incomplete tool call prefixes"
```

### Task 4: Complete verification and scope review

**Files:**
- Verify: `resources/driver.js`
- Verify: `resources/dsweb-gateway.js`
- Verify: `tests/test-*.js`

- [ ] **Step 1: Run syntax checks for modified runtime files**

```bash
node --check resources/driver.js
node --check resources/dsweb-gateway.js
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete offline regression suite**

```bash
set -e
for f in tests/test-*.js; do
  echo "========== $(basename \"$f\") =========="
  node "$f"
done
```

Expected: every test file exits 0.

- [ ] **Step 3: Review the final change set**

```bash
git diff main...HEAD --check
git diff --stat main...HEAD
git status --short
```

Expected: no whitespace errors; only the intended parser, gateway, test, specification, and plan files are tracked changes; pre-existing diagnostic untracked files remain untouched.

- [ ] **Step 4: Commit the implementation plan record if it is not already committed**

```bash
git add docs/superpowers/plans/2026-08-24-parser-api-hardening.md
git commit -m "docs: plan parser API hardening"
```
