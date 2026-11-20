# 🤖 WorkBuddy 网关：AI 安装手册

**简体中文** · [English](AI-SETUP.md) · [返回首页](README.zh-CN.md)

这份手册给已获用户授权的安装助手使用。只处理本次选中的模型；不要读取、回显或收集密钥。用户自行完成下面标注的本地私密操作。

## 1. 探测环境并确认范围

- 运行 `node --version`，要求 Node.js 22+，无需安装 npm 依赖。
- 确认用户要配置的模型 ID、是否需要推理摘要，以及上游和代理。端口默认 `8788`；Windows 可用 `Get-NetTCPConnection -State Listen -LocalPort 8788` 查看占用，其他系统可用 `lsof -nP -iTCP:8788 -sTCP:LISTEN`。已有服务就识别归属，**不停止未知进程**；旁路验收可用空闲端口（如 `8790`，先检查），`8789` 留给离线探针。
- HTTP 代理要确认支持 CONNECT，不能只凭端口号推断；允许直连时用 `OA_GW_NO_PROXY=1`。不要擅自装代理、改 TLS 验证或系统网络设置。
- 在线验收前明确预计请求数并获得授权；未同意时只做本地验收。

## 2. 准备私有配置

默认 `%USERPROFILE%\.workbuddy\oa-gateway-v2.env`（Windows），或 `~/.workbuddy/oa-gateway-v2.env`（macOS/Linux）。确认父目录存在。**优先保留已有配置**；助手只检查文件是否存在，不展示内容或覆盖现有文件。

1. 新装只创建空文件或占位内容。先限制访问，再由用户用本机编辑器填入 `OPENAI_API_KEY` 和独立的 `OA_GW_LOCAL_TOKEN`。用户可在不被助手采集输出的终端运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成令牌。两项都不发聊天、不放命令行、不写日志或 Git。本机令牌至少 24 字符。
2. **Windows：**通过属性 → 安全 → 高级检查 NTFS ACL；如果继承允许其他普通用户读取，在这个新文件上收紧，仅授予运行网关的当前用户和必要的系统/管理员主体访问。用 `icacls "$env:USERPROFILE\.workbuddy\oa-gateway-v2.env"` 核对。Node 的 `mode: 0o600` / Git Bash 的 `chmod` **不是 Windows ACL 已收紧的证据**。
3. **macOS/Linux：**创建前先设 `umask 077`；用 `chmod 600 ~/.workbuddy/oa-gateway-v2.env` 和 `ls -l` 核对。请勿覆盖已有文件或将配置放在共享目录。
4. **已有真 Key 的旧版迁移：**只有明确授权时才运行 `node oa-gateway.js --init-config MODEL_ID`，它只从精确匹配的本机模型条目复制 Key，不覆盖目标。Windows 先确保目标父目录继承的 ACL 不会暴露新文件；不能确认就用上述手动流程。迁移后让用户把目标旧模型条目的 Key 改成本机令牌，不批量改其他条目。

按需填 `OA_GW_PORT=8790`、`OA_GW_NO_PROXY=1`（直连）或 `OA_GW_PROXY_PORT`（HTTP CONNECT 端口）。推理摘要默认关闭，用 `OA_GW_REASONING_SUMMARY=auto` 启用；上游不保证每次返回摘要。

## 3. 校验、启动并做零费用验收

在解压目录执行。`8790` 是示例，换成实际选定的端口，最后一条另开终端执行。也可把端口存进 env，不传 `--port`。使用非默认配置文件时，各步骤带同一个 `--config-file`。

```sh
node oa-gateway.js --port 8790 --check-config
node oa-gateway.js --port 8790
node oa-gateway.js --port 8790 --verify-local
```

配置须显示 `config: ok`；启动后应看到实际监听地址；本地验收须显示 `ok: true`、`authStatus: 401`、`upstreamAttempts: 0`。失败时不要继续带令牌测试。Windows 也可运行 `Start-Gateway.cmd 8790`；不传端口就用配置值。后台常驻或开机自启须单独获准，只托管本项目进程。

## 4. 只添加所选模型

推荐用 WorkBuddy 的「设置 → 模型」。地址填 `http://127.0.0.1:实际端口/v1`，模型 ID 用本人账号可用的上游 ID，API Key 由用户在客户端填写 `OA_GW_LOCAL_TOKEN`。「测试连接」可能发真实请求：未授权就不要点。

若用户要求修改 `~/.workbuddy/models.json`，保留现有数组或对象格式、其他条目与字段，只改获准条目并验证合法 JSON，不输出完整文件。

```json
{
  "id": "gpt-6.2-sol",
  "name": "GPT-6.2 Sol",
  "vendor": "OpenAI",
  "url": "http://127.0.0.1:8790/v1",
  "apiKey": "仅在本机填写 OA_GW_LOCAL_TOKEN",
  "supportsToolCall": true,
  "supportsImages": true,
  "supportsReasoning": true,
  "useCustomProtocol": false
}
```

按上游规格填能力、思考档位和上下文上限，不给全部模型套固定参数。旁路验证要保留同名旧条目时，可用 `gpt-6.2-sol@gateway-v2`；网关会去掉后缀后再发给上游。

## 5. 真实验收（可选，会产生用量）

只检查用户选择的模型。建议每个目标先做一次 `text`，只在一个支持工具的目标上按需做 `tool` 和 `stream`。选一个模型、三种都测，就发 **3 次**请求。未经授权不扩大范围，不自动重试。

```sh
node oa-gateway.js --port 8790 --verify-live text gpt-6.2-sol
node oa-gateway.js --port 8790 --verify-live tool gpt-6.2-sol
node oa-gateway.js --port 8790 --verify-live stream gpt-6.2-sol
```

`text` 检查非空正文与正常结束；`tool` 验证指定的空参数测试工具，不执行工具；`stream` 检查正文增量、正常结束与 `[DONE]`。`summaryReceived: false` 不代表流式失败。CLI 不回显密钥或原始响应。要验证思考区，可先用 [8789 离线探针](README.zh-CN.md#-推理摘要)，最后由用户在 WorkBuddy 确认。

## 6. 汇报与排查

| 现象 | 怎么处理 |
|---|---|
| `wrong_gateway_version` / `health_failed` | 查端口、版本和进程归属；可换空闲端口测试。 |
| `local_auth_not_verified` / HTTP 401 | 区分本机令牌不匹配和上游真 Key 失效；不回显凭据。 |
| HTTP 400 / 404 | 查模型 ID、账号权限、支持的参数；不擅自改正式配置。 |
| 代理/TLS 错误 | 核对实际 HTTP CONNECT 地址或是否应直连，不关闭证书验证。 |
| `missing_complete_text` / `incomplete_stream` | 不能算成功；检查上游截断或流异常，付费重试前确认。 |

汇报实际地址、通过或失败的模型与模式、真实请求尝试数，并标出未验证项。**本地通过 ≠ OpenAI 已测通 ≠ WorkBuddy 客户端已测通。**
