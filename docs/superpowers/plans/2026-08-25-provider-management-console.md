# Provider Management Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before production changes. Steps use checkbox syntax for tracking.

**Goal:** Make the 5688 management page a provider-aware command center for DeepSeek, ChatGPT, and Qwen.

**Architecture:** Add one provider aggregation builder in `resources/dsweb-gateway.js`; expose it through `/providers` and embed it in `/setup`. Replace the current DeepSeek-centric HTML renderer with a small dependency-free dashboard that reads the aggregate, retains the existing global APIs, and sends provider in every account action.

**Tech Stack:** Node.js CommonJS, built-in HTTP/VM tests, static HTML/CSS/JavaScript returned by the gateway.

---

### Task 1: Provider aggregate contract

**Files:**
- Modify: `resources/dsweb-gateway.js`
- Modify: `tests/test-gateway-providers.js`
- Modify: `tests/test-management-ui.js`

- [x] Add failing tests for `GET /providers` and `/setup.providers`, asserting all three providers, default profiles, per-provider models, provider account summaries, and a Qwen login state.
- [x] Implement `buildProvidersPayload()` using registry metadata, per-provider `getLoginSnapshot()`, and provider-filtered account summaries; expose `/providers` and attach `providers` to `/setup`.
- [x] Run `node tests/test-gateway-providers.js && node tests/test-management-ui.js`.

### Task 2: Provider command-center renderer

**Files:**
- Modify: `resources/dsweb-gateway.js`
- Modify: `tests/test-management-ui.js`

- [x] Add failing source/VM assertions for three provider cards, selected-provider detail panel, provider-specific login links, and provider-aware account API payloads.
- [x] Replace the DeepSeek-only management markup/script with the command-center layout: global summary, provider cards, selected detail, model list, provider-filtered account table, action queue, global config/diagnostics.
- [x] Make initial selection prefer provider attention states and make every account action include provider.
- [x] Run management/gateway tests.

### Task 3: Documentation and browser verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/user-guide.md`
- Modify: `tests/test-completeness.js`

- [x] Document the Provider 指挥台, `/providers`, and provider-scoped account actions.
- [x] Run all `tests/test-*.js`, syntax checks, `git diff --check`, then start the gateway with the fake driver and visually inspect 5688 at desktop and narrow widths.
