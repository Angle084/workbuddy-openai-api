# WorkBuddy + OpenAI API

[简体中文](README.zh-CN.md) | **English**

> A zero-dependency local gateway that lets Chat Completions clients (such as WorkBuddy) use models that only expose the Responses API, such as the gpt-6 series.

---

## Why this exists

The gpt-6 family rejects any request that combines function tools with reasoning effort on `/v1/chat/completions`:

```
400 Function tools with reasoning_effort are not supported in chat/completions
```

The exact same request works on `/v1/responses`. So the problem is not your key, not your network, and not model access — it is a protocol mismatch between two API shapes.

This gateway sits in the middle, translating field by field in both directions:

```
Client ──chat/completions──▶ gateway :8788 ──/v1/responses──▶ api.openai.com
       ◀──── SSE ────       ◀──── SSE ────
```

What gets translated: `messages → input`, flattened `tools`, `tool_calls ↔ function_call`, SSE event streams, image inputs, and reasoning summaries.

## Features

| Feature | Notes |
|---|---|
| **Zero dependencies** | Node built-ins only — no `node_modules`, clone and run |
| **Local auth** | Requires `Bearer <LOCAL_TOKEN>`, compared with `timingSafeEqual`; other local programs cannot ride on your key |
| **Key isolation** | Your API key lives only in a `0600` env file; the client config holds just the local token |
| **Streaming** | SSE forwarded frame by frame; reasoning and text deltas arrive in order |
| **Tool calling** | Full support for `tools` / `tool_choice` / parallel calls / multi-turn results |
| **Image input** | Supports `image_url`, including base64 data URLs |
| **Reasoning summaries** | Optional; surfaced as `reasoning_content` when upstream provides them |
| **Staged timeouts** | connect / tunnel / tls / headers / idle timed separately, so errors name the failing stage |
| **Resource limits** | Max concurrency, body size, and per-event size are all configurable |
| **25 unit tests** | Covers refused CONNECT, TLS timeout, and cancelling pending connections on client disconnect |
| **Offline probe** | `--probe-summary` fakes the upstream so you can verify reasoning-stream ordering without spending a cent |

## Requirements

- **Node.js 22 or newer** (uses `process.loadEnvFile`)
- An OpenAI API key
- A local HTTP proxy if `api.openai.com` is not directly reachable from your network — the gateway defaults to `127.0.0.1:7897`, the usual Clash port

## Let an AI do the install

Download the [latest zip](https://github.com/Angle084/workbuddy-openai-api/archive/refs/heads/master.zip), unzip it, and hand the whole folder to an AI assistant with:

> Install this following AI-SETUP.md

[`AI-SETUP.md`](AI-SETUP.md) is a step-by-step execution manual written for an agent: environment probing, config generation, the four verification tests, Windows persistence, and a troubleshooting table mapped to real error codes. It includes explicit rules against claiming success without test evidence — worth knowing, since a gateway that silently isn't running looks like a broken client.

Prefer doing it yourself? Keep reading.

## Quick start

### 1. Create the config file

By default the secret file is read from `~/.workbuddy/oa-gateway-v2.env` (on Windows: `C:\Users\<you>\.workbuddy\oa-gateway-v2.env`).

Create it manually with two lines:

```ini
OPENAI_API_KEY=sk-proj-your-real-key
OA_GW_LOCAL_TOKEN=some-random-string-at-least-24-chars
```

Generate the local token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> The two values must differ, or startup is refused. This token is for your client, not for OpenAI.

### 2. Check the config

```bash
node oa-gateway.js --check-config
```

Expected output:

```json
{"config":"ok","version":"2.1.0","listen":"127.0.0.1:8788","upstream":"api.openai.com","proxy":"127.0.0.1:7897","localAuth":"required","reasoningSummary":"off","requestsSent":0}
```

Note `requestsSent: 0` — this step sends nothing and costs nothing.

### 3. Start it

```bash
node oa-gateway.js
```

On Windows you can also double-click `Start-Gateway.cmd`.

You are up when you see:

```
[gateway 2.1.0] listening on http://127.0.0.1:8788/v1
```

### 4. Point your client at it

In WorkBuddy's `~/.workbuddy/models.json`, for each custom model:

```json
{
  "id": "gpt-6.2-sol",
  "name": "GPT-6.2 SOL",
  "vendor": "OpenAI",
  "url": "http://127.0.0.1:8788/v1",
  "apiKey": "put OA_GW_LOCAL_TOKEN here, not your sk- key",
  "maxInputTokens": 922000,
  "maxOutputTokens": 128000,
  "supportsToolCall": true,
  "supportsImages": true,
  "reasoning": {
    "defaultEffort": "high",
    "supportedEfforts": ["low", "medium", "high", "xhigh", "max"],
    "canDisableThinking": false
  }
}
```

`id` must be the **real** OpenAI model name — the gateway forwards it as-is.

## Configuration

Everything is driven by environment variables, either in the env file or set before launch.

### Required

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI key |
| `OA_GW_LOCAL_TOKEN` | Token your client sends; ≥24 chars, must differ from the key above |

### Network

| Variable | Default | Description |
|---|---|---|
| `OA_GW_PORT` | `8788` | Listen port (127.0.0.1 only) |
| `OA_GW_UPSTREAM` | `api.openai.com` | Upstream hostname |
| `OA_GW_UPSTREAM_PORT` | `443` | Upstream port |
| `OA_GW_BASE` | `/v1` | Upstream path prefix |
| `OA_GW_PROXY_HOST` | `127.0.0.1` | HTTP proxy host |
| `OA_GW_PROXY_PORT` | `7897` | HTTP proxy port |
| `OA_GW_NO_PROXY` | — | Set to `1` to connect **directly**, bypassing the proxy |

> **If you don't need a proxy, set `OA_GW_NO_PROXY=1`.** The proxy is enabled by default; leaving it on in an environment without a local proxy just produces connection errors that look like gateway bugs.

### Timeouts (milliseconds)

| Variable | Default | Stage |
|---|---|---|
| `OA_GW_CONNECT_MS` | `15000` | TCP connect |
| `OA_GW_TUNNEL_MS` | `20000` | Proxy CONNECT tunnel |
| `OA_GW_TLS_MS` | `20000` | TLS handshake |
| `OA_GW_HEADERS_MS` | `180000` | Waiting for response headers |
| `OA_GW_IDLE_MS` | `300000` | Max idle during streaming |
| `OA_GW_TIMEOUT` | `600000` | Overall request |
| `OA_GW_BODY_MS` | `120000` | Receiving request body |

### Resources and behaviour

| Variable | Default | Description |
|---|---|---|
| `OA_GW_MAX_CONCURRENT` | `8` | Max concurrent upstream connections |
| `OA_GW_MAX_BODY_BYTES` | `64MiB` | Request body limit |
| `OA_GW_MAX_EVENT_BYTES` | `32MiB` | Single SSE event limit |
| `OA_GW_MAX_UPSTREAM_BYTES` | `64MiB` | Total upstream response limit |
| `OA_GW_REASONING_SUMMARY` | `off` | Reasoning summaries: `off` / `auto` |
| `OA_GW_SUMMARY_MODELS` | empty | Only enable summaries for these models, comma-separated |
| `OA_GW_NONE_MODELS` | `gpt-6-luna,gpt-6.1-terra` | Models that support the `none` effort (thinking fully off); others downgrade a "disable" request to `low` |
| `OA_GW_CARRY_REASONING` | on | Set `0` to stop carrying reasoning into multi-turn history |
| `OA_GW_LOG` | on | Set `0` to silence request logs |
| `OA_GW_MODELS_FILE` | `~/.workbuddy/models.json` | Source `--init-config` reads the key from |

> `OA_GW_NONE_MODELS` has to be kept in sync with OpenAI's model lineup. When a new model gains the `none` effort, add it here — otherwise choosing "disable thinking" in the client silently degrades to `low`.

## CLI

| Flag | Purpose |
|---|---|
| none | Start the gateway |
| `--check-config` | Validate config and print a summary; no listener, no requests |
| `--config-file PATH` | Use a specific env file |
| `--init-config MODEL_ID` | Read the `sk-` key for that model from models.json and write the env file (`0600`, never overwrites) |
| `--probe-summary` | Start the offline synthetic probe (see below) |

## Reasoning summaries

Off by default. To enable:

```ini
OA_GW_REASONING_SUMMARY=auto
```

When enabled, any `response.reasoning_summary_text.delta` from upstream is converted to `delta.reasoning_content` and forwarded, so the client can render a thinking block.

**Why thinking sometimes doesn't show up**

That is upstream behaviour, not dropped data. In practice summaries only appear when the model actually thinks for a while; on simple prompts where `reasoning_tokens` stays near zero the summary is empty. The same request sent three times in a row produced 79 summary events, then 0, then 74.

Enabling summaries also costs extra output tokens, billed at the model's output rate. If that matters, use `OA_GW_SUMMARY_MODELS` to enable it only for selected models.

## Offline probe

`--probe-summary` starts a **fake upstream** that synthesises the "reasoning first, text second" ordering, still on port 8788:

```bash
node oa-gateway.js --probe-summary
```

```
Local fake-token only: local-summary-probe-only; model: gateway-thinking-probe; no upstream network.
```

Request `gateway-thinking-probe` with that fake token to check whether your client renders the thinking block correctly — **no cost, no network, no real key**. Useful when changing client UI or debugging rendering.

## Tests

```bash
node oa-gateway.test.js
```

25 tests covering protocol conversion, SSE parsing, tool calls, timeout classification, and disconnect cancellation. No network, no cost.

## Limitations

- Listens on `127.0.0.1` only; not intended to serve other machines.
- Protocol translation only — **no** model name mapping, no multi-account rotation, no usage accounting. If you need those, look at LiteLLM or one-api.
- No `audio` / `video` input (the gpt-6 series doesn't support it either).
- `auto` summary output is inconsistent; the cause is upstream and the gateway forwards faithfully.

## Disclaimer

A personal project, provided as-is, with no support or availability guarantee. Use at your own risk; API charges are billed to your own key. Not affiliated with OpenAI. "OpenAI" and "GPT" are trademarks of their respective owners.

## License

[MIT](LICENSE)
