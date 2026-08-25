# Assistant-Only Response Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure DeepSeek web parsing emits only assistant result text, never user prompts, while retaining short answers, tool-call payloads, and the existing thinking suppression.

**Architecture:** Replace the mixed, broad selector fallback in `EXPR.extractLast` with a strict ordered set of assistant-owned message roots. Extract only the latest match from one of those roots; return empty if no verified assistant root exists. The gateway continues to suppress `kind='thinking'` and route final tool calls through its existing tool-call path.

**Tech Stack:** Node.js CommonJS, browser DOM expression strings, offline VM/fake-DOM assertion tests.

---

### Task 1: Add user-leak regression coverage

**Files:**
- Modify: `tests/test-thinking-mode.js`

- [ ] **Step 1: Write failing user-only DOM tests**

```js
const USER_PROMPT = '请分析这个项目的所有文件，并立即开始修改。';
const userOnly = makeDoc({ '.ds-markdown': [el({ cls: 'ds-markdown', children: [tx(USER_PROMPT)] })] });
check('unscoped markdown user prompt is never parsed as assistant content',
  runExpr(extractLastExpr, userOnly) === '');
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node tests/test-thinking-mode.js`

Expected: FAIL because the current broad `.ds-markdown` selector returns the user prompt.

### Task 2: Restrict driver extraction

**Files:**
- Modify: `resources/driver.js`

- [ ] **Step 1: Replace broad `direct`, markdown, and message fallbacks**

Use only assistant-root selectors such as `.ds-assistant-message-main-content`, `[class*="assistant-message-main"]`, `[data-role="assistant"]`, and `[data-message-author-role="assistant"]`. For each selector, return text from its final matching assistant root. Do not fall back to unscoped markdown/message/answer nodes.

- [ ] **Step 2: Preserve short replies and tool text**

The verified assistant-root path must accept non-empty text, allowing both `2` and an assistant-emitted tool-call payload to reach the existing gateway parser.

### Task 3: Verify output contract

**Files:**
- Verify: `tests/test-thinking-mode.js`
- Verify: `tests/test-parser-all.js`
- Verify: `tests/test-completeness.js`
- Verify: all `tests/test-*.js`

- [ ] **Step 1: Run focused parser and stream tests**

Run: `node tests/test-thinking-mode.js && node tests/test-parser-all.js && node tests/test-completeness.js`

Expected: all pass; user DOM is ignored, assistant tool text remains eligible for tool routing, and thinking remains hidden.

- [ ] **Step 2: Run all offline test files and check diff hygiene**

Run: `for test in tests/test-*.js; do node "$test"; done && git diff --check`

Expected: all pass and no whitespace errors.
