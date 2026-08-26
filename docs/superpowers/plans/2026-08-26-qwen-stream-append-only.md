# Qwen Append-Only Stream Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Qwen Web stream polling emits only newly appended assistant content instead of replaying the whole response when the DOM has nested Markdown nodes or code blocks.

**Architecture:** The Qwen adapter will choose the newest assistant reply container from stable root selectors before considering generic Markdown fallbacks, and will serialize that root in DOM order rather than gathering all prose before code fences. This preserves monotonic snapshots for the generic `streamAdapterAsk` delta algorithm, so its normal `current.startsWith(previous)` branch emits append-only chunks.

**Tech Stack:** Node.js CommonJS; VM-backed DOM adapter unit tests using `tests/test-provider-adapters.js`; driver helper tests using `tests/test-driver-providers.js`.

---

### Task 1: Capture the append-only contract with a failing regression test

**Files:**
- Modify: `tests/test-provider-adapters.js`
- Modify: `tests/test-driver-providers.js`

- [ ] **Step 1: Add a Qwen extractor fixture with a reply card that contains a prose block followed by a code block and a later prose block.**

```js
const card = new FakeElement('article', { className: 'chat-answers-card-wrap' });
card.append(new FakeElement('p', { text: '第一段' }));
const pre = card.append(new FakeElement('pre'));
pre.append(new FakeElement('code', { text: 'const x = 1;' }));
card.append(new FakeElement('p', { text: '第二段' }));
```

- [ ] **Step 2: Assert that `extractLatest` retains `第一段`, code fence, and `第二段` in DOM order, and selects the card rather than an arbitrary nested Markdown descendant.**

```js
const text = String(run(qwen, 'extractLatest', document).result.text || '');
assert(text.indexOf('第一段') < text.indexOf('const x = 1;'));
assert(text.indexOf('const x = 1;') < text.indexOf('第二段'));
```

- [ ] **Step 3: Add a driver helper assertion for a cumulative Qwen-style snapshot.**

```js
assert.strictEqual(driver.computeAdapterDelta('第一段\n第二段', '第一段', '', true), '\n第二段');
```

- [ ] **Step 4: Run the focused tests and confirm the DOM-order test fails before implementation.**

Run: `node tests/test-provider-adapters.js && node tests/test-driver-providers.js`

Expected: the new Qwen DOM-order assertion fails because the existing extractor gathers prose before appending fences.

### Task 2: Make Qwen extraction produce monotonic, DOM-ordered snapshots

**Files:**
- Modify: `resources/providers/qwen.js`
- Test: `tests/test-provider-adapters.js`

- [ ] **Step 1: Select response roots by priority.**

```js
const roots = [
  '.chat-answers-card-wrap',
  '[data-message-author-role="assistant"]',
  '[data-message-role="assistant"]',
];
const latest = roots.map((selector) => Array.from(document.querySelectorAll(selector)).filter(isVisible).pop()).find(Boolean)
  || genericMarkdownFallback;
```

- [ ] **Step 2: Serialize the selected reply root recursively, emitting prose and code blocks where they occur in DOM order.**

```js
const parts = [];
// walk nodes; skip hidden/action controls; emit prose text once;
// emit a fenced block for code nodes; do not traverse that code subtree again.
const text = parts.join('\\n').trim();
```

- [ ] **Step 3: Retain existing line-number removal, tool-call language detection, and action-control filtering in the new DOM-order serialization.**

- [ ] **Step 4: Run the focused tests and confirm both tests pass.**

Run: `node tests/test-provider-adapters.js && node tests/test-driver-providers.js`

Expected: exit code 0 and the new extractor contract passes.

### Task 3: Verify the integrated provider suite

**Files:**
- Verify: `resources/providers/qwen.js`
- Verify: `resources/driver.js`
- Verify: `tests/test-provider-adapters.js`
- Verify: `tests/test-driver-providers.js`

- [ ] **Step 1: Run all provider-facing regression tests.**

Run: `node tests/test-provider-adapters.js && node tests/test-driver-providers.js && node tests/test-gateway-providers.js && node tests/test-model-modes.js && node tests/test-thinking-mode.js`

Expected: exit code 0 with no failures.

- [ ] **Step 2: Inspect the final diff.**

Run: `git diff --check && git diff -- resources/providers/qwen.js tests/test-provider-adapters.js tests/test-driver-providers.js`

Expected: no whitespace errors; the diff is limited to Qwen extraction and its regression coverage.
