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

The runner reads the bearer token only from `<base>/gateway-token`, calls authenticated `/health`, `/v1/models`, `/login-status`, and one basic SSE completion for each selected provider. It writes a sanitized report under `output/live-smoke/`; that path is ignored by Git. The report contains hashes and protocol metadata, not credentials, profile paths, prompts, or response text.
