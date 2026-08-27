# Security hardening and live-smoke execution plan

> Execute directly on `main` at the user's explicit request. No commit is created unless requested.

**Goal:** Make the local Web-to-OpenAI gateway safe to expose on loopback, keep credentials/state out of the npm package, provide a deterministic verification command, and add an explicit opt-in authenticated live-smoke runner for DeepSeek, ChatGPT, and Qwen.

**Architecture:** Add a small `state-store` module used by plugin host and gateway for user-scoped state, atomic JSON persistence, legacy migration, and persistent bearer-token creation. Add gateway request authentication with a bearer-token API plane and an HttpOnly same-origin management session, then move package/test/live-smoke plumbing to explicit modules and scripts. Keep browser automation behavior untouched until live evidence identifies an adapter defect.

**Tech stack:** Node.js 18+, built-in `node:assert`, `node:http`, `node:crypto`, `node:fs`, current fake-driver integration test style; no new runtime dependencies.

---

### Task 1: Add state-store tests and state-store module

**Files:**
- Create: `tests/test-state-store.js`
- Create: `resources/state-store.js`

- [ ] **Step 1: Write failing tests for user state paths, stable token creation, atomic JSON writes, and empty-destination legacy migration.**

```js
const store = require('../resources/state-store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-state-'));
assert.strictEqual(store.resolveStateDir({ platform: 'linux', home: '/home/a', env: {} }), '/home/a/.local/state/dsh-web-adapter');
const tokenA = store.readOrCreateSecret(path.join(dir, 'gateway-token'));
const tokenB = store.readOrCreateSecret(path.join(dir, 'gateway-token'));
assert.match(tokenA, /^[A-Za-z0-9_-]{40,}$/);
assert.strictEqual(tokenA, tokenB);
store.writeJsonAtomic(path.join(dir, 'accounts.json'), { accounts: [{ name: 'default' }] });
assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')), { accounts: [{ name: 'default' }] });
```

- [ ] **Step 2: Run the test and verify it fails because `resources/state-store.js` does not exist.**

Run: `node tests/test-state-store.js`
Expected: non-zero exit with `Cannot find module '../resources/state-store'`.

- [ ] **Step 3: Implement the smallest state-store API.**

```js
module.exports = {
  resolveStateDir,
  ensurePrivateDir,
  readOrCreateSecret,
  writeJsonAtomic,
  migrateLegacyState,
};
```

`readOrCreateSecret()` must use `crypto.randomBytes(32).toString('base64url')`, write with mode `0o600`, and return the existing non-empty secret. `writeJsonAtomic()` must write a same-directory temporary file with mode `0o600` and rename it only after successful write. `migrateLegacyState()` must copy `profiles/`, `accounts.json`, and `calibration.json` only when destination is empty.

- [ ] **Step 4: Run `node tests/test-state-store.js` and expect all assertions to pass.**

### Task 2: Add failing authentication/Origin contract tests, then protect gateway routes

**Files:**
- Create: `tests/test-gateway-security.js`
- Modify: `resources/dsweb-gateway.js`
- Modify: `lib/index.js`
- Modify: `tests/test-gateway-providers.js`

- [ ] **Step 1: Write a fake-driver HTTP integration test that proves protected API behavior.**

The test must start the gateway with a temporary base directory, read `<base>/gateway-token`, and assert:

```js
assert.strictEqual((await request('GET', '/v1/models')).status, 401);
assert.strictEqual((await request('GET', '/v1/models', null, { Authorization: 'Bearer ' + token })).status, 200);
assert.strictEqual((await request('POST', '/config', { headless: true }, { Authorization: 'Bearer wrong' })).status, 401);
assert.strictEqual((await request('OPTIONS', '/v1/models', null, { Origin: 'https://evil.example' })).headers['access-control-allow-origin'], undefined);
```

The test must additionally assert that the root management route creates an HttpOnly, SameSite=Strict session cookie; a same-origin request with this cookie reaches `/health`; and a different Origin using that cookie is rejected.

- [ ] **Step 2: Run `node tests/test-gateway-security.js` and verify the first assertion fails because current `/v1/models` returns 200 without authentication.**

- [ ] **Step 3: Add `gateway-token` initialization, `Authorization: Bearer` verification using `crypto.timingSafeEqual`, no wildcard CORS, and management-session authorization.**

Gateway rules:

```text
/v1/*             bearer token required
/                 public static management shell; sets HttpOnly; SameSite=Strict session cookie
management fetch  exact same Origin + session cookie, or bearer token
all other origins reject without CORS reflection
```

`/health` must include `{ instanceId, protocolVersion, startedAt, driverEpoch }` only for authenticated callers. `/v1` errors must use `{ error: { message, type, param, code } }`.

Plugin rules:

```text
state dir = DSWEB_STATE_DIR or platform user state dir
--base receives that dir
gatewayAlive sends Authorization only after gateway-token exists
```

- [ ] **Step 4: Update fake-driver tests to add the generated bearer token and run both security/provider integration suites.**

Run: `node tests/test-gateway-security.js && node tests/test-gateway-providers.js`
Expected: zero failures.

### Task 3: Make package state-safe and test execution deterministic

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `tests/run-all.js`
- Create: `tests/check-package.js`
- Modify: `tests/test-parser-all.js`
- Modify: `tests/test-runtime-context.js`

- [ ] **Step 1: Write `tests/check-package.js` to run `npm pack --dry-run --json` and fail if a path begins with `resources/runtime/`, `tests/`, `output/`, or `.playwright-cli/`. Add runner tests only after the runner exists.**

- [ ] **Step 2: Run `node tests/check-package.js` and verify it fails because the current pack includes `resources/runtime/calibration.json` and tests.**

- [ ] **Step 3: Replace package `files` with an explicit runtime allowlist and scripts:**

```json
{
  "scripts": {
    "test": "node tests/run-all.js",
    "check": "node tests/check-package.js && node tests/check-syntax.js",
    "pack:check": "node tests/check-package.js"
  }
}
```

Add `.local/` and `output/live-smoke/` to `.gitignore`.

- [ ] **Step 4: Correct test defects before relying on the new runner.**

```js
// test-parser-all.js E9
checkBool('E9 explicit multi-candidate output retains exactly one call', e9.length === 1, 'len=' + e9.length);

// test-runtime-context.js
check('2d0 long system settings exceed historical 8k limit', SYS_LONG.length > 8000, 'len=' + SYS_LONG.length);
```

- [ ] **Step 5: Run `npm test && npm run check` and expect zero failures.**

### Task 4: Add explicit strict tool protocol without breaking an opt-in compatibility route

**Files:**
- Create: `tests/test-tool-protocol.js`
- Modify: `resources/driver.js`
- Modify: `resources/dsweb-gateway.js`
- Modify: `tests/test-parser-all.js`

- [ ] **Step 1: Write failing tests that strict parsing rejects a bare JSON example, never parses when `tool_choice: 'none'`, and accepts exactly one explicitly marked authorized call.**

```js
assert.deepStrictEqual(parseToolCalls('{"name":"pwsh","arguments":{"command":"pwd"}}', tools, { protocol: 'strict' }), []);
assert.strictEqual(resolveToolMode({ tools, tool_choice: 'none' }), 'disabled');
assert.strictEqual(parseToolCalls('```tool_call\n{"name":"read","arguments":{"file_path":"a.txt"}}\n```', tools, { protocol: 'strict' })[0].name, 'read');
```

- [ ] **Step 2: Run `node tests/test-tool-protocol.js` and verify it fails because `parseToolCalls` currently accepts bare JSON and has no options argument.**

- [ ] **Step 3: Add the third optional `options` argument to `parseToolCalls(text, tools, options)`, add gateway `resolveToolMode(payload)`, and pass `{ protocol: 'strict' }` only when tools are enabled.**

Strict mode accepts only `<tool_call>...</tool_call>` and ````tool_call` blocks with an authorized name and object arguments. It must not infer tools or synthesize required values. Keep `compat` behavior only when `DSWEB_TOOL_PROTOCOL=compat` is explicitly set for transition.

- [ ] **Step 4: Run tool protocol, parser, gateway completeness, and tool prompt tests.**

Run: `node tests/test-tool-protocol.js && node tests/test-parser-all.js && node tests/test-completeness.js && node tests/test-tool-prompt.js`
Expected: zero failures.

### Task 5: Add authenticated opt-in live-smoke harness and documentation

**Files:**
- Create: `tests/live/run-live-smoke.js`
- Create: `tests/live/README.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/publishing.md`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write a failing harness self-test that exits with a clear error unless `DSWEB_LIVE_TEST=1` and verifies the report sanitizer removes authorization values and absolute profile paths.**

- [ ] **Step 2: Run the harness without `DSWEB_LIVE_TEST=1` and expect a non-zero safety refusal.**

- [ ] **Step 3: Implement a no-dependency live runner.**

It reads a token only from `DSWEB_LIVE_BASE/gateway-token`, requires `--url`, requests authenticated `/v1/models` and `/login-status?provider=...`, sends a fixed short completion per requested provider, captures SSE ordering, and writes a sanitized `report.json` plus transcript excerpts to `output/live-smoke/<timestamp>/`. It never sends file, image, or execution tools by default.

- [ ] **Step 4: Document the isolated setup and login commands.**

```bash
mkdir -p .local/live-smoke
node resources/dsweb-gateway.js --port 5689 --base "$PWD/.local/live-smoke"
# user completes each /login?provider=... window
DSWEB_LIVE_TEST=1 DSWEB_LIVE_BASE="$PWD/.local/live-smoke" \
  node tests/live/run-live-smoke.js --url http://127.0.0.1:5689 --providers deepseek,chatgpt,qwen
```

- [ ] **Step 5: Add CI for `npm ci`, `npm run check`, and `npm test`; it must never run live smoke.**

### Task 6: Run real smoke after user login and report evidence

**Files:**
- Runtime only: `.local/live-smoke/`, `output/live-smoke/`

- [ ] **Step 1: Start the protected gateway on `127.0.0.1:5689` using `.local/live-smoke` and verify token creation and authenticated health.**
- [ ] **Step 2: User manually completes login/challenge in the three provider windows. No credential, cookie, OTP, CAPTCHA response, or account identifier is stored in the repository.**
- [ ] **Step 3: Execute `tests/live/run-live-smoke.js` with `DSWEB_LIVE_TEST=1`; collect its sanitized report.**
- [ ] **Step 4: Run `npm test`, `npm run check`, and `npm run pack:check`; report live provider pass/fail separately from offline tests.**
