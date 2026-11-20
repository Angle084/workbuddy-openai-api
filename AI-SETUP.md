# Let an AI install this for you

**English** | [简体中文](AI-SETUP.zh-CN.md)

> This file is written **for an AI assistant**, not as a human tutorial. A human only needs to do one thing: **hand this whole folder to your AI and say "install this following AI-SETUP.md"**.
>
> The AI does the rest: probing, configuring, starting, verifying. It comes back to you only for your API key and a couple of choices.

---

## Ground rules for the AI

Read this first. Violating any of these means the task failed.

1. **Never claim success without evidence.** Every step needs real command output. If you have no output, do not write "done".
2. **The key goes into the env file only.** The user's `sk-` key belongs in `~/.workbuddy/oa-gateway-v2.env` and **nowhere else** — not `models.json`, not command-line args, not logs, not git, not your reply. Never echo it.
3. **`apiKey` in `models.json` is the local token, not an `sk-` key.** This is the single most common mistake — see [Step 4](#step-4-point-workbuddy-at-the-gateway).
4. **Verification means real requests.** `--check-config` alone is not success.
5. **When unsure, test it.** Do not assert ports, model IDs, or field names from memory.
6. **Touch nothing you weren't asked to change.** Only add/modify the OpenAI entries you are installing. Leave the user's other entries exactly as they are.

> All commands here are **POSIX shell**. On Windows use Git Bash (ships with Git for Windows), not PowerShell — `$HOME`, `$(...)` and `grep` behave differently there.

---

## Step 0: Probe the environment (read-only, change nothing yet)

```bash
node --version
```

Requires **Node.js ≥ 22** (the code uses `process.loadEnvFile`). If lower, ask the user to upgrade — do not patch around it.

```bash
ls -la "$USERPROFILE/.workbuddy/models.json"    # Windows
ls -la "$HOME/.workbuddy/models.json"           # macOS / Linux
```

```bash
# Is a local proxy listening? (7897 is Clash's usual port)
netstat -ano | grep LISTEN | grep -E ":7897|:7890|:1080|:10809"
```

```bash
# Is the gateway port already taken?
netstat -ano | grep LISTEN | grep ":8788"
```

**Decide three things from the results:**

| Probe result | Decision |
|---|---|
| No local proxy listening | Add `OA_GW_NO_PROXY=1`, otherwise the gateway dials a proxy that isn't there and fails |
| Proxy exists, but not on 7897 | Set `OA_GW_PROXY_PORT=<actual port>` |
| 8788 already taken | Pick another port (`OA_GW_PORT=...`) and update `url` in `models.json` to match |

## Step 1: Collect four things from the user

Ask all four in one go, not as a back-and-forth:

1. **OpenAI API key** (`sk-...`). Tell them it is written to one local file with mode 0600 and appears nowhere else.
2. **Which models.** If unsure, offer this default list (ordered strongest → cheapest):

   | Model ID | Display name | Positioning |
   |---|---|---|
   | `gpt-6.2-astra` | OpenAI-GPT 6.2 ASTRA | Strongest, most expensive |
   | `gpt-6.2-sol` | OpenAI-GPT 6.2 SOL | Main workhorse |
   | `gpt-6.1-terra` | OpenAI-GPT 6.1 TERRA | Cheaper |
   | `gpt-6-luna` | OpenAI-GPT 6 LUNA | Cheapest |

   > This assumes the account has access to them. If the user says one doesn't work, test each and trust the test — don't copy this table blindly.

3. **Reasoning summaries on or off.** Explain the trade-off: enabling them costs extra output tokens, and **upstream provides them on demand** — you get summaries when the model actually thinks for a while, and nothing on trivial prompts. "Sometimes there's no thinking block" is normal, not a misconfiguration.
4. **Port** (default 8788 — only change it if taken).

## Step 2: Write the env file

Target: `~/.workbuddy/oa-gateway-v2.env`.

**Prefer the built-in command**, which generates a random local token and sets mode 0600:

```bash
node oa-gateway.js --init-config gpt-6.2-sol
```

Know its constraints:

- It looks up the row in `models.json` whose `id` matches, whose `url` points at localhost, and whose `apiKey` starts with `sk-`, then extracts that key.
- **It fails if no such row exists yet** — in that case skip it and create the file by hand.
- It **never overwrites** an existing file; it errors out. That's intentional.
- If `models.json` already holds a local token (a previous install), you must use the manual path.

Manual creation:

```bash
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
cat > "$HOME/.workbuddy/oa-gateway-v2.env" <<EOF
OPENAI_API_KEY=the-users-real-key
OA_GW_LOCAL_TOKEN=$TOKEN
EOF
chmod 600 "$HOME/.workbuddy/oa-gateway-v2.env"
```

Then append the optional lines indicated by Step 0:

```ini
# No local proxy — important, or it cannot connect
OA_GW_NO_PROXY=1

# Proxy on a non-default port
OA_GW_PROXY_PORT=7890

# Non-default listen port
OA_GW_PORT=8788

# Enable reasoning summaries
OA_GW_REASONING_SUMMARY=auto
```

**Rules:** `OPENAI_API_KEY` and `OA_GW_LOCAL_TOKEN` **must differ** or startup is refused; the local token must be at least 24 characters.

## Step 3: Validate the config (no requests, no cost)

```bash
node oa-gateway.js --check-config
```

Expect something like:

```json
{"config":"ok","version":"2.1.0","listen":"127.0.0.1:8788","upstream":"api.openai.com","proxy":"127.0.0.1:7897","localAuth":"required","reasoningSummary":"auto","requestsSent":0}
```

Check the port under `listen` and that `proxy` matches reality (it should read `off` when no proxy is used). `requestsSent: 0` confirms nothing was sent.

**Do not continue if this errors.** Usual causes: Node too old, wrong env path, key equals token, or `OA_GW_REASONING_SUMMARY` set to something other than `auto`/`off`.

## Step 4: Point WorkBuddy at the gateway

Edit `~/.workbuddy/models.json`. It is an **array** — one entry per model.

Leave existing entries alone; only add or modify the OpenAI entries being installed.

```json
{
  "id": "gpt-6.2-sol",
  "name": "OpenAI-GPT 6.2 SOL",
  "vendor": "OpenAI",
  "url": "http://127.0.0.1:8788/v1",
  "apiKey": "paste OA_GW_LOCAL_TOKEN here — not the sk- key",
  "maxInputTokens": 922000,
  "maxOutputTokens": 128000,
  "temperature": 1,
  "supportsToolCall": true,
  "supportsImages": true,
  "supportsReasoning": true,
  "useCustomProtocol": false,
  "reasoning": {
    "defaultEffort": "high",
    "supportedEfforts": ["low", "medium", "high", "xhigh", "max"],
    "canDisableThinking": false
  }
}
```

**Hard requirements:**

| Field | Requirement | If wrong |
|---|---|---|
| `id` | **Exact real OpenAI model name** | The gateway forwards it verbatim — a typo becomes "model not found" upstream |
| `apiKey` | **The local token** from `OA_GW_LOCAL_TOKEN` | An `sk-` key here gets rejected (401) |
| `url` | `http://127.0.0.1:<port>/v1` | Must match the port in env |
| `vendor` | `OpenAI` | `Custom` just loses the icon (cosmetic) |
| `canDisableThinking` | `true` **only** for `gpt-6-luna` and `gpt-6.1-terra` | On other models, choosing "disable thinking" gets a 400 upstream |

On `maxInputTokens`: the context is 1,050,000 with up to 128,000 reserved for output, so usable input is roughly **922,000**. Putting 1,050,000 won't crash, but it lets the client believe it can send more than upstream accepts. 922,000 is the honest number.

**Per-model effort differences:**

| Model | Default effort | Can disable thinking |
|---|---|---|
| `gpt-6.2-astra` | `high` | No |
| `gpt-6.2-sol` | `high` | No |
| `gpt-6.1-terra` | `high` | **Yes** |
| `gpt-6-luna` | `xhigh` | **Yes** |

**Then do both of these:**

```bash
# 1) Prove it is valid JSON — do not trust your own edit
node -e "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.workbuddy/models.json','utf8')); console.log('JSON OK')"
```

```bash
# 2) Prove no real key leaked in (this should print nothing)
grep -l "sk-" "$HOME/.workbuddy/models.json"
```

## Step 5: Start the gateway

**Start it in the foreground first and read the log line.** "I launched a background task" is not "it started".

```bash
node oa-gateway.js
```

Success looks like:

```
[gateway 2.1.0] listening on http://127.0.0.1:8788/v1
```

On Windows the user can also double-click `Start-Gateway.cmd`.

## Step 6: Verify (do not skip)

**6.1 Authentication must be enforced** — no token should be 401:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6.2-sol","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

Must print `401`. If it prints `200`, auth is not working — **stop and investigate**.

**6.2 Every model must actually respond:**

```bash
TOKEN=$(grep '^OA_GW_LOCAL_TOKEN=' "$HOME/.workbuddy/oa-gateway-v2.env" | cut -d= -f2-)

for M in gpt-6.2-astra gpt-6.2-sol gpt-6.1-terra gpt-6-luna; do
  printf "%-16s " "$M"
  curl -s -m 60 -X POST http://127.0.0.1:8788/v1/chat/completions \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"reply exactly: ok\"}],\"max_tokens\":20}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.choices?'OK '+JSON.stringify(j.choices[0].message.content):'ERR '+JSON.stringify(j.error||j).slice(0,120))}catch(e){console.log('FAIL '+s.slice(0,100))}})"
done
```

All four must print `OK`. Any `ERR` → Step 8.

**6.3 Tool calling works** (this is the whole reason the project exists):

```bash
curl -s -m 60 -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-6.2-sol","messages":[{"role":"user","content":"Call get_time now, no prose."}],"tools":[{"type":"function","function":{"name":"get_time","description":"Get time","parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto","max_tokens":120}' \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const c=j.choices[0];console.log('finish='+c.finish_reason+' tool='+(c.message.tool_calls?c.message.tool_calls[0].function.name:'none'))})"
```

Expect `finish=tool_calls tool=get_time`.

**6.4 Streaming works:**

```bash
curl -sN -m 60 -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-6.2-sol","stream":true,"messages":[{"role":"user","content":"count 1 2 3"}],"max_tokens":40}' \
| grep -c "^data:"
```

Should be greater than 1.

## Step 7: Make it persistent (optional, strongly recommended)

The process idles at 0 CPU and ~40–50 MB RAM. **Don't go "start it only when I need it"**: when it's down, only these models fail with "connection refused" while everything else works, and that half-broken state is hard to trace back to a missing process.

### Windows: a VBS launcher (hidden window + crash recovery)

Create `start.vbs` next to `oa-gateway.js`. **Build quotes with `Chr(34)` — never hand-write consecutive escaped quotes.** This is a real trap that was hit in practice: get it wrong and the script fails to compile, the double-click does nothing, and no error is shown.

```vbs
Option Explicit
Dim sh, fso, dir, Q, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Q   = Chr(34)
cmd = "cmd /c node " & Q & dir & "\oa-gateway.js" & Q & " >> " & Q & dir & "\oa-gateway.log" & Q & " 2>&1"
Do
  sh.Run cmd, 0, True
  WScript.Sleep 5000
Loop
```

The loop restarts the gateway 5 seconds after it exits. Single-instance behaviour comes from the gateway itself: a taken port makes it exit non-zero, and this loop then retries every 5 seconds. If you don't want the retry noise, kill the process holding the port before launching.

Autostart: put a shortcut to the `.vbs` into `shell:startup` (`Win+R` → `shell:startup`). Some security suites silently block VBS at logon; fall back to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

### macOS / Linux

Use the platform service manager (launchd / systemd user unit) to run `node oa-gateway.js` with that directory as the working dir and restart-on-failure enabled. **No template is shipped here** — untested templates are worse than none.

### Prove persistence actually works

This is the one thing you cannot infer — **kill it, wait, confirm it came back**:

```bash
netstat -ano | grep ":8788" | grep LISTEN
```

Kill that PID, wait 8 seconds, look again. New PID + still listening = recovery works.

**Logon autostart can only be confirmed by the user on their next login.** Say so plainly and give them the check command. Do not claim "autostart configured, it will run on boot".

## Step 8: Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:8788` | Gateway isn't running | Start it; if it was meant to be persistent, check whether the launcher itself died |
| `proxy_closed` / `upstream_unreachable` | Gateway is dialling a proxy that isn't there | `OA_GW_NO_PROXY=1` without a proxy; otherwise check `OA_GW_PROXY_PORT` |
| `upstream_tls_failed` | TLS handshake failed | Bad proxy node, or something intercepting certificates |
| `401` even with the right token | `apiKey` in `models.json` is an `sk-` key | Replace with `OA_GW_LOCAL_TOKEN` |
| Upstream says model not found | Wrong `id`, or no access to that model | Use the real model name; verify account access |
| `Function tools ... not supported` | Request bypassed the gateway | Make sure `url` points at `127.0.0.1:8788/v1`, not `api.openai.com` |
| "Disable thinking" still shows thinking | That model has no `none` effort | The gateway downgrades to `low`. Only luna/terra truly disable. When a new model gains `none`, add it to `OA_GW_NONE_MODELS` |
| Summaries enabled but nothing appears | Upstream provides them on demand | Expected. Short thinking → no summary. Retrying may produce one |
| Saving in the settings UI resets name/icon to `Custom` | The client overwrites the whole record with form values | Restore `vendor: "OpenAI"` and `name`. Prefer editing the file directly for parameter changes |

## Things you must not do

- ❌ Don't modify gateway source to make it "work" (relaxing auth, disabling TLS verification). Diagnose with Step 8 first.
- ❌ Don't put an `sk-` key into `models.json`, the README, a screenshot, or a commit.
- ❌ Don't tell the user it's installed without testing. They will verify on their own machine and come back.
- ❌ Don't "improve" the user's other model entries.
- ❌ Don't bind the listener to `0.0.0.0`. It is designed for localhost only.

## Definition of done

Installed only when all of these are true:

- [ ] `--check-config` prints `config: ok`
- [ ] A request without a token returns **401**
- [ ] Every target model returned real content
- [ ] Tool calling returns `finish_reason: tool_calls`
- [ ] Streaming returned multiple `data:` frames
- [ ] `models.json` is valid JSON and contains no `sk-`
- [ ] The user knows that a down gateway breaks only these models, and how to restart it

Then report results to the user as a table (model / status / latency), and tell them the one thing only they can do: **send a real message in WorkBuddy and see it answer**.
