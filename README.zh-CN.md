# 🔌 在 WorkBuddy 里使用 OpenAI API

**简体中文** · [English](README.md) · [📦 下载 v2.1.1](https://github.com/Angle084/workbuddy-openai-api/releases/tag/v2.1.1) · [🤖 AI 安装手册](AI-SETUP.zh-CN.md)

用**你自己的 OpenAI API Key** 接入 WorkBuddy。通过零依赖的本地网关，保留流式回复、工具调用和可选的推理摘要。

**Node.js 22+ · 仅本机监听 · MIT · 非官方**

```text
WorkBuddy ── Chat Completions ──► 本地网关 ── Responses ──► OpenAI
          ◄── 正文 / 工具调用 / 可选的推理摘要 ◄─────────────────
```

| 📦 第一次安装 | 🧪 不用 Key，先看效果 | 🔄 从 v2.1.0 升级 |
|---|---|---|
| 下载 Release ZIP，解压后打开 `START-HERE.txt`。 | 运行 `node oa-gateway.js --probe-summary`，在 `8789` 测界面，不请求上游。 | 沿用 env、模型条目和令牌。停掉你自己的旧实例后再换，或先用空闲端口试跑。 |

## 它解决什么

WorkBuddy 发 Chat Completions 请求。部分模型和参数组合（例如工具调用加推理选项）在 `/v1/chat/completions` 和 `/v1/responses` 上的行为可能不同。网关把请求转成 Responses，再把结果转回来。**不是**说 GPT-6 全系只支持 Responses：[OpenAI 官方列出 GPT-6.2 Astra/Sol 支持两种端点](https://help.openai.com/en/articles/9624314-model-release-notes)。

- 正文用 SSE 流式返回；工具参数校验完整后再交给客户端。
- 在上游模型支持的前提下，转换并行调用、多轮工具结果、图片输入和结构化输出。
- OpenAI 真 Key 不进 WorkBuddy 模型条目；本机请求用独立随机令牌鉴权。
- 分阶段报告连接故障，保留上游 HTTP 错误；客户端断开时取消上游请求。

## 🚀 快速开始

1. 准备 **Node.js 22+**。[下载 Release ZIP](https://github.com/Angle084/workbuddy-openai-api/releases/latest)并解压，无需 `npm install`。想让助手辅助配置，见 [AI 安装手册](AI-SETUP.zh-CN.md)。
2. 在本机创建 `~/.workbuddy/oa-gateway-v2.env`（[权限和迁移说明](AI-SETUP.zh-CN.md#2-准备私有配置)）。**自己用本地编辑器填真 Key**，不发到聊天、不写进命令行、不提交 Git。本机令牌也不要公开。

   ```ini
   OPENAI_API_KEY=在本机填写真实密钥
   OA_GW_LOCAL_TOKEN=在本机填写独立随机令牌
   ```

   在**不会被助手采集输出的本地终端**生成令牌：`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`。两种凭据必须不同。可以直连时，在 env 加 `OA_GW_NO_PROXY=1`；需要代理时，填写已确认支持 HTTP CONNECT 的端口（默认 `7897`）。
3. 在解压目录运行以下命令。启动后保持窗口开着，最后一条在另一个终端运行。端口已用就选空闲端口，在各步骤保持一致。Windows 也可用 `Start-Gateway.cmd`，不传端口就沿用已配置的端口。

   ```sh
   node oa-gateway.js --check-config
   node oa-gateway.js
   node oa-gateway.js --verify-local
   ```

4. 在 WorkBuddy 新增自定义模型：地址 `http://127.0.0.1:8788/v1`（如改过端口就换实际值），模型 ID 填上游模型（例如 `gpt-6.2-sol`），API Key 栏填 **`OA_GW_LOCAL_TOKEN`**。按模型能力启用工具调用、图片或思考模式。参见[模型条目示例](AI-SETUP.zh-CN.md#4-只添加所选模型)。

## ✅ 验收

`--verify-local` 检查网关版本以及无令牌请求是否返回 `401`，**不请求 OpenAI**。下面是可选的真实验收，每条向指定模型发送**一次可能计费的请求**；只运行需要的项目。它们分别要求收到非空正文、预期工具调用或完整 SSE 流，不打印凭据和原始响应。

```sh
node oa-gateway.js --verify-live text gpt-6.2-sol
node oa-gateway.js --verify-live tool gpt-6.2-sol
node oa-gateway.js --verify-live stream gpt-6.2-sol
```

如果用 `--port 8790` 或 `Start-Gateway.cmd 8790` 启动，验收也加相同的 `--port 8790`。最后在 WorkBuddy 发一条消息，命令行测试不代替客户端验收。

## 💭 推理摘要

设 `OA_GW_REASONING_SUMMARY=auto`，Windows 也可运行 `Start-Gateway.cmd summary`。**只显示上游发来的官方摘要，不是原始思维链**。模型不返回摘要时，思考区可以为空。[OpenAI 官方说明摘要不另收费](https://openai.com/index/new-tools-and-features-in-the-responses-api/)；真实模型的使用量（含推理 token）仍按适用价格计费。

想零成本看界面：运行 `node oa-gateway.js --probe-summary`，模型填 `gateway-thinking-probe`、地址 `http://127.0.0.1:8789/v1`、API Key 填**公开假令牌** `local-summary-probe-only`，开启思考模式后发一句话。探针使用合成数据，不读真实凭据、不替换 `8788`，用完按 Ctrl+C。

<details>
<summary>⚙️ 配置与开发</summary>

配置含网络、超时、并发、字节限制、推理档位和日志等选项，见 [完整参数表](README.md#-reasoning-summaries) 下方的 Configuration and developer notes。`--config-file PATH` 可选择其它 env 文件。`--init-config MODEL_ID` **仅用于旧配置迁移**：从精确匹配的本机模型条目复制密钥，不覆盖目标；权限要求见安装手册。

运行 `npm test` 或 `node --test oa-gateway.test.js`（Node.js 22+，本地 TLS 测试另需 OpenSSL CLI）。测试只连本机模拟服务，不调用 OpenAI。项目不是公网中转、账号池或计费看板，不适配音频/视频输入。

</details>

[MIT 许可证](LICENSE)。非 OpenAI 或 WorkBuddy 官方项目。网关在本机运行；发起真实 API 请求时，提示词和工具结果仍会发送到配置的上游。
