# dsh-deepseek-web-adapter — Beta multisite Web-to-OpenAI gateway

> **Chinese**: [README.md](README.md)

> ⚠️ **Beta / Developer Preview**: a local **Web-to-OpenAI** gateway for authenticated DeepSeek, ChatGPT, and Qwen web sessions.
> Provider routing, isolated profiles, and offline coverage are implemented; **real logged-in manual acceptance is still pending. This project does not claim live verification.**
> Use only accounts you are authorized to use and complete the authenticated smoke tests before release.

The DSH plugin still starts one local gateway exposing `/v1/models` and `/v1/chat/completions` (SSE). Existing DeepSeek models remain available; the Beta adds:

- ChatGPT: `chatgpt-auto`, `chatgpt-thinking`
- Qwen: `qwen-auto`, `qwen-thinking`, `qwen-fast`, `qwen-auto-max`, `qwen-thinking-max`, `qwen-fast-max`
- Each provider has an independent browser profile, session, and login state; cookies and sessions are never shared across providers.

**Conservative boundary:** text, code blocks, and basic SSE only. No attachments or multimodal input; no challenge solving or bypassing (CAPTCHA, Turnstile, etc.); no translation of native artifacts, tool cards, traces, or iframes into OpenAI-native artifacts.

**Docs**: [User guide](docs/user-guide.md) · [Publishing guide](docs/publishing.md) · [Multisite specification](spec/SPEC-multisite.md) · [Plugin tutorial](docs/dsh-plugin-tutorial.md)

## Known limitations

| Limitation | Notes |
|---|---|
| Beta quality | Not extensively tested in real environments; behavior may be unstable |
| Multi-account concurrency degrades to serial (P0) | With multiple accounts, concurrency drops to 1 (switching accounts restarts the single browser); single-account keeps full session-affinity concurrency |
| Dynamic risk control is unpredictable | Fair-use limits have no published numbers or unfreeze times — the gateway only trusts on-page signals, backs off exponentially and probes recovery; it **cannot promise when an account unfreezes** |
| Built-in plugin management UI | This package now ships its own management frontend at `http://127.0.0.1:5688/`: onboarding, quick login, status checks, account checks, config management, and diagnostics. A future native DSH settings card can reuse the same JSON interfaces (`/setup`, `/health`, `/accounts`, `/config`) |
| Requires a real browser | Needs Chrome installed locally; login state is kept in the `runtime/profiles/` browser profile directory — persists across restarts when "Keep me signed in" is ticked; re-login needed after DeepSeek tokens expire |
| Provider profile isolation | DeepSeek, ChatGPT, and Qwen use separate profiles; sign in through `/login?provider=...` for each |
| Conservative protocol boundary | Text, code blocks, and basic SSE only; no attachments/multimodal input, challenge solving, or native artifact/iframe semantics |
| ChatGPT challenge | Returns a manual-action provider challenge error, distinct from a DOM selector error |
| Qwen mode controls | Unavailable thinking/search returns `mode_unavailable`; it is not silently downgraded |
| Depends on DeepSeek web UI | UI changes may break selectors (calibration/send/extract); `driver.js` then needs updating |
| Parser is tolerant, not infallible | 54-case regression covers common formats; exotic malformed model output may still fail |

## Install

```bash
dsh plugin --profile web add dsh-deepseek-web-adapter
# or from GitHub (after publishing):
dsh plugin --profile web add github:your-name/dsh-deepseek-web-adapter
```

On load, the gateway starts automatically (3–8s; see the DSH terminal log:
`DeepSeek 网页版网关已监听 5688`).

After install, open `http://127.0.0.1:5688/` for the built-in **Web Provider Console**: fixed DeepSeek/ChatGPT/Qwen status cards, provider-scoped login and account actions, a next-action queue for login/challenge/cooling states, global gateway configuration, and diagnostics. `GET /providers` exposes the same three-provider aggregate as JSON.

## Configure the DSH provider

Edit `~/.dsh/settings.yaml`, inside `llm-pi-ai.providers: { ... }` add:

```yaml
dsweb:
  {
    displayName: Beta multisite Web-to-OpenAI (no API key),
    apiKeyEnv: MOCK_LLM_KEY,
    api: openai-completions,
    baseURL: http://127.0.0.1:5688/v1/,
    models:
      [
        { id: deepseek-chat, name: DeepSeek Quick },
        { id: deepseek-reasoner, name: DeepSeek Deep Think },
        { id: deepseek-search, name: DeepSeek Smart Search },
        { id: deepseek-think-search, name: DeepSeek Deep Think + Search },
        { id: deepseek-expert, name: DeepSeek Expert },
        { id: deepseek-expert-reasoner, name: DeepSeek Expert + Deep Think },
        { id: deepseek-vision, name: DeepSeek Vision },
        { id: deepseek-vision-reasoner, name: DeepSeek Vision + Deep Think },
        { id: chatgpt-auto, name: ChatGPT Auto (Beta) },
        { id: chatgpt-thinking, name: ChatGPT Thinking (Beta) },
        { id: qwen-auto, name: Qwen Auto (Beta) },
        { id: qwen-thinking, name: Qwen Thinking (Beta) },
        { id: qwen-fast, name: Qwen Fast (Beta) },
        { id: qwen-auto-max, name: Qwen Auto Max (Beta) },
        { id: qwen-thinking-max, name: Qwen Thinking Max (Beta) },
        { id: qwen-fast-max, name: Qwen Fast Max (Beta) }
      ]
  }
```

Add `MOCK_LLM_KEY: sk-mock-any-value` to `~/.dsh/.credentials.yaml` (any value; the gateway does not check it).
DSH config hot-reloads — the DeepSeek Web models appear in the model picker immediately.

## Login

**Manually sign in to each provider separately** in local Chrome. Start from the management page or open these routes directly:

```text
http://127.0.0.1:5688/login?provider=deepseek
http://127.0.0.1:5688/login?provider=chatgpt
http://127.0.0.1:5688/login?provider=qwen
```

The default profiles are `deepseek-default`, `chatgpt-default`, and `qwen-default`. Do not copy or share profile directories across providers. Omitting `provider` remains backward-compatible and selects DeepSeek.

If ChatGPT exposes a Cloudflare, Turnstile, or other challenge, the gateway returns a **manual-action** `challenge_required`/`provider_challenge_required` error that is distinct from a DOM-selector error; it will not solve or bypass the challenge. If Qwen thinking/search cannot be enabled, the request returns `mode_unavailable` rather than silently using the wrong mode.

## Usage

Pick **Beta multisite Web-to-OpenAI** in the DSH model picker. DeepSeek keeps its eight existing models; ChatGPT and Qwen are Beta text/code/basic-SSE channels only.

| Page mode | Optional pills | Model IDs |
|---|---|---|
| Quick | Deep Think, Smart Search (can both be on) | `deepseek-chat` / `deepseek-reasoner` / `deepseek-search` / `deepseek-think-search` |
| Expert | Deep Think | `deepseek-expert` / `deepseek-expert-reasoner` |
| Vision | Deep Think | `deepseek-vision` / `deepseek-vision-reasoner` |

| Capability | Notes |
|---|---|
| Continuous chat | Web page keeps history; auto-migrates (summary + new session) beyond the length limit (default 50 turns, configurable) |
| Tool calling | Model emits a `tool_call` code block → gateway parses it (54-case hardened parser) → DSH executes |
| Mode switching | Idempotent pill toggling (reads state first, clicks only on mismatch); falls back to recorded calibration when pills are not found |
| Session-affinity concurrency | Fingerprinted sessions get dedicated browser channels; same session serial, different sessions parallel, idle channels recycled |
| Multi-account storage | Each account has its own browser profile dir (persisted cookies), managed via the `/accounts` API (v2, implemented) |
| Auto re-login | On session expiry the gateway opens a login window (mutually exclusive), then retries on the same account in recovery mode (v2, implemented) |
| Quota-triggered switching | Dynamic risk control: exponential backoff (5min × 2ⁿ, capped 6h) + probe recovery; on quota, switches accounts and rebuilds context from compressed history (v2, implemented) |

## Manual control

```bash
# Open the plugin management page (recommended)
open http://127.0.0.1:5688/
# Fetch onboarding JSON (designed to be reusable by a future native DSH settings card)
curl http://127.0.0.1:5688/setup
# Check gateway status
curl http://127.0.0.1:5688/v1/models
# Runtime status (login / sessions / channels / account pool / config)
curl http://127.0.0.1:5688/health
# Login status (completion is auto-detected)
curl http://127.0.0.1:5688/login-status
# Tune runtime config (parameters below)
curl -X POST http://127.0.0.1:5688/config -H 'Content-Type: application/json' -d '{"maxConcurrent": 3}'
# Model calibration (fallback recording for when mode pills are missing: record → collect → save)
curl http://127.0.0.1:5688/calibrate/list     # stored calibration data
curl http://127.0.0.1:5688/calibrate/record   # start recording (headed window + click capture)
# DOM inspection (model-selector troubleshooting)
curl http://127.0.0.1:5688/debug
# Restart the gateway (removing the plugin stops it; re-adding auto-starts it)
dsh plugin --profile web remove dsh-deepseek-web-adapter && dsh plugin --profile web add dsh-deepseek-web-adapter
```

`/config` tunables (POST JSON, takes effect immediately):

| Parameter | Range (default) | Notes |
|---|---|---|
| `headless` | bool (false) | Headless mode (changing it requires a gateway restart + re-login) |
| `maxConcurrent` | 1-5 (2) | Global concurrent-generation cap |
| `maxPages` | 1-8 (4) | Browser channel cap (evicts the longest-idle session when full) |
| `maxTurnsPerChat` | 2-500 (50) | Max turns per web chat (auto-migrates + summarizes beyond it) |
| `accountPool` | bool (true) | Account-pool switch (false = always use default, v1 behavior) |
| `maxAccounts` | 1-8 (3) | Per-provider account count cap |
| `autoRelogin` | bool (true) | Auto-open a login window on session expiry and retry |
| `quotaBackoffBaseMs` | 60s-1h (5min) | Risk-control exponential-backoff base |
| `quotaBackoffMaxMs` | 30min-24h (6h) | Risk-control exponential-backoff cap |

Account management (v2, implemented):

```bash
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"name": "acc2"}'      # add a DeepSeek account (opens a login window, 5-min timeout)
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"provider":"qwen","name":"acc2"}' # add a provider-scoped account
curl http://127.0.0.1:5688/accounts                                        # account states (backoff / stats)
curl -X POST http://127.0.0.1:5688/accounts/disable -d '{"name": "acc2"}'  # disable
curl -X POST http://127.0.0.1:5688/accounts/enable -d '{"name": "acc2"}'   # enable (requires login verification to resume)
curl -X POST http://127.0.0.1:5688/accounts/remove -d '{"name": "acc2", "confirm": true}'  # remove (profile dir kept)
```

✅ Implemented: `GET /setup` onboarding JSON, `GET /providers` provider aggregate, and `GET /` Web Provider Console.

## Structure

```
lib/index.js          # host: auto-launches the gateway on load, recycles it on unload
resources/
  dsweb-gateway.js    # core gateway (OpenAI API + login + calibration + session affinity + account pool + tool parsing)
  driver.js           # browser engine (persistent Chrome + channel management + limit detection)
  runtime/            # runtime (driver copy + calibration data + accounts.json + profiles/ per-account dirs)
spec/
  SPEC.md             # v1 dev spec (current behavior baseline)
  SPEC-v2.md          # v2 spec (multi-account / auto login / quota switching — core implemented)
cordis.patch.yml      # bundle config patch
```

## How it works

```
DSH (dsweb provider) → gateway :5688 → driver (provider-isolated Chrome profile) → DeepSeek / ChatGPT / Qwen Web
plugin load → spawn gateway → unload → recycle
```

DeepSeek Web has no native function calling — the gateway uses prompt engineering to make the model emit
`tool_call` JSON, then converts it to standard `tool_calls` via a multi-layer tolerant parser
(nested JSON, parameter aliases, single-backslash Windows paths, trailing commas, unquoted keys,
retry safety net) for DSH to execute. Tool results feed back into the web page and the model continues.

Fair-use risk control on the web app has **no published quota numbers or unfreeze schedule**, so the
gateway never guesses numbers: limit signals are detected only from on-page text (`detectLimit` pattern
table, covering dynamic wordings such as "服务器繁忙"), and a suspect account is only confirmed after a
second hit inside a 10-minute window. Confirmed accounts cool down with exponential backoff
(5min × 2ⁿ, capped at 6h) and recover via a real probing request. On quota mid-request the gateway
switches to another account (budget: 2 switches per request) and rebuilds context from compressed history.
Regression suites: 54 parser scenarios + 61 account-pool scenarios (`tests/`).

## Development / maintenance

**MIT License — anyone may fork, modify, continue development, and re-publish without permission.**

To take over or contribute:

```bash
# 1. Fork or clone
git clone https://github.com/huermi/dsh-deepseek-web-adapter.git
# 2. No third-party runtime deps (Node 18+ and Chrome only)
# 3. Run the gateway locally for debugging
node resources/dsweb-gateway.js --port 5688 --base resources/runtime
# 4. Run the regression suites (mandatory after touching driver.js / dsweb-gateway.js)
node tests/test-parser-all.js      # expect 54/54 pass
node tests/test-account-pool.js    # expect 61/61 pass
```

**This repo now contains a directly usable plugin management frontend** (`/`) and reusable JSON interfaces (`/setup`, `/health`, `/accounts`, `/config`). If you later want a native DSH settings card, build it on top of these interfaces.

Key maintenance points:
- `resources/driver.js` — browser engine + tool-call parser + limit detection (update when DeepSeek web UI changes; **single source of truth**, the gateway executes this file directly at runtime — no copy to sync)
- `resources/dsweb-gateway.js` — gateway (OpenAI API / login / calibration / concurrency / account pool / migration)
- `lib/index.js` — plugin host (launches gateway on load, recycles on unload)

## License

MIT — free to use/modify/redistribute with the copyright notice retained. See [LICENSE](LICENSE).