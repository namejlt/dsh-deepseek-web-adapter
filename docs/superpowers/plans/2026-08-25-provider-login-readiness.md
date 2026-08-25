# Provider Login Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated ChatGPT and Qwen profiles serve DSH requests without false `login_required` errors.

**Architecture:** Make status inspection resolve the requested provider/profile rather than an arbitrary open tab. Extend both adapters to support current contenteditable composers and ignore hidden sign-in controls. During a request, distinguish a real login/challenge from an authenticated page whose composer is still hydrating; wait briefly for the latter and report a DOM error only if it never appears.

**Tech Stack:** Node.js CommonJS driver, browser DOM expression strings, offline adapter/driver tests, local authenticated smoke requests.

---

### Task 1: Reproduce provider readiness failures

**Files:**
- Modify: `tests/test-provider-adapters.js`
- Modify: `tests/test-driver-providers.js`

- [ ] **Step 1: Add ChatGPT and Qwen contenteditable composer tests.**
- [ ] **Step 2: Add hidden-login-button tests.**
- [ ] **Step 3: Assert provider inspection does not reuse an arbitrary browser tab.**

### Task 2: Correct readiness logic

**Files:**
- Modify: `resources/providers/chatgpt.js`
- Modify: `resources/providers/qwen.js`
- Modify: `resources/driver.js`

- [ ] **Step 1: Support textarea and contenteditable composer variants while retaining scoped send controls.**
- [ ] **Step 2: Restrict sign-in detection to visible controls.**
- [ ] **Step 3: Wait up to 15 seconds for an authenticated provider composer before returning `dom_unavailable`; reserve `login_required` for an actual login state.**

### Task 3: Verify local authenticated profiles

**Files:**
- Verify: all `tests/test-*.js`

- [ ] **Step 1: Run all offline tests and `git diff --check`.**
- [ ] **Step 2: Restart the local gateway after committing, then send `Reply with exactly: OK` to ChatGPT and Qwen through `/v1/chat/completions`.**
