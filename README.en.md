# dsh-deepseek-web-adapter

> **中文**: [README.md](README.md)

Turn **DeepSeek Web (chat.deepseek.com)** into a free, API-key-free LLM provider for DeepSeek Harness (DSH).
On plugin load, a local gateway (`resources/dsweb-gateway.js` + `driver.js`, one persistent browser) is
spawned automatically and serves an OpenAI-compatible API. Supports: continuous chat, tool calling,
model calibration, and concurrent sub-agents.

- No API key, no third-party login (just your own DeepSeek account)
- `dsh plugin add` — one command; the gateway auto-starts/stops

## Install

```bash
dsh plugin --profile web add dsh-deepseek-web-adapter
# or from GitHub (after publishing):
dsh plugin --profile web add github:your-name/dsh-deepseek-web-adapter
```

On load, the gateway starts automatically (3–8s; see the DSH terminal log:
`DeepSeek 网页版网关已监听 5688`).

## Configure the DSH provider

Edit `~/.dsh/settings.yaml`, inside `llm-pi-ai.providers: { ... }` add:

```yaml
dsweb:
  {
    displayName: DeepSeek Web (no API key),
    apiKeyEnv: MOCK_LLM_KEY,
    api: openai-completions,
    baseURL: http://127.0.0.1:5688/v1/,
    models:
      [
        { id: deepseek-chat, name: DeepSeek Fast },
        { id: deepseek-reasoner, name: DeepSeek Expert },
        { id: deepseek-vision, name: DeepSeek Vision }
      ]
  }
```

Add `MOCK_LLM_KEY: sk-mock-any-value` to `~/.dsh/.credentials.yaml` (any value; the gateway does not check it).
DSH config hot-reloads — the DeepSeek Web models appear in the model picker immediately.

## Login

Open `http://127.0.0.1:5688/login` in a browser and sign in to chat.deepseek.com.
If a "Keep me signed in / Remember me" option exists, tick it — the session persists across restarts.

## Usage

Pick **DeepSeek Web** (Fast / Expert / Vision) in the DSH model picker.

| Capability | Notes |
|---|---|
| Continuous chat | Web page keeps history; auto-migrates (summary + new session) beyond the length limit (default 50 turns, configurable) |
| Tool calling | Model emits a `tool_call` code block → gateway parses it (54-case hardened parser) → DSH executes |
| Model calibration | `deepseek-reasoner` → Expert mode (calibration data bundled; can be re-recorded) |
| Sub-agent concurrency | Concurrent requests use separate pages (parallel windows) |

## Manual control

```bash
# Check gateway status
curl http://127.0.0.1:5688/v1/models
# Restart the gateway (removing the plugin stops it; re-adding auto-starts it)
dsh plugin --profile web remove dsh-deepseek-web-adapter && dsh plugin --profile web add dsh-deepseek-web-adapter
```

## Structure

```
lib/index.js          # host: auto-launches the gateway on load, recycles it on unload
resources/
  dsweb-gateway.js    # core gateway (OpenAI API + login + calibration + concurrency + migration + tool parsing)
  driver.js           # browser engine (single persistent page)
  runtime/            # runtime (driver copy + calibration data; profile auto-created on first run)
cordis.patch.yml      # bundle config patch
```

## How it works

```
DSH (dsweb provider) → gateway :5688 → driver (persistent Chrome) → chat.deepseek.com
plugin load → spawn gateway → unload → recycle
```

DeepSeek Web has no native function calling — the gateway uses prompt engineering to make the model emit
`tool_call` JSON, then converts it to standard `tool_calls` via a multi-layer tolerant parser
(nested JSON, parameter aliases, single-backslash Windows paths, trailing commas, unquoted keys,
retry safety net) for DSH to execute. Tool results feed back into the web page and the model continues.
Regression suite: 54 scenarios (see `tests/` in the dev repo).

## License

MIT
