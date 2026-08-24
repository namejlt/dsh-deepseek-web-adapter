# 多站点 Web Provider 适配设计

**日期：** 2026-08-24  
**状态：** 已获方案确认，待书面规格审阅  
**范围：** 在保持现有 DeepSeek Web 适配行为和 OpenAI 兼容 API 不变的前提下，新增 ChatGPT Web 与 Qwen Web provider。

## 1. 背景

当前插件把 DeepSeek 网页端封装为 OpenAI 兼容的 `/v1/models` 与 `/v1/chat/completions` 服务。网关层已经承载了 SSE、会话恢复、账号池、工具调用提示协议和错误映射；浏览器 driver 则仍包含大量 DeepSeek 专属的 URL、DOM、登录、模型模式和回复提取逻辑。

本次要支持 ChatGPT Web 与 Qwen Web。复制两套网关会造成协议、工具解析和会话逻辑分叉；一次性重命名并拆分全部核心文件则会放大 DeepSeek 回归风险。因此采用“保留外部入口、内部引入 provider adapter”的渐进重构。

## 2. 已确认范围

### 2.1 首版支持

| Provider | 模型 ID | 能力 |
| --- | --- | --- |
| DeepSeek | 既有 `deepseek-*` | 保持原有能力和默认行为 |
| ChatGPT Web | `chatgpt-auto`、`chatgpt-thinking` | 文本、代码块、基础 SSE、既有文本工具调用协议、单账号 |
| Qwen Web | `qwen-chat`、`qwen-thinking`、`qwen-search` | 文本、代码块、基础 SSE、既有文本工具调用协议、单账号；thinking/search 尽力切换 |

### 2.2 明确不做

- 文件上传、图像或其他多模态输入。
- ChatGPT/Qwen 网页原生工具卡片、trace、artifact、web-dev iframe 的完整语义。
- CAPTCHA、Cloudflare、Turnstile、设备证明或其他挑战的自动求解/绕过。
- 首版多账号的完整自动轮换保证；现有账号池结构保留并按 provider 隔离，为后续扩展预留接口。
- DSH 主程序和其设置 UI 的修改。

## 3. 架构

### 3.1 兼容边界

- `lib/index.js` 保持插件生命周期和启动入口职责。
- `resources/dsweb-gateway.js` 保留文件名、监听端口、`/v1/models`、`/v1/chat/completions` 和已有管理路由，避免现有用户配置失效。
- `resources/driver.js` 保留 RPC、Chrome/CDP、页面/频道和流控制骨架。
- DSH 只看到稳定的 OpenAI 兼容模型列表和 completions API，不需要感知 provider。

### 3.2 新模块

```text
resources/
  dsweb-gateway.js              # 现有通用网关；使用 registry 选择模型/provider
  driver.js                     # 现有通用浏览器和流控制；委托 provider adapter
  provider-registry.js          # provider 元数据、模型索引、模型解析
  providers/
    deepseek.js                 # 当前 DeepSeek 特定规则的兼容 adapter
    chatgpt.js                  # ChatGPT DOM、登录/challenge、提取规则
    qwen.js                     # Qwen DOM、模式、提取规则
```

`provider-registry.js` 是 gateway 与 driver 共享的唯一模型/provider 真相来源。每个公开模型都包含 `providerId`、显示名称和 provider 局部 `mode` 配置。模型 ID 的 provider 前缀不可省略，避免跨站语义混淆。

### 3.3 Provider Adapter 契约

每个 adapter 以纯数据和纯 DOM expression builder 为主，至少提供：

- 基础元数据：`id`、`label`、`siteUrl`、`defaultProfilePrefix`、`models`。
- 页面交互：`ensureReady`、`findComposer`、`fillPrompt`、`clickSend`、`detectGenerating`、`extractLatest`、`openNewChat`。
- 状态识别：`detectLogin`、`detectChallenge`、`detectLimit`。
- 可选能力：`applyMode`，仅用于 DeepSeek 既有模式和 Qwen 的 thinking/search；ChatGPT 的 `thinking` 在页面不存在可靠开关时退化为 auto，并在健康/日志中说明。

adapter 只能描述目标页面与返回标准化状态，不能复制 SSE、会话、账号调度、工具调用解析或 HTTP 协议实现。

## 4. Provider 行为

### 4.1 DeepSeek

现有 DeepSeek DOM 规则被封装为 `deepseek` adapter，模型 ID、既有模式、校准回放和请求语义保持兼容。此迁移本身必须由回归测试覆盖，不能借机改变既有对外行为。

### 4.2 ChatGPT Web

- 站点入口为 `https://chatgpt.com/`。
- composer 使用可见 `textarea`，发送优先取所属 `form` 中可用的 submit/send button，再回退到 form 中最后一个可见可点击按钮。
- 回复提取选择最新 assistant 内容，包含普通文本和 `pre code`；选择器避免绑定易变 CSS class。
- 登录重定向、登录页面或 challenge/Turnstile 信号分别标准化为 `login_required` 与 `challenge_required`；这两类错误绝不能归类为 DOM 改版。
- `chatgpt-auto` 是首版的稳定文本通道。`chatgpt-thinking` 只在检测到可靠的思考模式控件时启用；否则发送同一文本请求并记录 capability fallback，不伪造模式已切换。

### 4.3 Qwen Web

- 站点入口为 `https://chat.qwen.ai/`。
- composer 优先使用 `.message-input-textarea`、`.qwen-chat-v2-input-textarea`；发送优先使用 `.chat-prompt-send-button .send-button[aria-label="Send"]`。
- 流式结束优先以 stop button 消失和最新回复稳定为依据。
- 回复提取包含标准 Markdown、代码块和可见文本；artifact/iframe 仅转为可见文本或链接提示，不解释为结构化产物。
- `qwen-thinking` 与 `qwen-search` 仅在页面存在对应可识别开关时切换；无法识别时返回明确的 `mode_unavailable`，不静默发送为错误模式。

## 5. 会话、账号和登录

- 会话 key、频道 key 与浏览器 profile key 都包含 provider，禁止跨站复用同一 cookie/profile 目录。
- 默认 profile 名称为 `deepseek-default`、`chatgpt-default`、`qwen-default`；兼容旧 DeepSeek `default` profile 的迁移/回退路径。
- `/login` 与 `/login-status` 接受可选 `provider` 参数；省略时默认 DeepSeek，以保持现有入口。
- `/health`、配置和管理输出包含每个 provider 的可用性、已选模型和登录/挑战状态。
- 挑战被识别后，网关应返回 OpenAI 风格的 provider 错误，并指向对应 `/login?provider=...` 手动完成登录；不得自动规避挑战。

## 6. 工具调用、错误与流式输出

- 现有“提示词要求文本工具调用 + `parseToolCalls` 归一化”的协议保持唯一实现，供所有 provider 共用。
- provider adapter 只返回响应文本、thinking 文本（若可用）和标准化错误信号；gateway 继续负责 SSE chunk、`tool_calls` 和非流式 JSON。
- 错误归一化至少区分：`login_required`、`challenge_required`、`rate_limited`、`mode_unavailable`、`provider_dom_changed`、`provider_unavailable`。
- 模型不存在仍由 gateway 在调用浏览器前返回 OpenAI 风格 `model_not_found`。

## 7. 测试策略

### 7.1 离线单元与契约测试

- registry：模型列表、模型到 provider 的解析、未知模型拒绝、provider 默认 profile 生成。
- adapters：ChatGPT/Qwen 的输入/发送/回复/登录/challenge/限流/模式状态，用 fake DOM 或 expression 断言覆盖主路径和回退路径。
- driver：provider 维度的页面 key 与 profile 隔离，DeepSeek 兼容 adapter 仍选中原有规则。
- gateway：`/v1/models` 返回所有 provider 模型；请求根据模型路由；provider 错误转换为正确的 OpenAI 错误；工具调用和流式/非流式契约保持可用。

### 7.2 完整离线回归

执行仓库所有 `tests/test-*.js`。新增测试必须先以缺少 registry/adapter/路由实现的原因失败，再写最小实现使其通过。

### 7.3 手工验证

在用户已完成各站手动登录的 profile 上，分别发送短文本、代码生成、tool-call 提示请求；验证流式文本、结束判定、模型列表、provider 隔离、登录失效和 ChatGPT challenge 提示。手工登录与挑战交互不自动化。

## 8. 文档与注释

- 更新 `README.md`、`README.en.md` 与 `docs/user-guide.md`，说明 provider 模型、保守范围、独立登录/profile、风险和手工验证路径。
- 更新 `docs/publishing.md` 的完整测试命令与发布检查项。
- 在 registry、adapter 契约、profile 隔离和错误归一化处添加简洁注释，解释不变式与页面选择器回退原因；不在显而易见的语句上重复注释。

## 9. 验收标准

1. 现有 DeepSeek 模型和 API 请求保持兼容，现有离线测试继续通过。
2. `/v1/models` 暴露 2 个 ChatGPT 和 3 个 Qwen 的前缀化模型 ID。
3. ChatGPT/Qwen 请求由对应 provider adapter 处理，cookie/profile 与 DeepSeek 及彼此隔离。
4. 登录、挑战、限流、DOM 变化和不可用模式返回可区分的 OpenAI 风格错误。
5. 所有新增行为由离线自动化测试覆盖；在具备授权登录态时，手工清单可验证基础文本和 SSE 流。
