# Multisite Web Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative ChatGPT Web and Qwen Web support through provider adapters while preserving all existing DeepSeek API behavior.

**Architecture:** Keep `resources/dsweb-gateway.js` and `resources/driver.js` as the stable process/API entry points. Introduce a CommonJS provider registry that is the single source of truth for public models and provider metadata, plus pure provider adapter modules that supply DOM expression builders and normalize provider-only status. The gateway resolves the requested model once and passes an explicit provider/model configuration through the driver RPC; the driver isolates browser channel/profile keys by provider and delegates page behavior to the selected adapter.

**Tech Stack:** Node.js CommonJS, built-in `http`/`vm` test harnesses, Chrome DevTools Protocol driver, existing SSE/OpenAI-compatible API.

---

### Task 1: Create a tested provider registry

**Files:**
- Create: `resources/provider-registry.js`
- Create: `tests/test-provider-registry.js`
- Modify: `tests/test-completeness.js:18-41, 685-732`

- [ ] **Step 1: Write the failing registry contract test**

Create `tests/test-provider-registry.js` with direct CommonJS assertions for the public registry contract:

```javascript
'use strict';
const assert = require('assert');
const registry = require('../resources/provider-registry');

const ids = registry.listModels().map((model) => model.id);
assert.deepStrictEqual(ids.slice(-5), [
  'chatgpt-auto', 'chatgpt-thinking',
  'qwen-chat', 'qwen-thinking', 'qwen-search',
]);
assert.strictEqual(registry.resolveModel('chatgpt-auto').providerId, 'chatgpt');
assert.strictEqual(registry.resolveModel('qwen-search').search, true);
assert.strictEqual(registry.resolveModel('deepseek-chat').providerId, 'deepseek');
assert.strictEqual(registry.resolveModel('does-not-exist'), null);
assert.strictEqual(registry.defaultProfile('chatgpt'), 'chatgpt-default');
assert.strictEqual(registry.defaultProfile('qwen'), 'qwen-default');
assert.strictEqual(registry.defaultProfile('deepseek'), 'deepseek-default');
console.log('provider registry: PASS');
```

Add a completeness assertion that `resources/provider-registry.js` and all three adapter paths are expected runtime source files, so an accidental partial implementation fails the existing source inventory audit.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node tests/test-provider-registry.js
```

Expected: failure with `Cannot find module '../resources/provider-registry'`.

- [ ] **Step 3: Implement the registry with explicit, immutable model metadata**

Create `resources/provider-registry.js` with this public API and model definitions. The registry deliberately holds provider metadata rather than importing adapters, so it remains independently testable; the driver loads the selected adapter in Task 3. Keep DeepSeek configurations byte-for-byte equivalent to the previous `MODELS` object, but enrich every entry with a `providerId`:

```javascript
'use strict';
const PROVIDERS = Object.freeze({
  deepseek: { id: 'deepseek', label: 'DeepSeek Web', siteUrl: 'https://chat.deepseek.com/', defaultProfilePrefix: 'deepseek' },
  chatgpt: { id: 'chatgpt', label: 'ChatGPT Web', siteUrl: 'https://chatgpt.com/', defaultProfilePrefix: 'chatgpt' },
  qwen: { id: 'qwen', label: 'Qwen Web', siteUrl: 'https://chat.qwen.ai/', defaultProfilePrefix: 'qwen' },
});
const MODELS = Object.freeze({
  'deepseek-chat': { providerId: 'deepseek', name: 'DeepSeek 快速（网页版）', mode: 'quick', deepThink: false, search: false },
  'deepseek-reasoner': { providerId: 'deepseek', name: 'DeepSeek 深度思考（网页版）', mode: 'quick', deepThink: true, search: false },
  'deepseek-search': { providerId: 'deepseek', name: 'DeepSeek 智能搜索（网页版）', mode: 'quick', deepThink: false, search: true },
  'deepseek-think-search': { providerId: 'deepseek', name: 'DeepSeek 深度思考+搜索（网页版）', mode: 'quick', deepThink: true, search: true },
  'deepseek-expert': { providerId: 'deepseek', name: 'DeepSeek 专家（网页版）', mode: 'expert', deepThink: false, search: false },
  'deepseek-expert-reasoner': { providerId: 'deepseek', name: 'DeepSeek 专家+深度思考（网页版）', mode: 'expert', deepThink: true, search: false },
  'deepseek-vision': { providerId: 'deepseek', name: 'DeepSeek 识图（网页版）', mode: 'vision', deepThink: false, search: false },
  'deepseek-vision-reasoner': { providerId: 'deepseek', name: 'DeepSeek 识图+深度思考（网页版）', mode: 'vision', deepThink: true, search: false },
  'chatgpt-auto': { providerId: 'chatgpt', name: 'ChatGPT 自动（网页版）', mode: 'auto' },
  'chatgpt-thinking': { providerId: 'chatgpt', name: 'ChatGPT 思考（网页版）', mode: 'thinking' },
  'qwen-chat': { providerId: 'qwen', name: 'Qwen 对话（网页版）', mode: 'chat', thinking: false, search: false },
  'qwen-thinking': { providerId: 'qwen', name: 'Qwen 思考（网页版）', mode: 'chat', thinking: true, search: false },
  'qwen-search': { providerId: 'qwen', name: 'Qwen 搜索（网页版）', mode: 'chat', thinking: false, search: true },
});
function resolveModel(id) { const config = MODELS[id]; return config ? { id, ...config, provider: PROVIDERS[config.providerId] } : null; }
function listModels() { return Object.entries(MODELS).map(([id, config]) => ({ id, ...config })); }
function getProvider(id) { return PROVIDERS[id] || null; }
function defaultProfile(id) { const provider = getProvider(id); return provider ? provider.defaultProfilePrefix + '-default' : null; }
module.exports = { PROVIDERS, MODELS, resolveModel, listModels, getProvider, defaultProfile };
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
node tests/test-provider-registry.js && node tests/test-completeness.js
```

Expected: `provider registry: PASS` and the completeness suite reports no missing runtime source paths.

- [ ] **Step 5: Commit the registry slice**

```bash
git add resources/provider-registry.js tests/test-provider-registry.js tests/test-completeness.js
git commit -m "feat: add web provider registry"
```

### Task 2: Add pure DeepSeek, ChatGPT, and Qwen adapters with offline DOM contracts

**Files:**
- Create: `resources/providers/deepseek.js`
- Create: `resources/providers/chatgpt.js`
- Create: `resources/providers/qwen.js`
- Create: `tests/test-provider-adapters.js`

- [ ] **Step 1: Write failing adapter tests against fake DOMs**

Create tests that invoke each adapter's expression builder using a fake `document`. Cover the following observable behavior:

```javascript
assert.strictEqual(chatgpt.id, 'chatgpt');
assert.strictEqual(chatgpt.siteUrl, 'https://chatgpt.com/');
assert.strictEqual(run(chatgpt.expressions.findComposer(), chatgptComposerDom).tagName, 'TEXTAREA');
assert.strictEqual(run(chatgpt.expressions.clickSend(), chatgptComposerDom), true);
assert.strictEqual(run(chatgpt.expressions.detectChallenge(), chatgptChallengeDom), true);
assert.deepStrictEqual(run(chatgpt.expressions.extractLatest(), chatgptReplyDom), { text: 'answer\nconst n = 1;', thinking: '' });
assert.strictEqual(run(qwen.expressions.findComposer(), qwenComposerDom).className, 'message-input-textarea');
assert.strictEqual(run(qwen.expressions.clickSend(), qwenComposerDom), true);
assert.strictEqual(run(qwen.expressions.detectGenerating(), qwenGeneratingDom), true);
assert.strictEqual(run(qwen.expressions.applyMode({ thinking: true, search: false }), qwenThinkingDom).ok, true);
assert.strictEqual(run(qwen.expressions.applyMode({ thinking: false, search: true }), qwenNoSearchDom).kind, 'mode_unavailable');
assert.strictEqual(run(qwen.expressions.detectLimit(), qwenLimitDom), 'rate_limited');
```

The fake DOM must expose only `querySelector`, `querySelectorAll`, `closest`, `matches`, `click`, `disabled`, `hidden`, `textContent`, and `innerText`. Do not rely on a browser or a live website.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node tests/test-provider-adapters.js
```

Expected: failure because the `resources/providers/*` modules do not exist.

- [ ] **Step 3: Implement adapter metadata and expression builders**

Implement common adapter shape:

```javascript
module.exports = {
  id: 'chatgpt',
  label: 'ChatGPT Web',
  siteUrl: 'https://chatgpt.com/',
  defaultProfilePrefix: 'chatgpt',
  expressions: {
    findComposer() { return `(() => { /* returns visible textarea or null */ })()`; },
    fillPrompt(text) { return `(() => { /* native value setter + input event */ })()`; },
    clickSend() { return `(() => { /* prefer enabled form submit, then visible button */ })()`; },
    detectGenerating() { return `(() => { /* stop/cancel or changing response signal */ })()`; },
    extractLatest() { return `(() => { /* latest assistant text plus pre code */ })()`; },
    detectLogin() { return `(() => { /* login redirect/sign-in UI */ })()`; },
    detectChallenge() { return `(() => { /* turnstile/challenge/security verification */ })()`; },
    detectLimit() { return `(() => { /* rate-limit/temporarily unavailable text */ })()`; },
    applyMode(config) { return `(() => ({ ok: config.mode !== 'thinking', fallback: config.mode === 'thinking' }))()`; },
    openNewChat() { return `(() => { location.href = 'https://chatgpt.com/'; return true; })()`; },
  },
};
```

Apply the same shape to Qwen, using the exact Qwen selectors in the approved design (`.message-input-textarea`, `.qwen-chat-v2-input-textarea`, `.chat-prompt-send-button .send-button[aria-label="Send"]`, `.stop-button[aria-label="Stop"]`) and explicit `mode_unavailable` results when its thinking/search toggle cannot be located.

The DeepSeek adapter must expose its URL, `defaultProfilePrefix`, and compatibility metadata only in this task. Its existing complex DOM expressions will be migrated in Task 3 to prevent behavior changes during module creation.

Add comments only where they explain an invariant: ChatGPT's generic selectors are intentionally form-scoped because class names are unstable; Qwen mode selection must fail explicitly rather than silently send the wrong model mode.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run:

```bash
node tests/test-provider-adapters.js
```

Expected: every fake-DOM scenario passes without launching Chrome.

- [ ] **Step 5: Commit the adapter slice**

```bash
git add resources/providers tests/test-provider-adapters.js
git commit -m "feat: add ChatGPT and Qwen page adapters"
```

### Task 3: Route browser-driver page state through providers and isolate profiles

**Files:**
- Modify: `resources/driver.js:45-90, 120-480, 2260-3150, 3490-3729`
- Modify: `tests/test-model-modes.js:1-254`
- Create: `tests/test-driver-providers.js`

- [ ] **Step 1: Write failing driver-provider tests**

Add an offline `vm` harness that loads the driver source with stubbed CDP methods and verifies:

```javascript
assert.strictEqual(driver.profileKey({ providerId: 'chatgpt', profile: 'default' }), 'chatgpt-default');
assert.strictEqual(driver.profileKey({ providerId: 'qwen', profile: 'default' }), 'qwen-default');
assert.strictEqual(driver.channelKey({ providerId: 'qwen', sessionKey: 'abc' }), 'qwen:abc');
assert.notStrictEqual(driver.channelKey({ providerId: 'deepseek', sessionKey: 'abc' }), driver.channelKey({ providerId: 'chatgpt', sessionKey: 'abc' }));
assert.strictEqual(driver.resolveProviderModel({ providerId: 'qwen', model: { id: 'qwen-search', search: true } }).provider.id, 'qwen');
```

Extend `tests/test-model-modes.js` so that every existing DeepSeek model still resolves to `providerId === 'deepseek'`, and Qwen mode errors are returned as `mode_unavailable`, not converted to an arbitrary DeepSeek calibration action.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
node tests/test-driver-providers.js && node tests/test-model-modes.js
```

Expected: driver helper exports are unavailable and the old model-mode test only knows the inline DeepSeek model table.

- [ ] **Step 3: Integrate the registry and adapters into driver control flow**

Make these minimally invasive changes:

1. Replace global `DS_URL` usage with `provider.siteUrl` in `ensurePage`, `ensureChannelPage`, `login`, and task navigation.
2. Add and export pure helpers:

```javascript
function profileKey({ providerId, profile }) {
  return profile && profile.startsWith(providerId + '-') ? profile : providerId + '-' + (profile || 'default');
}
function channelKey({ providerId, sessionKey }) { return providerId + ':' + sessionKey; }
function resolveProviderModel(request) {
  const resolved = registry.resolveModel(request.model && request.model.id ? request.model.id : request.model);
  if (!resolved) throw new Error('unknown provider model');
  return { ...resolved, adapter: PROVIDER_ADAPTERS[resolved.providerId] };
}
```

3. Define `const PROVIDER_ADAPTERS = { deepseek, chatgpt, qwen };` beside the driver imports, then thread the resolved `providerId`, `model`, and adapter through `streamAsk`, `ensureLoggedIn`, `ensurePage`, `ensureChannelPage`, `applyConfig`, and all emitted driver status. Use `channelKey` when accessing `channels`; use `profileKey` before opening/assigning profile paths.
4. Retain the existing DeepSeek expressions and calibration path when `providerId === 'deepseek'`. For ChatGPT/Qwen, call adapter expression builders for readiness, input, send, generation polling, latest response extraction, login/challenge/limit detection, and new chat.
5. Convert adapter mode results `{ kind: 'mode_unavailable' }` into an RPC error with the same `kind`, so the gateway can produce an OpenAI-compatible error without sending the prompt.
6. Preserve `parseToolCalls`, thinking extraction, stream sequencing, CDP RPC transport, and existing reset/recovery semantics unchanged.

- [ ] **Step 4: Run focused regression tests**

Run:

```bash
node tests/test-driver-providers.js && node tests/test-model-modes.js && node tests/test-parser-all.js && node tests/test-thinking-mode.js
```

Expected: provider isolation and Qwen mode contract pass; all existing DeepSeek mode/parser/thinking cases remain green.

- [ ] **Step 5: Commit the driver slice**

```bash
git add resources/driver.js tests/test-driver-providers.js tests/test-model-modes.js
git commit -m "feat: route driver through web providers"
```

### Task 4: Resolve models in the gateway, extend provider-aware management, and normalize errors

**Files:**
- Modify: `resources/dsweb-gateway.js:75-110, 300-550, 1440-1485, 1680-2155`
- Modify: `tests/test-account-pool.js:1-334`
- Create: `tests/test-gateway-providers.js`

- [ ] **Step 1: Write failing gateway provider tests**

Use the existing `vm` gateway harness style. Assert API-visible requirements before modifying the gateway:

```javascript
const models = await requestJson(gateway, 'GET', '/v1/models');
assert(models.data.some((model) => model.id === 'chatgpt-auto' && model.owned_by === 'chatgpt-web'));
assert(models.data.some((model) => model.id === 'qwen-search' && model.owned_by === 'qwen-web'));

await gateway.handleChatCompletion({}, streamRes, { model: 'qwen-search', stream: true, messages: [{ role: 'user', content: 'hello' }] });
assert.strictEqual(rpcCalls[0].method, 'streamAsk');
assert.strictEqual(rpcCalls[0].params.providerId, 'qwen');
assert.strictEqual(rpcCalls[0].params.profile, 'qwen-default');

await gateway.handleChatCompletion({}, jsonRes, { model: 'missing-model', stream: false, messages: [{ role: 'user', content: 'hello' }] });
assert.strictEqual(jsonRes.statusCode, 404);
assert.strictEqual(jsonRes.body.error.code, 'model_not_found');

assertProviderError('challenge_required', 403, 'provider_challenge_required');
assertProviderError('mode_unavailable', 422, 'provider_mode_unavailable');
```

Extend `tests/test-account-pool.js` with a provider-specific identity case so the same logical account name (`default`) has distinct `deepseek-default`, `chatgpt-default`, and `qwen-default` pool/profile identities.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
node tests/test-gateway-providers.js && node tests/test-account-pool.js
```

Expected: `/v1/models` lacks the new models and `streamAsk` does not receive provider-aware parameters.

- [ ] **Step 3: Update the gateway to use `provider-registry.js`**

1. Replace the inline `MODELS` declaration with:

```javascript
const registry = require('./provider-registry');
const MODELS = registry.MODELS;
```

2. Generate `/v1/models` from `registry.listModels()` and set `owned_by` to `providerId + '-web'`.
3. Validate the request model by `registry.resolveModel(payload.model)` before setting up SSE or calling the driver. Keep the existing HTTP 404 `model_not_found` response for unknown IDs.
4. Pass the resolved provider/model explicitly into `streamAsk`:

```javascript
{ providerId: resolved.providerId, model: resolved, profile: registry.defaultProfile(resolved.providerId), ...existingParams }
```

For an explicit legacy DeepSeek profile, preserve it; default only when the request/session has no profile.

5. Include `providerId` in session identity and account-pool identity. A session created with `qwen-chat` must never be reused for a later `chatgpt-auto` request even when messages have the same fingerprint.
6. Extend `/login` and `/login-status` to parse `provider` from query parameters. Default absent parameters to `deepseek`; reject unknown providers with HTTP 400. Pass the provider-aware profile to driver RPC.
7. Extend health/config/management responses with registered provider metadata and their computed default profile names.
8. Normalize driver errors with this mapping: `challenge_required` → HTTP 403/`provider_challenge_required`; `login_required` → HTTP 401/`provider_login_required`; `mode_unavailable` → HTTP 422/`provider_mode_unavailable`; `rate_limited` → existing quota/backoff behavior; `provider_dom_changed` and `provider_unavailable` → HTTP 503 with distinct error codes. Do not mark a challenge as a DOM failure.
9. Keep existing tool prompting, tool parser, SSE chunking, non-streaming completion shapes, account cooling semantics, and DeepSeek fallback/recovery behavior unchanged.

- [ ] **Step 4: Run focused gateway tests**

Run:

```bash
node tests/test-gateway-providers.js && node tests/test-account-pool.js && node tests/test-runtime-context.js && node tests/test-tool-prompt.js
```

Expected: provider model routing, identity isolation, OpenAI-style errors, account-pool behavior, runtime context, and tool prompts all pass.

- [ ] **Step 5: Commit the gateway slice**

```bash
git add resources/dsweb-gateway.js tests/test-gateway-providers.js tests/test-account-pool.js
git commit -m "feat: expose multisite web models through gateway"
```

### Task 5: Update user-facing documentation, comments, and release verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/publishing.md`
- Modify: `spec/SPEC-multisite.md`
- Modify: `docs/superpowers/specs/2026-08-24-multisite-web-provider-design.md`

- [ ] **Step 1: Add documentation assertions before editing prose**

Extend `tests/test-completeness.js` to assert these repository facts:

```javascript
assert(read('README.md').includes('chatgpt-auto'));
assert(read('README.md').includes('qwen-search'));
assert(read('README.en.md').includes('chatgpt-thinking'));
assert(read('docs/user-guide.md').includes('/login?provider=chatgpt'));
assert(read('docs/user-guide.md').includes('/login?provider=qwen'));
assert(read('docs/publishing.md').includes('test-provider-registry.js'));
```

- [ ] **Step 2: Run the documentation check to verify it fails**

Run:

```bash
node tests/test-completeness.js
```

Expected: failure because the manuals only document DeepSeek models and provider-less login.

- [ ] **Step 3: Update documentation and implementation comments**

Make the following exact documentation changes:

- In both README files, change the product description from DeepSeek-only to “DeepSeek / ChatGPT / Qwen Web-to-OpenAI gateway”; include the five new model IDs and mark the feature Beta.
- In `docs/user-guide.md`, add a provider login section with `GET /login?provider=deepseek`, `GET /login?provider=chatgpt`, and `GET /login?provider=qwen`; document that each provider has an independent browser profile and requires manual login.
- In the same guide, state the conservative boundaries: text/code/SSE only; no attachment or multimodal support; no challenge solving; Qwen modes can return `mode_unavailable`; ChatGPT challenge errors require manual action.
- In `docs/publishing.md`, add the two new provider test files to the full regression loop and require a manual smoke-test for each manually logged-in provider before a release.
- In `spec/SPEC-multisite.md`, update its status from “规划中” to “首版已实现，待真实登录态手工验收” only after Task 6's full suite passes; link to the design and implementation plan.
- In the design document, change status to “已实施，待真实登录态手工验收” only after Task 6 succeeds.
- Keep source comments concise: explain registry-as-single-source-of-truth, provider-prefixed session/profile keys, ChatGPT form-scoped selectors, and Qwen explicit mode failure. Remove or rewrite top-level comments that still describe the project as DeepSeek-only.

- [ ] **Step 4: Run the documentation and targeted test suite**

Run:

```bash
node tests/test-completeness.js && node tests/test-provider-registry.js && node tests/test-provider-adapters.js && node tests/test-driver-providers.js && node tests/test-gateway-providers.js
```

Expected: all new documentation assertions and all provider-specific offline tests pass.

- [ ] **Step 5: Commit docs and comments**

```bash
git add README.md README.en.md docs/user-guide.md docs/publishing.md spec/SPEC-multisite.md docs/superpowers/specs/2026-08-24-multisite-web-provider-design.md resources tests/test-completeness.js
git commit -m "docs: document multisite web provider support"
```

### Task 6: Run complete verification and record manual-test boundary

**Files:**
- Modify: `docs/publishing.md` only if the actual command reveals a missing test entry or command mismatch.

- [ ] **Step 1: Run all offline regression tests from a clean Node process**

Run:

```bash
set -e
for f in tests/test-*.js; do
  echo "== $f =="
  node "$f"
done
```

Expected: every test exits 0. Record each test file and its final summary in the task result.

- [ ] **Step 2: Run static and repository integrity checks**

Run:

```bash
git diff --check
git status --short
node --check resources/provider-registry.js
node --check resources/providers/deepseek.js
node --check resources/providers/chatgpt.js
node --check resources/providers/qwen.js
node --check resources/driver.js
node --check resources/dsweb-gateway.js
```

Expected: no whitespace errors, all six runtime files parse, and status contains only intentional files plus the pre-existing untracked local diagnostic/workspace files.

- [ ] **Step 3: Start an isolated gateway smoke test without a browser login**

Run:

```bash
base=$(mktemp -d)
node resources/dsweb-gateway.js --port 0 --base "$base" >"$base/gateway.log" 2>&1 &
pid=$!
sleep 2
kill "$pid"
wait "$pid" || true
cat "$base/gateway.log"
rm -rf "$base"
```

Expected: the process starts without require/syntax errors, logs all provider model IDs, and no browser login is claimed. If port `0` is not supported by the current gateway, use an unused explicit localhost port and clean up the process in a shell `trap`.

- [ ] **Step 4: Perform or document the required authenticated manual checks**

With user-authorized sessions only, open the three provider login paths; manually complete login if needed; send a short text request and a code-generation request to each provider; verify SSE begins and ends; test Qwen thinking/search controls; confirm that ChatGPT challenge UI returns `challenge_required` instead of a selector error.

If no authorized logged-in browser profiles are available in this development environment, record this as the remaining external manual verification boundary rather than claiming live site success.

- [ ] **Step 5: Review the final diff and commit implementation**

Run:

```bash
git diff --check HEAD~1..HEAD
git status --short
git log --oneline -6
```

Then create the final implementation commit only after the complete offline suite succeeds:

```bash
git add resources tests README.md README.en.md docs spec
git commit -m "feat: add ChatGPT and Qwen web providers"
```
