# 让 AI 帮你装好 —— 执行手册

[English](AI-SETUP.md) | **简体中文**

> 这份文件是写给 **AI 助手** 读的，不是给人读的教程。人只需要做一件事：**把这个文件夹整体交给你的 AI，说"按 AI-SETUP.zh-CN.md 帮我装好"**。
>
> 之后的所有步骤、判断、验收都由 AI 完成，只在你需要提供密钥或做选择时才会来问你。

---

## 给 AI 的硬性纪律

在开始之前，先读这一节。违反任何一条都算任务失败。

1. **不要假装成功。** 每一步都必须有命令输出作为证据。没有真实输出就不要写"已完成"。
2. **密钥只进 env 文件。** 用户的 `sk-` 密钥只能写进 `~/.workbuddy/oa-gateway-v2.env`。**绝不能**写进 `models.json`、命令行参数、日志、git、聊天回复，也不要回显。
3. **`models.json` 里的 `apiKey` 是本地令牌，不是 `sk-`。** 这是本设计最容易搞错的一点，详见 [第 4 步](#第-4-步把-workbuddy-指到网关)。
4. **验收必须实测。** 只跑 `--check-config` 不算成功，必须真的发出请求并收到模型回复。
5. **遇到不确定的事，先测再说。** 不要凭记忆断言端口、模型 ID、字段名。
6. **不要修改用户的其它配置。** 只动 `models.json` 中你新增的那些条目，其余原样保留。

> 本文所有命令按 **POSIX shell** 编写。Windows 上请用 Git Bash（随 Git for Windows 提供），不要直接粘进 PowerShell——`$HOME`、`$(...)`、`grep` 在 PowerShell 里语义不同。

---

## 第 0 步：探明环境（先只读，不要改任何东西）

依次执行，把结果记下来：

```bash
node --version
```

- 要求 **Node.js ≥ 22**（代码用了 `process.loadEnvFile`）。低于 22 请让用户先升级，不要试图改代码绕过。

```bash
# 确认 WorkBuddy 的模型配置在哪
echo "$USERPROFILE"
ls -la "$USERPROFILE/.workbuddy/models.json"
```

```bash
# 是否有本地代理在监听（默认按 7897 猜，Clash 常用端口）
netstat -ano | grep LISTEN | grep -E ":7897|:7890|:1080|:10809"
```

```bash
# 网关要用的端口是否已被占用
netstat -ano | grep LISTEN | grep ":8788"
```

**需要据此判断三件事：**

| 探测结果 | 你要做的决定 |
|---|---|
| 没有本地代理在监听 | 在 env 里加 `OA_GW_NO_PROXY=1`，否则网关会去连一个不存在的代理并报错 |
| 有代理但端口不是 7897 | 在 env 里设 `OA_GW_PROXY_PORT=<实际端口>` |
| 8788 已被占用 | 换端口（`OA_GW_PORT=其他值`），并同步改 `models.json` 的 `url` |

## 第 1 步：向用户收四个信息

用一次提问把下面四件事问完，不要一个个来回问：

1. **OpenAI API Key**（`sk-` 开头）。告诉用户：这个值只会写进本机一个权限 0600 的文件，不会出现在任何别的地方。
2. **要接入哪些模型。** 如果用户不清楚，给这份默认清单，并说明它是从"能力最强"到"最便宜"排列：

   | 模型 ID | 显示名 | 定位 |
   |---|---|---|
   | `gpt-6.2-astra` | OpenAI-GPT 6.2 ASTRA | 最强，也最贵 |
   | `gpt-6.2-sol` | OpenAI-GPT 6.2 SOL | 主力，性价比 |
   | `gpt-6.1-terra` | OpenAI-GPT 6.1 TERRA | 更便宜 |
   | `gpt-6-luna` | OpenAI-GPT 6 LUNA | 最便宜 |

   > 前提：该账号确实有这些模型的权限。如果用户说某个不能用，就逐个试，以实测为准，不要照抄这个表。

3. **是否要显示思考摘要。** 说明代价：开启后会多消耗 output token（按模型输出价计费），且**上游是按需给的**——模型想得久才给，简单问题没有，所以"有时候看不到"是正常的，不是配置错误。
4. **网关端口**（默认 8788，被占了才需要换）。

## 第 2 步：写 env 配置文件

目标路径：`~/.workbuddy/oa-gateway-v2.env`（Windows 即 `C:\Users\<用户名>\.workbuddy\oa-gateway-v2.env`）。

**优先用内置命令生成**，它会自动生成随机本地令牌、并把文件权限设成 0600：

```bash
node oa-gateway.js --init-config gpt-6.2-sol
```

注意它的约束，不要踩：

- 这个命令会去 `models.json` 里找 `id` 等于你传入值、且 `url` 指向本机、`apiKey` 是 `sk-` 开头的那一行，从中取出真密钥。
- **如果 `models.json` 里还没有这样的条目，它会失败** —— 那就跳过这步，手工建文件（见下）。
- 文件已存在时它**不会覆盖**，会直接报错退出。这是有意设计的。
- 如果用户的 `models.json` 里的 `apiKey` 已经是本地令牌（之前装过），也必须走手工方式。

手工建文件，权限自己设：

```bash
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
cat > "$HOME/.workbuddy/oa-gateway-v2.env" <<EOF
OPENAI_API_KEY=用户的真实密钥
OA_GW_LOCAL_TOKEN=$TOKEN
EOF
chmod 600 "$HOME/.workbuddy/oa-gateway-v2.env"
```

写入后按第 0 步的判断追加可选行：

```ini
# 没有本地代理时（重要，否则连不上）
OA_GW_NO_PROXY=1

# 代理端口不是 7897 时
OA_GW_PROXY_PORT=7890

# 换端口
OA_GW_PORT=8788

# 要思考摘要时
OA_GW_REASONING_SUMMARY=auto
```

**规则**：`OPENAI_API_KEY` 与 `OA_GW_LOCAL_TOKEN` **必须不同**，否则拒绝启动；本地令牌至少 24 字符。

## 第 3 步：校验配置（不发请求、不花钱）

```bash
node oa-gateway.js --check-config
```

期望看到类似：

```json
{"config":"ok","version":"2.1.0","listen":"127.0.0.1:8788","upstream":"api.openai.com","proxy":"127.0.0.1:7897","localAuth":"required","reasoningSummary":"auto","requestsSent":0}
```

逐项核对：`listen` 的端口对不对、`proxy` 是不是你的实际情况（不需要代理时这里应显示 `off`）。`requestsSent: 0` 表示这一步没有任何网络请求。

**这里报错就别往下走**，通常是：Node 版本太低、env 文件路径不对、key 与 token 相同、`OA_GW_REASONING_SUMMARY` 写成了 `auto`/`off` 以外的值。

## 第 4 步：把 WorkBuddy 指到网关

编辑 `~/.workbuddy/models.json`。这是一个**数组**，为每个模型加一条。

用户已有条目**不要动**，只追加或修改本次要接入的 OpenAI 条目。

```json
{
  "id": "gpt-6.2-sol",
  "name": "OpenAI-GPT 6.2 SOL",
  "vendor": "OpenAI",
  "url": "http://127.0.0.1:8788/v1",
  "apiKey": "这里填 OA_GW_LOCAL_TOKEN 的值，不是 sk- 开头的密钥",
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

**字段的硬性要求：**

| 字段 | 要求 | 出错后果 |
|---|---|---|
| `id` | **必须是 OpenAI 真实模型名** | 网关原样转发，写错就是上游报"模型不存在" |
| `apiKey` | **本地令牌**，从 env 里的 `OA_GW_LOCAL_TOKEN` 复制 | 填成 `sk-` 会被网关拒（401 或直接不认） |
| `url` | `http://127.0.0.1:<端口>/v1` | 端口要和 env 一致 |
| `vendor` | 写 `OpenAI` | 写成 `Custom` 会丢掉图标（纯外观问题） |
| `canDisableThinking` | 只有 `gpt-6-luna`、`gpt-6.1-terra` 为 `true` | 其它模型开这个，用户点"关闭思考"会被上游 400 |

`maxInputTokens` 说明：模型的上下文是 1,050,000，其中输出最多占 128,000，所以**输入实际可用上限约 922,000**。填 1,050,000 不会崩，但会让客户端以为能塞进更多而被上游拒绝。填 922,000 更准。

**四个模型的档位差异（照这个填）：**

| 模型 | 默认档位 | 可关闭思考 |
|---|---|---|
| `gpt-6.2-astra` | `high` | 否 |
| `gpt-6.2-sol` | `high` | 否 |
| `gpt-6.1-terra` | `high` | **是** |
| `gpt-6-luna` | `xhigh` | **是** |

**写完后必须做两件事：**

```bash
# 1) 确认是合法 JSON（不要相信"我写对了"）
node -e "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.workbuddy/models.json','utf8')); console.log('JSON OK')"
```

```bash
# 2) 确认没有把 sk- 密钥写进去（下面这条应当没有任何输出）
grep -l "sk-" "$HOME/.workbuddy/models.json"
```

## 第 5 步：启动网关

**先在前台起，看到监听成功的日志再谈常驻。** 不要把"起了个后台任务"当成"启动成功"。

```bash
node oa-gateway.js
```

成功时输出：

```
[gateway 2.1.0] listening on http://127.0.0.1:8788/v1
```

Windows 也可以双击 `Start-Gateway.cmd`。

## 第 6 步：验收（这一步不能省）

**6.1 鉴权必须生效** —— 不带令牌应为 401：

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6.2-sol","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

必须输出 `401`。如果是 `200`，说明鉴权没生效，**立刻停下来检查**。

**6.2 每个模型都要真实通一次**（把令牌换成 env 里的值）：

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

四个都必须是 `OK`。有任何一个 `ERR`，看第 8 步的排查表。

**6.3 工具调用能通**（这是本项目存在的理由，必须单独验）：

```bash
curl -s -m 60 -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-6.2-sol","messages":[{"role":"user","content":"Call get_time now, no prose."}],"tools":[{"type":"function","function":{"name":"get_time","description":"Get time","parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto","max_tokens":120}' \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const c=j.choices[0];console.log('finish='+c.finish_reason+' tool='+(c.message.tool_calls?c.message.tool_calls[0].function.name:'none'))})"
```

期望 `finish=tool_calls tool=get_time`。

**6.4 流式能通：**

```bash
curl -sN -m 60 -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-6.2-sol","stream":true,"messages":[{"role":"user","content":"count 1 2 3"}],"max_tokens":40}' \
| grep -c "^data:"
```

输出应该大于 1（多个 `data:` 帧）。

## 第 7 步：设成常驻（可选，但强烈建议）

网关是一个约 40–50 MB 内存、空闲 CPU 为 0 的进程，常驻没有负担。**不建议"用时才开"**：没开时只有这几个模型报"连接被拒绝"，其他模型一切正常，这种半失效状态很难第一时间想到原因。

### Windows：VBS 启动器（隐藏窗口 + 崩溃自愈）

在网关目录里建 `start.vbs`，**引号一律用 `Chr(34)` 拼接，不要手写连续转义引号**（这是实际踩过的坑，写错会导致脚本编译失败、双击毫无反应且没有任何报错）：

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

这个循环的意义：进程崩溃后 5 秒自动拉起。配合端口占用检测，就不会起第二份。

> 注意：单实例保护要靠网关自己 —— 端口被占用时它会以非 0 退出，然后这个循环会每 5 秒重试一次。如果不想刷日志，先杀掉占端口的进程再启动。

开机自启：把该 `.vbs` 的快捷方式放进 `shell:startup`（`Win+R` 输入 `shell:startup`）。有些安全软件会静默拦掉开机运行的 VBS，那种情况下改用注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。

### macOS / Linux

用系统自带的服务管理器（launchd / systemd user unit）托管 `node oa-gateway.js`，工作目录设为网关目录，并设置"失败后重启"。**本仓库不提供现成模板**（未经测试，不写没验证过的东西）。

### 验证常驻是否真的生效

这是唯一不能靠推断、必须实测的环节：**结束进程，等几秒，确认它自己回来了**。

```bash
# 记下当前 PID
netstat -ano | grep ":8788" | grep LISTEN
```

杀掉它，等 8 秒，再查一次。PID 变了且端口仍在监听 = 自愈生效。

**开机自启只能由用户在下次登录后自己确认**，你无法代验。请如实告知用户这一点，并给出检查命令，而不是声称"已配置完成，开机就会自动运行"。

## 第 8 步：故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:8788` | 网关没起 | 启动它；若是常驻，检查是不是启动器自己崩了 |
| `proxy_closed` / `upstream_unreachable` | 网关在找一个不存在的代理 | 环境无代理就加 `OA_GW_NO_PROXY=1`；有代理则核对 `OA_GW_PROXY_PORT` |
| `upstream_tls_failed` | TLS 握手失败 | 代理节点有问题，或中间设备做了证书拦截 |
| `401` 但令牌是对的 | `models.json` 的 `apiKey` 填成了 `sk-` | 换成 env 里的 `OA_GW_LOCAL_TOKEN` |
| 上游报 `model not found` | `id` 拼错，或账号没有该模型权限 | 用真实模型名，并确认账号权限 |
| `Function tools ... not supported` | 请求没经过网关 | 检查 `url` 是不是指向了 `api.openai.com` 而不是 `127.0.0.1:8788/v1` |
| 用户点"关闭思考"仍看到思考 | 该模型不支持 `none` 档 | 网关会降级为 `low`。只有 luna / terra 能真关。新模型支持时，改 env 的 `OA_GW_NONE_MODELS` |
| 设了 summary 但看不到思考 | 上游按需下发 | 正常现象。模型想得短就不给摘要，重发一次可能就有 |
| 设置页点了保存，模型名/图标变回 `Custom` | 客户端会用表单值覆盖整条记录 | 手工改回 `vendor: "OpenAI"` 和 `name`。**以后改档位等参数建议直接改文件，不要走设置页** |

## 明确不要做的事

- ❌ 不要为了跑通去改网关源码（比如放宽鉴权、跳过 TLS 校验）。先按第 8 步查真实原因。
- ❌ 不要把 `sk-` 密钥写进 `models.json`、README、截图、git 提交。
- ❌ 不要在没实测的情况下告诉用户"已装好"。用户后续会自己装到手机上验证，装不成会来找你。
- ❌ 不要顺手"优化"用户的其它模型条目。
- ❌ 不要把网关监听地址改成 `0.0.0.0`。它设计为仅本机可用。

## 完成标准

只有下面全部为真，才算装好：

- [ ] `--check-config` 输出 `config: ok`
- [ ] 无令牌请求返回 **401**
- [ ] 每个目标模型都真实返回了内容
- [ ] 工具调用返回 `finish_reason: tool_calls`
- [ ] 流式返回多个 `data:` 帧
- [ ] `models.json` 是合法 JSON，且不含 `sk-`
- [ ] 用户知道"网关没起时只有这几个模型不可用"，以及怎么重启

全部满足后，用一张表把实测结果报给用户（模型 / 状态 / 耗时），并说明还需要他本人做的最后一件事：**在 WorkBuddy 里实际发一条消息试试**。
