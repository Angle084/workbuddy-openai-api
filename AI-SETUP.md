# 🤖 WorkBuddy gateway: AI setup guide

**English** · [简体中文](AI-SETUP.zh-CN.md) · [Home](README.md)

For an assistant authorized to help with installation. Configure only the selected models. Do not ask for, read out or collect keys. Leave the private steps below to the user.

## 1. Check the environment and scope

- Run `node --version`: Node.js 22+ is required, with no npm dependencies to install.
- Confirm model IDs, summary preference, upstream and proxy. The default port is `8788`. Inspect it with `Get-NetTCPConnection -State Listen -LocalPort 8788` on Windows or `lsof -nP -iTCP:8788 -sTCP:LISTEN` where available. Identify any existing listener; **do not stop unknown processes**. Choose an unused port for a side-by-side check (e.g. `8790`, after checking). The offline probe uses `8789`.
- Confirm the proxy supports HTTP CONNECT, not just that a port is open. Use `OA_GW_NO_PROXY=1` for direct connections where available. Do not install proxies or change TLS verification or system networking without authorization.
- Give the user an expected request count before any potentially billable tests and obtain approval. Otherwise run local checks only.

## 2. Prepare the private configuration

Defaults: `%USERPROFILE%\.workbuddy\oa-gateway-v2.env` (Windows) or `~/.workbuddy/oa-gateway-v2.env` (macOS/Linux). Ensure the directory exists. **Keep existing configuration**; check file presence without showing contents or overwriting it.

1. On a new install, prepare only an empty file or placeholders. Restrict access first. The user fills in `OPENAI_API_KEY` and a separate `OA_GW_LOCAL_TOKEN` in a local editor. They can generate the token in a private terminal using `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`; do not capture its output. Never send either credential to chat, on a command line, into logs or into Git. The local token must be at least 24 characters.
2. **Windows:** In Properties → Security → Advanced, inspect the NTFS ACL. If inheritance grants other ordinary users access, restrict this new file to the account running the gateway and necessary system/admin principals. Check with `icacls "$env:USERPROFILE\.workbuddy\oa-gateway-v2.env"` in PowerShell. Node `mode: 0o600` or Git Bash `chmod` **does not prove that Windows ACLs restrict access**.
3. **macOS/Linux:** Use `umask 077` before creation; apply `chmod 600 ~/.workbuddy/oa-gateway-v2.env` and verify with `ls -l`. Do not overwrite an existing file or put it in a shared directory.
4. **Legacy migration only:** With explicit approval, `node oa-gateway.js --init-config MODEL_ID` copies an existing key from an exact local model entry without overwriting the destination. On Windows, first verify the destination directory's inherited ACL; use the manual setup if unsure. Have the user replace that old model's API key value with the local token after migration; do not batch-edit other entries.

Set `OA_GW_PORT=8790` if needed, `OA_GW_NO_PROXY=1` for direct connections, or `OA_GW_PROXY_PORT` for HTTP CONNECT. Reasoning summaries are off by default; `OA_GW_REASONING_SUMMARY=auto` requests them but does not guarantee any will be returned.

## 3. Check, start and verify locally

Run from the extracted directory. `8790` is an example; use the selected port. Run the last command in another terminal. You can also put the port in the env file and omit `--port`. If using a non-default config path, pass the same `--config-file` for every operation.

```sh
node oa-gateway.js --port 8790 --check-config
node oa-gateway.js --port 8790
node oa-gateway.js --port 8790 --verify-local
```

Check for `config: ok` and the expected listener address. Local verification must show `ok: true`, `authStatus: 401`, and `upstreamAttempts: 0`. Do not send a token if this fails. On Windows, `Start-Gateway.cmd 8790` also works; no port argument preserves the configured port. Get separate approval for background or autostart setup, and only manage this project's process.

## 4. Add only the selected models

Prefer WorkBuddy's model settings. Enter `http://127.0.0.1:ACTUAL_PORT/v1` and a real model ID available to the user. Have the user enter `OA_GW_LOCAL_TOKEN` as the API key. The UI's connection test may make a live request; don't run it without authorization.

If requested to edit `~/.workbuddy/models.json`, preserve the array/object shape, other entries and fields. Validate JSON and do not print the whole file.

```json
{
  "id": "gpt-6.2-sol",
  "name": "GPT-6.2 Sol",
  "vendor": "OpenAI",
  "url": "http://127.0.0.1:8790/v1",
  "apiKey": "enter OA_GW_LOCAL_TOKEN locally",
  "supportsToolCall": true,
  "supportsImages": true,
  "supportsReasoning": true,
  "useCustomProtocol": false
}
```

Use each model's actual capabilities, context limits and reasoning options. To keep the original entry in a side-by-side test, you can use `gpt-6.2-sol@gateway-v2`; the gateway removes the suffix before sending it upstream.

## 5. Optional live checks (billable usage)

Test only selected models. Start with one `text` per model, and optionally use `tool` or `stream` on one appropriate model. One model with all three modes means **three requests**. Do not widen the scope or retry automatically.

```sh
node oa-gateway.js --port 8790 --verify-live text gpt-6.2-sol
node oa-gateway.js --port 8790 --verify-live tool gpt-6.2-sol
node oa-gateway.js --port 8790 --verify-live stream gpt-6.2-sol
```

`text` requires nonempty content and a normal finish. `tool` validates a named no-argument test call but executes nothing. `stream` requires visible content, a normal finish and `[DONE]`. `summaryReceived: false` isn't a streaming failure. The CLI doesn't print credentials or raw responses. Use the [offline probe on 8789](README.md#-reasoning-summaries) if needed, then have the user confirm behaviour in WorkBuddy.

## 6. Report and troubleshoot

| Signal | Action |
|---|---|
| `wrong_gateway_version` / `health_failed` | Verify the listener, port and version; try a free port without stopping other services. |
| `local_auth_not_verified` / HTTP 401 | Distinguish a local credential mismatch from rejected upstream auth without printing secrets. |
| HTTP 400 / 404 | Check the ID, access and parameter support. Don't silently change the production model or effort. |
| Proxy or TLS errors | Verify HTTP CONNECT settings or whether direct access is appropriate; keep TLS validation enabled. |
| `missing_complete_text` / `incomplete_stream` | Not a pass. Check truncation or stream errors and get approval before another billable attempt. |

Report the actual address, models and modes tested, their outcomes, and the number of attempted live requests. **Local checks, OpenAI connectivity, and the WorkBuddy UI are separate verification levels.**
