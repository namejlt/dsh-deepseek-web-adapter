# Quick Response Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver short, already-completed web answers to DSH without retries or a false timeout, and prevent equivalent stalls in ChatGPT and Qwen adapters.

**Architecture:** DeepSeek’s stream loop will snapshot the prior assistant response before clicking Send, so an immediate answer cannot become the comparison baseline. Its DOM extractor will accept non-empty text inside a strongly identified assistant-content element. The ChatGPT/Qwen adapter loop will retain its primary Stop-button completion signal while adding a bounded stable-text fallback for selector false positives.

**Tech Stack:** Node.js CommonJS driver, browser-side DOM expression strings, offline Node assertion tests.

---

### Task 1: Encode the DeepSeek fast-answer regression

**Files:**
- Modify: `tests/test-thinking-mode.js`

- [ ] **Step 1: Add a short-answer extraction assertion**

```js
const SHORT_ANSWER = '2';
const mainShort = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'ds-markdown', children: [tx(SHORT_ANSWER)] }),
] });
check('short direct assistant answer is retained',
  runExpr(extractLastExpr, makeDoc({ '.ds-assistant-message-main-content': [mainShort] })) === SHORT_ANSWER);
```

- [ ] **Step 2: Add a send-order assertion**

```js
const sendPos = SRC.indexOf('await sendMessage(pageId, payload, {});');
const baselinePos = SRC.indexOf('const beforeText = await evalJs(pageId, EXPR.extractLast).catch(() => \'\');');
check('snapshots the previous assistant reply before sending', baselinePos >= 0 && baselinePos < sendPos);
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/test-thinking-mode.js`

Expected: the short-answer extraction and/or baseline-order checks fail on the current driver.

### Task 2: Encode adapter completion fallback behavior

**Files:**
- Modify: `tests/test-driver-providers.js`

- [ ] **Step 1: Add failing desired-API tests**

```js
check('finishes a stable adapter response when a stale generating control persists', () => {
  assert.strictEqual(driver.shouldFinishAdapterResponse({
    sawText: true, generating: true, lastChangeAt: 1000, now: 6000,
  }), true);
});

check('does not finish an adapter response without extracted text', () => {
  assert.strictEqual(driver.shouldFinishAdapterResponse({
    sawText: false, generating: false, lastChangeAt: 1000, now: 6000,
  }), false);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node tests/test-driver-providers.js`

Expected: FAIL because `shouldFinishAdapterResponse` is not exported yet.

### Task 3: Implement the minimal production fix

**Files:**
- Modify: `resources/driver.js`

- [ ] **Step 1: Capture `beforeText`/`beforeClean` immediately before each DeepSeek send**

Move the snapshot directly before the initial `sendMessage` call and repeat it directly before the same-payload retry call. Pass the snapshot into the polling attempt; do not create the baseline after a send.

- [ ] **Step 2: Allow short text in direct DeepSeek assistant-content selectors**

Change only the strong direct selector path in `EXPR.extractLast` from `t.length > 10` to `t.length > 0`; keep generic message fallbacks conservative.

- [ ] **Step 3: Add and use a shared adapter completion predicate**

```js
function shouldFinishAdapterResponse({ sawText, generating, lastChangeAt, now }) {
  if (!sawText || !lastChangeAt) return false;
  const stableFor = now - lastChangeAt;
  return (!generating && stableFor >= 1200) || stableFor >= 5000;
}
```

Use it in `streamAdapterAsk` after `detectGenerating`, preserving the current 240-second hard timeout.

### Task 4: Verify all provider paths

**Files:**
- Verify: `tests/test-thinking-mode.js`
- Verify: `tests/test-driver-providers.js`
- Verify: `tests/test-provider-adapters.js`
- Verify: `tests/test-provider-registry.js`
- Verify: `tests/test-gateway-providers.js`
- Verify: `tests/test-model-modes.js`
- Verify: `tests/test-completeness.js`

- [ ] **Step 1: Run focused DeepSeek and adapter regression tests**

Run: `node tests/test-thinking-mode.js && node tests/test-driver-providers.js && node tests/test-provider-adapters.js`

Expected: all pass.

- [ ] **Step 2: Run the suite that covers provider registry/gateway and model modes**

Run: `node tests/test-provider-registry.js && node tests/test-gateway-providers.js && node tests/test-model-modes.js && node tests/test-completeness.js`

Expected: all pass.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff -- resources/driver.js tests/test-thinking-mode.js tests/test-driver-providers.js`

Expected: no whitespace errors; changes limited to response extraction, response baseline timing, bounded adapter fallback, and regression coverage.
