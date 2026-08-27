# Authenticated live-smoke runner

This runner is intentionally **not** part of `npm test` or CI. It sends short, harmless prompts through the real gateway and may consume provider quota. It never uploads files or asks the model to execute tools.

## Isolated setup

```bash
mkdir -p .local/live-smoke
node resources/dsweb-gateway.js --port 5689 --base "$PWD/.local/live-smoke" --no-migrate
```

Open `http://127.0.0.1:5689/` in the same browser, then use the management page's provider login actions. Complete account login and any human challenge yourself. Do not give passwords, cookies, OTPs, or challenge responses to the test runner.

## Run

```bash
DSWEB_LIVE_TEST=1 \
DSWEB_LIVE_BASE="$PWD/.local/live-smoke" \
node tests/live/run-live-smoke.js \
  --url http://127.0.0.1:5689 \
  --providers deepseek,chatgpt,qwen
```

The runner reads the bearer token only from `<base>/gateway-token`, applies a stable smoke config (`maxConcurrent=1`, `maxPages=8`), probes authenticated `/health` and `/v1/models`, verifies generic error contracts (`401 invalid_api_key`, `404 model_not_found`), then runs a provider matrix: basic SSE text, non-stream JSON, one exact code-block response with normalized code-body matching, one thinking-or-mode-switch request, and one safe tool-call request that must come back as OpenAI `tool_calls` without executing anything locally. It also runs a cancel contract by aborting a live SSE request and checking that `/health` no longer reports busy sessions. Login-state handling distinguishes `challenge_required` from ordinary `login_required`; if a provider is currently under challenge, the report marks it as blocked rather than pretending the smoke passed. The report is written under `output/live-smoke/`; that path is ignored by Git and only contains hashes plus protocol metadata, not credentials, profile paths, prompts, or response text.

## Session isolation and tool/cancel behavior

Each provider reuses one explicit `metadata.dsweb_session_key` for ordinary text, JSON, code-block, and thinking/mode-switch scenarios. The tool-call scenario deliberately uses a second fresh session because the gateway injects the tool protocol only on a first turn; the cancel scenario uses a third isolated session so an aborted request cannot contaminate the normal smoke conversation. A normal provider smoke therefore leaves at most three temporary sessions, which are reclaimed by the gateway TTL.

A `toolCall` pass proves that the provider response was normalized into one OpenAI `tool_calls` result; the runner only requests the inert `echo_marker` schema and never executes the tool. A `cancelContract` pass proves that an aborted SSE stream returns the gateway health state to zero busy sessions. Challenge testing is observation-based: when a provider reports a real browser challenge, the result is `blocked: challenge_required` rather than a false pass.
