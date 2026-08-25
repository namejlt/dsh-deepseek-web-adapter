# Local Session Title Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete DSH’s deterministic session-title request locally so it cannot open a second web tab or leave the first interaction active after the primary answer is available.

**Architecture:** Recognize only the exact system instruction used for AI coding-session title generation plus its JSON-array user payload. Parse the supplied human-message texts, generate a compact one-line title locally, and return a normal OpenAI-compatible streaming or non-streaming completion before account/session/driver allocation.

**Tech Stack:** Node.js CommonJS, OpenAI-compatible JSON/SSE responses, offline gateway VM tests.

---

### Task 1: Capture the title request contract

**Files:**
- Modify: `tests/test-completeness.js`

- [ ] **Step 1: Add a non-streaming title payload based on DSH’s actual system and user messages.**
- [ ] **Step 2: Assert the result is a single local title and no `streamAsk` RPC is invoked.**
- [ ] **Step 3: Assert a streaming title request returns role/content/stop/[DONE] without driver use.**

### Task 2: Implement the local route

**Files:**
- Modify: `resources/dsweb-gateway.js`

- [ ] **Step 1: Strictly identify the title system instruction and parse the JSON human-message array.**
- [ ] **Step 2: Derive a concise one-line title from the most recent human message.**
- [ ] **Step 3: Return OpenAI-compatible JSON or SSE before the request allocates a session lock, semaphore slot, account, driver, or browser page.**

### Task 3: Verify ordinary model behavior remains unchanged

**Files:**
- Verify: all `tests/test-*.js`

- [ ] **Step 1: Run `node tests/test-completeness.js`.**
- [ ] **Step 2: Run every offline test and `git diff --check`.**
