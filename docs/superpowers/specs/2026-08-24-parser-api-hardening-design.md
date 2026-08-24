# 解析器与 OpenAI API 契约加固设计

**日期：** 2026-08-24
**状态：** 已获方案确认，待书面规格审阅
**范围：** `resources/driver.js`、`resources/dsweb-gateway.js` 及现有离线回归测试。

## 1. 背景与问题

插件将 DeepSeek 网页端的文本回复适配为 OpenAI `chat.completions` API。网页端没有原生 function calling，因此 driver 必须从文本中恢复工具调用，再由 gateway 转成 OpenAI `tool_calls` SSE/JSON 响应。

当前 JSON 工具调用经过统一授权逻辑，但两条兼容路径绕过了该防线：

1. XML `<invoke name="…">` 恢复逻辑会直接输出调用；
2. fenced Python 风格 `tool_name(arg="…")` 恢复逻辑会直接输出调用。

此外，gateway 的真流式逻辑会在第一个非完整工具标记分片到达时立即输出文本。例如首分片为 `` ` `` 或 `tool_` 时尚无法判断为工具调用，后续分片补全为 `tool_call` 后，已发出的文本不能撤回。

最后，请求层会把未知模型回退为默认模型，且无效 `messages` 在深层流程中才报错；这不符合 OpenAI 兼容 API 的“早校验、明确错误”预期。

## 2. 目标

1. 所有工具调用输入格式都执行同一套授权与参数规范化规则。
2. 工具调用流式分片不向客户端泄漏 `content` 残片。
3. 对不合法的 `model` 和 `messages` 在浏览器、账号池和 SSE 初始化前返回可预测的 OpenAI 风格 JSON 错误。
4. 保留现有兼容格式和降级行为：已授权 JSON/XML/Python 调用、参数别名、schema 推断、解析误判时的正文完整回退。
5. 用离线回归测试锁定每个修复场景。

## 3. 非目标

- 不重构浏览器 CDP/页面选择器、账号池、会话迁移或模型 pill 配置。
- 不实现 JSON Schema 的完整验证器；DSH 仍是工具参数的最终执行方。
- 不改变当前“一次响应只转发一个工具调用”的提示工程与解析语义。
- 不增加外部运行时依赖。

## 4. 设计

### 4.1 统一工具调用归一化与授权

`parseToolCalls(text, tools)` 保留为 driver 唯一的工具解析出口。

- JSON、XML 和 Python 格式均构造成同一内部候选结构：`{ name, arguments }`。
- 所有候选均通过现有 `pushCall()` 路径：
  - 若名称存在于请求中的 `tools`，则采用该名称；
  - 若名称缺失或未授权，只能在 schema 参数唯一匹配时推断名称；
  - 无法证明为已授权工具时丢弃该候选；
  - 参数继续应用现有别名和数组标量规范化。
- XML 解析保留多 `<invoke>` 扫描能力，但每一项独立通过上述路径。
- Python 格式也只能输出已授权工具或唯一 schema 推断的工具；不能再把任意函数名原样转发。

**安全不变量：** `parseToolCalls` 的任何非空返回都只能包含请求 `tools` 中的名称。

### 4.2 工具调用前缀缓冲

在 `handleChatCompletion()` 的 SSE 增量分支引入一个纯函数，判断当前缓冲是否仍可能是受支持工具格式的“未完成前缀”。该判断覆盖：

- fenced 形式：`` ` ``、`` `` ``、`` ``` ``、`` ```tool_call ``、`` ```json ``；
- 标签形式：`<`、`<tool`、`<tool_call`、`<tool_calls`、`<invoke`；
- 裸标记：`t` 到 `tool_call`；
- JSON / 数组形式：`{`、`[`，以及尚不足以判断 `name/args` 的短 JSON 开头。

策略：

1. 若分片组成了明确工具调用，立即转为 `silent`，不发送任何 `content`；
2. 若仍可能是未完成的工具前缀，继续缓冲，不立刻输出；
3. 一旦不再可能是工具前缀，转为 `stream`，立即一次性释放缓冲，然后继续逐分片输出；
4. 缓冲超过严格上限仍无法判定时，转为 `stream`，避免普通 JSON 或文本长期阻塞；
5. 终态没有有效 `toolCalls` 时，沿用既有完整正文回退机制，确保误判不会丢字。

这会给少量以 Markdown/JSON/标签开头的普通回复带来极短的首包延迟，但避免了 OpenAI `content` 与 `tool_calls` 同轮污染。

### 4.3 OpenAI 请求早校验

在 `handleChatCompletion()` 入口处、任何 SSE 头写入或 driver RPC 之前校验：

| 条件 | 响应 |
|---|---|
| `payload` 不是对象 | HTTP 400，`invalid_request_error` |
| `model` 缺失或不是已注册模型 | HTTP 404，`invalid_request_error`，代码 `model_not_found` |
| `messages` 不是非空数组 | HTTP 400，`invalid_request_error`，代码 `invalid_messages` |
| 消息项不是对象，或 `role` 缺失/不是字符串 | HTTP 400，`invalid_request_error`，代码 `invalid_messages` |

失败时始终返回 JSON 错误对象，包含 `error.message`、`error.type` 和 `error.code`；无论请求中 `stream` 取何值都不建立 SSE 响应。这符合“请求无效则尚未开始流”的 API 边界。

## 5. 兼容性与风险控制

- 已授权的 JSON、XML 和 Python 调用保持可用。
- 未授权 XML/Python 调用会被拒绝，符合已有 JSON 分支的安全策略。
- 参数字段不做严格 required 校验，避免错误拒绝使用 `additionalProperties` 或 DSH 自行处理的复杂工具 schema。
- 流式缓冲只影响工具格式前缀，普通自然语言首分片保持即时输出。
- 不改变 `stream: false` 的成功响应形状；只使其无效请求更早地返回 HTTP 错误。

## 6. 测试策略

### 6.1 解析器回归

在 `tests/test-parser-all.js` 中添加：

- 已授权 XML `<invoke>` 能解析并规范化参数；
- 未授权 XML `<invoke>` 返回空列表；
- 已授权 Python 函数调用能解析；
- 未授权 Python 函数调用返回空列表；
- XML/Python 的缺名候选仅在 schema 唯一匹配时恢复。

### 6.2 Gateway 流式与 API 回归

在现有 gateway mock 测试中添加：

- 工具标记跨分片（如 `` ` `` + `` ``tool_call...``）时，SSE 中没有 `content`，仅有 `tool_calls`；
- 普通 Markdown 代码块与普通 JSON 前缀会在不再可能是工具格式后完整输出；
- 未知模型返回 HTTP 404 JSON，未触发 `streamAsk`；
- 空/非法 messages 返回 HTTP 400 JSON，未触发 `streamAsk`；
- 有效非流式请求仍返回现有 `chat.completion` JSON。

### 6.3 完整回归

执行所有 `tests/test-*.js`，并检查 Git diff 只包含预期代码、测试和设计/计划文档。

## 7. 验收标准

- `parseToolCalls()` 不会返回未在 `tools` 中授权的 XML/Python 工具名称。
- 被拆分的工具调用前缀不会以 SSE `delta.content` 发送。
- 非法模型与非法 messages 不会启动 driver，也不会生成 SSE 响应。
- 现有所有离线测试与新增测试均通过。
