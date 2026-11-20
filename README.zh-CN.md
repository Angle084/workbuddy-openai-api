# WorkBuddy 接入 OpenAI API

**简体中文** | [English](README.md)

> 一个零依赖的本地网关，让只支持 Chat Completions 协议的客户端（如 WorkBuddy）用上只提供 Responses API 的模型（如 gpt-6 系列）。

---

## 为什么需要它

OpenAI 的 gpt-6 系列在 `/v1/chat/completions` 下只要带上工具就会直接被拒：

```
400 Function tools with reasoning_effort are not supported in chat/completions
```

而在 `/v1/responses` 下完全正常。也就是说，问题不在 key、不在网络、不在模型权限，而是**两种协议的字段不兼容**。

这个网关就夹在中间，把请求逐字段翻译过去，再把结果翻译回来：

```
客户端 ──chat/completions──▶ 网关 :8788 ──/v1/responses──▶ api.openai.com
        ◀──── SSE ────        ◀──── SSE ────
```

翻译的内容包括：`messages → input`、`tools` 拍平、`tool_calls ↔ function_call`、SSE 事件流、图片输入、思考摘要。

## 特性

| 特性 | 说明 |
|---|---|
| **零依赖** | 只用 Node 内置模块，没有 `node_modules`，clone 下来直接跑 |
| **本地鉴权** | 必须携带 `Bearer <LOCAL_TOKEN>`，`timingSafeEqual` 比对；同机其他程序不能白用你的 key |
| **密钥隔离** | API key 只存放在权限 `0600` 的 env 文件里，客户端配置中只有本地 token |
| **流式** | SSE 逐帧转发，正文与思考分片按序下发 |
| **工具调用** | 完整支持 `tools` / `tool_choice` / 并行调用 / 多轮结果回传 |
| **图片输入** | 支持 `image_url`，包括 base64 data URL |
| **思考摘要** | 可开启，上游返回时转成 `reasoning_content` 下发 |
| **分阶段超时** | connect / tunnel / tls / headers / idle 分开计时，报错能定位到具体阶段 |
| **资源上限** | 最大并发、body 大小、单事件大小均可配置 |
| **25 项单测** | 含 CONNECT 被拒、TLS 超时、下游中断取消挂起连接等边界场景 |
| **离线探针** | `--probe-summary` 造假上游，不花一分钱验证思考流时序 |

## 前置要求

- **Node.js 22 或更高**（用到 `process.loadEnvFile`）
- 一个 OpenAI API key
- 国内网络需要本地 HTTP 代理（默认按 `127.0.0.1:7897` 走，即 Clash 的默认端口）

## 快速开始

### 1. 创建配置文件

密钥文件默认放在 `~/.workbuddy/oa-gateway-v2.env`（Windows 为 `C:\Users\<你>\.workbuddy\oa-gateway-v2.env`）。

手动创建，内容两行：

```ini
OPENAI_API_KEY=sk-proj-你的真实密钥
OA_GW_LOCAL_TOKEN=自己生成一串至少24位的随机字符串
```

`OA_GW_LOCAL_TOKEN` 可以用下面的命令生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> 两个值必须不同，否则启动时会被拒绝。这个 token 是给客户端用的，不是给 OpenAI 用的。

### 2. 校验配置

```bash
node oa-gateway.js --check-config
```

正常输出类似：

```json
{"config":"ok","version":"2.1.0","listen":"127.0.0.1:8788","upstream":"api.openai.com","proxy":"127.0.0.1:7897","localAuth":"required","reasoningSummary":"off","requestsSent":0}
```

注意 `requestsSent: 0`，这一步不发任何请求，不产生费用。

### 3. 启动

```bash
node oa-gateway.js
```

Windows 也可以双击 `Start-Gateway.cmd`。

看到下面这行就说明起来了：

```
[gateway 2.1.0] listening on http://127.0.0.1:8788/v1
```

### 4. 在客户端里填地址

WorkBuddy 的 `~/.workbuddy/models.json` 中，每条自定义模型：

```json
{
  "id": "gpt-6.2-sol",
  "name": "GPT-6.2 SOL",
  "vendor": "OpenAI",
  "url": "http://127.0.0.1:8788/v1",
  "apiKey": "这里填 OA_GW_LOCAL_TOKEN 的值，不是 sk- 密钥",
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

`id` 必须是 OpenAI 的**真实模型名**，网关按它转发。

## 配置项

全部通过环境变量控制，写在 env 文件里或启动前设置。

### 必填

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | OpenAI 密钥 |
| `OA_GW_LOCAL_TOKEN` | 客户端使用的本地令牌，≥24 字符，需与上面的 key 不同 |

### 网络

| 变量 | 默认 | 说明 |
|---|---|---|
| `OA_GW_PORT` | `8788` | 监听端口（仅 127.0.0.1） |
| `OA_GW_UPSTREAM` | `api.openai.com` | 上行主机名 |
| `OA_GW_UPSTREAM_PORT` | `443` | 上行端口 |
| `OA_GW_BASE` | `/v1` | 上行路径前缀 |
| `OA_GW_PROXY_HOST` | `127.0.0.1` | HTTP 代理地址 |
| `OA_GW_PROXY_PORT` | `7897` | HTTP 代理端口 |
| `OA_GW_NO_PROXY` | — | 设为 `1` 则**直连**，不走代理 |

> **海外用户注意**：代理默认是**开启**的。如果你的环境不需要代理，务必设置 `OA_GW_NO_PROXY=1`，否则会连接失败。

### 超时（毫秒）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OA_GW_CONNECT_MS` | `15000` | TCP 连接 |
| `OA_GW_TUNNEL_MS` | `20000` | 代理 CONNECT 隧道 |
| `OA_GW_TLS_MS` | `20000` | TLS 握手 |
| `OA_GW_HEADERS_MS` | `180000` | 等待响应头 |
| `OA_GW_IDLE_MS` | `300000` | 流式空闲上限 |
| `OA_GW_TIMEOUT` | `600000` | 整体上限 |
| `OA_GW_BODY_MS` | `120000` | 请求体接收 |

### 资源与行为

| 变量 | 默认 | 说明 |
|---|---|---|
| `OA_GW_MAX_CONCURRENT` | `8` | 最大并发上游连接 |
| `OA_GW_MAX_BODY_BYTES` | `64MiB` | 请求体上限 |
| `OA_GW_MAX_EVENT_BYTES` | `32MiB` | 单个 SSE 事件上限 |
| `OA_GW_MAX_UPSTREAM_BYTES` | `64MiB` | 上游响应总上限 |
| `OA_GW_REASONING_SUMMARY` | `off` | 思考摘要：`off` / `auto` |
| `OA_GW_SUMMARY_MODELS` | 空 | 只对这些模型开启摘要，逗号分隔 |
| `OA_GW_NONE_MODELS` | `gpt-6-luna,gpt-6.1-terra` | 支持 `none` 档（完全关闭思考）的模型；不在列表里的模型收到"关闭"会降级为 `low` |
| `OA_GW_CARRY_REASONING` | 开 | 设为 `0` 则不把思考回传进多轮历史 |
| `OA_GW_LOG` | 开 | 设为 `0` 关闭请求日志 |
| `OA_GW_MODELS_FILE` | `~/.workbuddy/models.json` | `--init-config` 读取密钥的来源 |

> `OA_GW_NONE_MODELS` 需要跟 OpenAI 的模型更新同步。如果某天新模型支持了 `none` 档，把它加进这个列表，否则客户端选择"关闭思考"只会降级到 `low`。

## 命令行参数

| 参数 | 作用 |
|---|---|
| 无参数 | 启动网关 |
| `--check-config` | 只校验配置并打印摘要，不监听、不发请求 |
| `--config-file PATH` | 使用指定路径的 env 文件 |
| `--init-config MODEL_ID` | 从 models.json 读取指定模型的 `sk-` 密钥，生成 env 文件（`0600`，已存在则不覆盖） |
| `--probe-summary` | 启动离线合成探针（见下） |

## 思考摘要

默认 `off`。开启方式：

```ini
OA_GW_REASONING_SUMMARY=auto
```

开启后，上游若返回 `response.reasoning_summary_text.delta`，网关会转成 `delta.reasoning_content` 下发，客户端就能显示思考块。

**为什么有时候看不到思考内容**

这是上游行为，不是网关丢数据。实测结论：只有模型真正"想得久"时才会产出摘要；简单问题直接作答、`reasoning_tokens` 接近 0 时，摘要就是空的。同一个请求连发三次，可能是 79 个摘要事件、0 个、74 个。

另外，开启摘要会额外消耗 output token（俗称"思考摘要税"），按模型输出价计费。介意成本可以用 `OA_GW_SUMMARY_MODELS` 只对特定模型开启。

## 离线探针

`--probe-summary` 会起一个**假上游**，把"思考先到、正文后到"的时序合成出来，端口仍是 8788：

```bash
node oa-gateway.js --probe-summary
```

```
Local fake-token only: local-summary-probe-only; model: gateway-thinking-probe; no upstream network.
```

然后用这个假 token 请求 `gateway-thinking-probe`，就能验证客户端能不能正确渲染思考块——**不花一分钱、不联网、不需要真 key**。改客户端界面或排查渲染问题时很有用。

## 测试

```bash
node oa-gateway.test.js
```

25 项，覆盖协议转换、SSE 解析、工具调用、超时分类、断连取消等。全程不联网、不花钱。

## 已知限制

- 只监听 `127.0.0.1`，不对外网提供服务。
- 只做协议转换，**不**做模型名映射、不做多账号轮询、不做用量统计——需要这些请考虑 LiteLLM、one-api 这类完整网关。
- 不支持 `audio` / `video` 输入（当前 gpt-6 系列官方也不支持）。
- `auto` 的摘要产出不稳定，原因在上游，网关只负责如实转发。

## 免责声明

个人自用项目，按现状提供，不承诺任何形式的支持或可用性保证。请自行评估使用风险，API 费用由你自己的 key 承担。本项目与 OpenAI 无任何关联，"OpenAI"、"GPT" 等为其各自所有者的商标。

## License

[MIT](LICENSE)
