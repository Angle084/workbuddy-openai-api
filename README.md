# 🔌 WorkBuddy + OpenAI API

**English** · [简体中文](README.zh-CN.md) · [📦 Download v2.1.1](https://github.com/Angle084/workbuddy-openai-api/releases/tag/v2.1.1) · [🤖 AI setup guide](AI-SETUP.md)

Use **your own OpenAI API key** with WorkBuddy through a local, dependency-free adapter. Keep streaming, function tools and optional reasoning summaries on a Chat Completions client.

**Node.js 22+ · Localhost only · MIT · Unofficial**

```text
WorkBuddy ── Chat Completions ──► local gateway ── Responses ──► OpenAI
          ◄── text / tools / optional reasoning summary ◄──────────────
```

| 📦 New install | 🧪 Try it without a key | 🔄 Already using v2.1.0 |
|---|---|---|
| Download the release ZIP, unzip, then open `START-HERE.txt`. | Run `node oa-gateway.js --probe-summary` on port `8789`. No upstream traffic. | Keep your env file, model entries and token. Start the new version after stopping your old instance, or test on an unused port. |

## What this solves

WorkBuddy sends Chat Completions requests. Some model and parameter combinations used by agent clients (such as tools together with reasoning options) can behave differently on `/v1/chat/completions` and `/v1/responses`. This gateway routes requests through Responses and translates them back. It **doesn't** mean the GPT-6 family is Responses-only: [OpenAI lists both endpoints for GPT-6.2 Astra and Sol](https://help.openai.com/en/articles/9624314-model-release-notes).

- Streams text as SSE; validates final function arguments before forwarding tool calls.
- Bridges parallel calls, tool-result turns, image input and structured output where the upstream model supports them.
- Keeps the real API key out of WorkBuddy model entries. Authenticated requests use a separate random local token.
- Reports staged connection errors and preserves upstream HTTP failures; closes upstream work when the client disconnects.

## 🚀 Quick start

1. Install **Node.js 22+**. Download the ZIP from [Releases](https://github.com/Angle084/workbuddy-openai-api/releases/latest) and extract it. No `npm install` is needed. See the [AI setup guide](AI-SETUP.md) if you want help setting up.
2. Create `~/.workbuddy/oa-gateway-v2.env` locally ([permissions and migration](AI-SETUP.md#2-prepare-the-private-configuration)). Fill the real key **yourself**, in a local editor. Never send it in chat, pass it on the command line or commit it. The local token is also private.

   ```ini
   OPENAI_API_KEY=replace_in_your_local_editor
   OA_GW_LOCAL_TOKEN=replace_with_a_separate_random_token
   ```

   Generate the local token in a **private terminal**, not one whose output is sent to an assistant: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. The two credentials must differ. If you connect directly, add `OA_GW_NO_PROXY=1`. Otherwise set `OA_GW_PROXY_PORT` to your verified HTTP CONNECT port (default `7897`).
3. Run the following from the extracted folder. Leave the gateway running; run the last command in another terminal. If the chosen port is occupied, select a free port and use the same number in all steps. On Windows, `Start-Gateway.cmd` also respects the configured port unless you supply an override.

   ```sh
   node oa-gateway.js --check-config
   node oa-gateway.js
   node oa-gateway.js --verify-local
   ```

4. In WorkBuddy, add a custom model: address `http://127.0.0.1:8788/v1` (replace the port if needed), your upstream model ID (e.g. `gpt-6.2-sol`), and **`OA_GW_LOCAL_TOKEN`** in the API Key field. Enable tool calling, image input or reasoning only for supported models. See the [model entry example](AI-SETUP.md#4-add-only-the-selected-models).

## ✅ Verify before relying on it

`--verify-local` checks the running gateway version and that an unauthenticated request is rejected (`401`). It sends no OpenAI request. The optional checks below each send **one billable request** to the model you name. Run only the checks you need and only with authorized models/credentials. They require nonempty text, the expected tool call, or a complete SSE stream respectively; they do not print credentials or full responses.

```sh
node oa-gateway.js --verify-live text gpt-6.2-sol
node oa-gateway.js --verify-live tool gpt-6.2-sol
node oa-gateway.js --verify-live stream gpt-6.2-sol
```

If started with `--port 8790` or `Start-Gateway.cmd 8790`, give the same `--port 8790` to verification commands. Finally send a message in WorkBuddy; CLI checks don't test the client configuration.

## 💭 Reasoning summaries

Set `OA_GW_REASONING_SUMMARY=auto`, or run `Start-Gateway.cmd summary` on Windows. Only summaries sent by the upstream are shown; some models or replies return none. WorkBuddy gets `reasoning_content`, **not raw/private reasoning**. [OpenAI says summaries have no additional fee](https://openai.com/index/new-tools-and-features-in-the-responses-api/); model usage, including reasoning tokens, is still billed under the applicable pricing.

For a no-cost UI test, run `node oa-gateway.js --probe-summary`, then set the model to `gateway-thinking-probe`, base URL to `http://127.0.0.1:8789/v1` and API key to the **public fake token** `local-summary-probe-only`. Enable the model's reasoning capability and send a message. The probe uses synthetic input/output, ignores your saved credentials and does not replace anything on `8788`. Stop it with Ctrl+C when done.

<details>
<summary>⚙️ Configuration and developer notes</summary>

| Setting | Default / effect |
|---|---|
| `OA_GW_PORT` | `8788`; `--port PORT` overrides it for start/check/verify. |
| `OA_GW_UPSTREAM`, `OA_GW_UPSTREAM_PORT`, `OA_GW_BASE` | `api.openai.com`, `443`, `/v1`. Do not forward an OpenAI key to an untrusted host. |
| `OA_GW_PROXY_HOST`, `OA_GW_PROXY_PORT`, `OA_GW_NO_PROXY` | `127.0.0.1`, `7897`; `OA_GW_NO_PROXY=1` disables the proxy. |
| `OA_GW_REASONING_SUMMARY`, `OA_GW_SUMMARY_MODELS` | `off` by default. `auto` requests summaries. An optional comma-separated model list limits where it applies. |
| `OA_GW_NONE_MODELS`, `OA_GW_CARRY_REASONING` | Models that accept `none`; on other models it maps to `low`. Set carry to `0` to disable encrypted reasoning carryover. |
| `OA_GW_CONNECT_MS`, `OA_GW_TUNNEL_MS`, `OA_GW_TLS_MS`, `OA_GW_HEADERS_MS`, `OA_GW_IDLE_MS`, `OA_GW_TIMEOUT`, `OA_GW_BODY_MS` | Configurable stage timeouts in milliseconds. |
| `OA_GW_MAX_CONCURRENT`, `OA_GW_MAX_BODY_BYTES`, `OA_GW_MAX_EVENT_BYTES`, `OA_GW_MAX_UPSTREAM_BYTES` | Concurrency and byte limits. |
| `OA_GW_LOG`, `OA_GW_MODELS_FILE` | `0` disables request logging; the second customizes the source for legacy migration. |

`--config-file PATH` selects a different env file. `--init-config MODEL_ID` is for **legacy migration only**: it can copy an existing key from an exactly matching local model, and never overwrites the destination. See the setup guide for permissions.

Run `npm test` or `node --test oa-gateway.test.js` (Node 22+, OpenSSL CLI for local TLS fixtures). Tests use loopback fixtures, not OpenAI. The gateway is not a public relay, account pool or billing dashboard. Audio/video input is not implemented in this adapter.

</details>

[MIT license](LICENSE). Not affiliated with OpenAI or WorkBuddy. The gateway is local; real prompts and tool results are sent to your configured upstream when you make an API request.
