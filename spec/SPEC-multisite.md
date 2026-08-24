# SPEC-multisite — 增加 ChatGPT Web 与 Qwen Web 转 API 支持的扩展计划

> 状态：规划中（本文件仅输出分析与实施计划，不改动现有代码）
> 背景：当前插件已实现 **DeepSeek Web → OpenAI 兼容 API**。目标是在尽量复用现有网关与会话/工具/账号池能力的前提下，新增 **ChatGPT Web → API** 与 **Qwen Web → API** 支持。
> 结论先行：**推荐把当前项目从“单站点 DeepSeek 适配器”重构为“多站点 Web-to-OpenAI 网关”**，保持 DSH 侧协议不变，把页面差异下沉到 provider/site adapter 层。

---

## 0. 调研结论摘要

### 0.1 DSH / deepseek-harness 插件开发侧

根据仓库内文档与实现：

- DSH 的 `pi-ai` 层对插件的核心要求非常简单：
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - SSE 流式输出
- 这意味着：**DSH 不关心底层是 DeepSeek Web、ChatGPT Web 还是 Qwen Web，只关心你是否提供 OpenAI 兼容接口。**
- 当前项目已经具备最关键的宿主能力：
  - `lib/index.js` 负责 Cordis 生命周期
  - `resources/dsweb-gateway.js` 负责 OpenAI 协议、SSE、会话、账号池、错误映射
  - `resources/driver.js` 负责浏览器自动化、DOM 提取、登录、限流检测

因此，新增 ChatGPT/Qwen 支持时，**没有必要重做 DSH 插件壳**；最合理的路径是保留现有插件外壳与 OpenAI 网关，扩展浏览器侧 provider 抽象。

### 0.2 ChatGPT Web 页面结构侧

公开资料与社区桥接项目显示：

- 当前域名应优先视为 `https://chatgpt.com`
- 选择器不宜依赖类名，应优先使用：
  - `textarea`
  - composer 所在 `form`
  - form 内最后一个可用发送按钮
- 比较稳妥的策略：
  - 输入框：composer 范围内 `textarea`
  - 发送：同 form 内的 enabled submit button，找不到时回退到最后一个可见 button
  - 读取输出：优先取最新 assistant 渲染内容，而不是依赖某个固定外层 class
- 重要风险不是 DOM，而是：
  - 登录态和会话校验
  - Cloudflare / Turnstile / challenge
  - proof / sentinel / device-id 一类前置校验
  - 页面结构变更频率高

结论：**ChatGPT Web 支持可做，但应把“认证/挑战失败”作为一等错误类型处理，不能假定是普通 DOM 失配。**

### 0.3 Qwen Web 页面结构侧

公开 bundle/CSS 可识别出一批相对稳定的结构：

- 入口：`https://chat.qwen.ai/`
- 输入框：
  - `.message-input-textarea`
  - `.qwen-chat-v2-input-textarea`
- 发送/停止按钮：
  - `.chat-prompt-send-button .send-button[aria-label="Send"]`
  - `.chat-prompt-send-button .stop-button[aria-label="Stop"]`
- 代码块：
  - `.qwen-markdown-code`
  - `.qwen-markdown-code-body`
  - `.qwen-markdown-code-body-streaming`
- 产物/iframe 类输出：
  - `.artifact-container`
  - `.artifact-iframe-render`
- 公开 bundle 暗示有 thinking / search / deep research / artifact / web dev 等模式能力

结论：**Qwen Web 比 ChatGPT Web 更适合作为第二个 provider 落地目标**，因为它至少有一批可见的、产品自有的稳定 class，可直接用于第一版适配。

---

## 1. 现状与问题定义

### 1.1 当前实现的强项

现有项目已经具备下面这些高价值能力：

1. **OpenAI 兼容网关已成熟**
   - 模型列表
   - `chat.completions` 流式/非流式
   - SSE chunk 输出
   - `tool_calls` 转译
   - 错误映射

2. **会话与恢复机制已成熟**
   - `first / delta / recovery` 三种上下文模式
   - driver 重启 / profile 切换后可恢复对话

3. **工具调用不是依赖网页原生 function calling，而是提示词 + 解析器实现**
   - 这点对 ChatGPT Web/Qwen Web 是可迁移的
   - 也是本项目最有复用价值的资产之一

4. **多账号与登录管理框架已存在**
   - account pool
   - cooling / probing / needs_login / disabled
   - 自动登录入口

### 1.2 当前实现的限制

现状仍然是**DeepSeek 定制实现**，主要限制在于：

1. `resources/dsweb-gateway.js` 的模型定义、文案、路由命名都绑定 DeepSeek
2. `resources/driver.js` 中的 DOM 表达式、站点 URL、登录检测、模式切换都绑定 DeepSeek 页面
3. 账号池虽然抽象在网关层，但 profile 与浏览器通道组织仍然默认围绕单一站点
4. 测试大多围绕 DeepSeek 模式与解析器，没有 provider adapter 的抽象测试层

### 1.3 新目标

新增两个 provider：

- `chatgpt-web`
- `qwen-web`

并实现：

1. 不破坏现有 DeepSeek 支持
2. 不改变 DSH 侧 OpenAI provider 使用方式
3. 允许未来继续接更多 Web provider，而不是每加一个站点就复制一份项目

---

## 2. 目标与非目标

### 2.1 目标

1. **多 provider 架构**：DeepSeek / ChatGPT / Qwen 共享同一网关内核
2. **统一 OpenAI 兼容出口**：对 DSH 保持 `/v1/models` 与 `/v1/chat/completions`
3. **统一会话/工具/账号池**：现有能力最大化复用
4. **站点差异下沉到 adapter**：URL、选择器、模式开关、登录检测、限流信号、输出提取都 provider 化
5. **先保守支持文本与代码输出，再逐步扩展高级能力**

### 2.2 非目标

1. 第一阶段**不追求原生支持网页内全部高级能力**：
   - ChatGPT 的原生工具卡片
   - Qwen 的 artifact / web-dev iframe 完整语义
   - 图片上传 / 多模态输入
2. 第一阶段**不做验证码/挑战自动求解**
3. 第一阶段**不保证 provider 间完全统一的模型能力矩阵**
4. 第一阶段**不重写 DSH 主程序或其设置界面**

---

## 3. 核心架构建议

### 3.1 推荐方向：从 dsweb 专用网关升级为多站点网关

建议把当前结构：

```text
lib/index.js
resources/dsweb-gateway.js
resources/driver.js
```

重构为近似下面的结构：

```text
lib/index.js
resources/
  gateway.js                 # 原 dsweb-gateway.js 的通用内核
  driver-core.js             # 原 driver.js 的浏览器/CDP/RPC/流控制核心
  providers/
    deepseek.js              # DeepSeek adapter
    chatgpt.js               # ChatGPT adapter
    qwen.js                  # Qwen adapter
  provider-registry.js       # provider 元数据、模型映射、默认配置
  runtime/
```

如果希望控制改动风险，也可以分两步：

- 第一步：仍保留文件名 `dsweb-gateway.js` / `driver.js`
- 第二步：在内部抽出 provider adapter，不先改对外文件名

这是更稳妥的落地方式。

### 3.2 推荐抽象边界

#### Host 层

继续由 `lib/index.js` 负责：

- 插件启动/停止
- 启动本地网关
- 运行时目录初始化

这一层几乎不需要大改。

#### Gateway 层

保留现有职责：

- OpenAI 协议适配
- 模型列表
- chat completions
- SSE
- session registry
- account pool
- tool-calling prompt 组装
- 错误映射

新增职责：

- provider 注册与选择
- model id 到 provider/modelConfig 的映射
- 登录/配置/健康信息中增加 provider 维度

#### Driver Core 层

保留通用职责：

- Chrome 启动与 CDP 通信
- page / channel 生命周期
- RPC 协议
- 通用流控制
- 通用输入/等待/稳定判定框架

移出 provider-specific 逻辑：

- URL
- 页面 readiness 判定
- 输入框/发送按钮选择器
- 模式切换逻辑
- 回复提取逻辑
- thinking / search / quota / captcha / login 识别

#### Provider Adapter 层

每个 adapter 实现一组统一接口，例如：

```javascript
{
  id: 'chatgpt',
  label: 'ChatGPT Web',
  baseUrl: 'https://chatgpt.com/',
  models: {...},
  detectLogin(pageCtx) {},
  ensureReady(pageCtx) {},
  findComposer(pageCtx) {},
  fillPrompt(pageCtx, text) {},
  clickSend(pageCtx) {},
  detectGenerating(pageCtx) {},
  extractLatest(pageCtx) {},
  extractThinking(pageCtx) {},
  detectLimit(text, pageCtx) {},
  applyMode(pageCtx, modelConfig) {},
  openNewChat(pageCtx) {},
}
```

重点不是接口名字，而是：**把现有 driver 中所有“对 DeepSeek 页面有认知”的代码挪到 provider adapter 里。**

---

## 4. provider 设计方案

### 4.1 Provider Registry

建议新增统一注册表：

```javascript
const PROVIDERS = {
  deepseek: {...},
  chatgpt: {...},
  qwen: {...},
};
```

每个 provider 至少包含：

- `id`
- `label`
- `siteUrl`
- `loginUrl`
- `defaultProfilePrefix`
- `models`
- `adapter`

### 4.2 模型 ID 设计

建议不要复用 DeepSeek 风格去硬套别家模型，而是显式分 provider 前缀。

示例：

```text
deepseek-chat
deepseek-reasoner
chatgpt-auto
chatgpt-thinking
qwen-chat
qwen-thinking
qwen-search
```

理由：

1. DSH 侧模型列表需要稳定且可辨认
2. 不同 provider 的“思考”“搜索”能力语义不完全一致
3. 以后扩展更多 provider 时不会冲突

### 4.3 账号与 profile 命名

建议从当前：

```text
profiles/default
profiles/acc2
```

升级为：

```text
profiles/deepseek-default
profiles/chatgpt-default
profiles/qwen-default
profiles/chatgpt-acc2
profiles/qwen-acc2
```

这样可以避免不同 provider 共享同一个 cookie 目录。

### 4.4 登录入口设计

建议登录接口也支持 provider 参数，例如：

```text
GET /login?provider=deepseek
GET /login?provider=chatgpt
GET /login?provider=qwen
```

以及：

```text
GET /login-status?provider=chatgpt
```

如果未来保留多账号，则再附加 `account=` 参数。

---

## 5. ChatGPT Web 适配计划

### 5.1 第一阶段目标

第一阶段只支持：

- 文本对话
- 代码块提取
- tool-call 文本协议复用
- 单账号可用
- 基础流式输出

不在第一阶段承诺：

- 原生附件上传
- 原生工具 trace 提取
- 图像/多模态
- 深度 account pool 稳定支持

### 5.2 页面交互策略

建议采用“网络优先，DOM 回退”的双层策略：

1. **优先方案**：若能稳定读到 conversation 流事件，则以事件流为主
2. **回退方案**：DOM 驱动
   - 找 `textarea`
   - 定位最近 `form`
   - 点击 form 内 send button
   - 从最新 assistant 区块提取内容

### 5.3 关键适配点

1. **ready 检测**
   - 页面可交互
   - 存在可见 textarea
   - 非 challenge / 非登录跳转页面

2. **登录态识别**
   - 是否跳转到登录页
   - 是否出现 challenge / turnstile
   - 是否存在受限状态提示

3. **发送状态识别**
   - send button → stop/cancel 状态转换
   - 或最新 assistant 文本仍在变化

4. **回复提取**
   - 最新 assistant 内容
   - 代码块 `pre code`
   - 普通 markdown 文本

5. **错误分类**
   - login required
   - challenge required
   - DOM changed
   - rate limited / temporarily unavailable

### 5.4 ChatGPT 特有风险

1. 页面结构变更频繁
2. Cloudflare/Turnstile 更重
3. 可能存在设备标识、前置校验、匿名/登录双路径差异
4. 纯 DOM 抓取对流式稳定性要求更高

### 5.5 对应设计要求

- ChatGPT adapter 需要有独立错误码枚举
- 网关要把这些错误翻译成统一 OpenAI 风格错误
- 登录失败与 challenge 失败必须和普通 selector 失效区分开

---

## 6. Qwen Web 适配计划

### 6.1 第一阶段目标

建议 **Qwen 优先于 ChatGPT 落地**，因为公开结构更清晰。

第一阶段支持：

- 文本对话
- thinking 模式基础支持
- search 模式基础支持
- 代码块提取
- tool-call 文本协议复用
- 单账号可用

### 6.2 可直接利用的结构

已识别可作为首版选择器的元素：

- 输入框：
  - `.message-input-textarea`
  - `.qwen-chat-v2-input-textarea`
- 发送按钮：
  - `.chat-prompt-send-button .send-button[aria-label="Send"]`
- 停止按钮：
  - `.chat-prompt-send-button .stop-button[aria-label="Stop"]`
- 代码块：
  - `.qwen-markdown-code`
  - `.qwen-markdown-code-body`
- artifact：
  - `.artifact-container`

### 6.3 关键适配点

1. **ready 检测**
   - `#root` 已挂载
   - 可见输入框已出现

2. **生成中检测**
   - stop button 是否出现
   - 代码块/文本是否仍在变化

3. **回复提取**
   - 文本块
   - 代码块
   - 必要时识别 artifact 为附加输出，而不是正文

4. **模式切换**
   - thinking / search / deep research 等能力暂按“可见控件文本匹配”设计
   - 先不要绑定过深的布局结构

5. **登录与失效检测**
   - token 失效
   - `/auth` 跳转
   - captcha / 验证提示

### 6.4 Qwen 特有风险

1. authenticated SPA，原始 HTML 壳几乎无信息
2. 版本发布可能调整 class
3. artifact / iframe 输出不等于普通 message
4. 不同区域/语言环境下文案可能变化

### 6.5 对应设计要求

- Qwen adapter 需要把文本回答、代码输出、artifact 输出分层提取
- length/quota/login 检测需要允许中英文关键词集合

---

## 7. 工具调用复用方案

### 7.1 现有方案的可迁移性

当前项目的工具调用并不是依赖 DeepSeek 网页原生 function calling，而是：

1. 网关把 OpenAI `tools` 转成提示词说明
2. 模型在网页里输出约定格式的 `tool_call`
3. driver 用 `parseToolCalls()` 容错解析
4. DSH 执行工具后再把结果送回模型

这个方案对 ChatGPT 和 Qwen 都成立。

### 7.2 建议策略

- 第一阶段保持 `buildToolsText()` 与 `parseToolCalls()` 基本不变
- 只在必要时加入 provider-specific 提示词微调，例如：
  - ChatGPT 更容易输出解释性前言，则提示词更严格
  - Qwen 若更常输出 fenced code block，可增强对应解析路径

### 7.3 测试要求

新增 parser regression case：

- ChatGPT 风格 tool_call 输出
- Qwen 风格 tool_call 输出
- 混合中文说明 + JSON block
- 带 markdown 包裹、带代码围栏、带多余解释文字

---

## 8. 会话、账号池与恢复策略

### 8.1 会话层复用

继续复用现有：

- `first`
- `delta`
- `recovery`

这是多 provider 方案的关键，因为网页端天然不是标准 API。

### 8.2 provider 维度扩展

建议 session key 或 session record 增加：

- `provider`
- `profile`
- `model`
- `providerEpoch` 或 `adapterEpoch`

避免出现：同一 session 在 deepseek / chatgpt / qwen 间误复用。

### 8.3 账号池设计建议

短期建议：

- DeepSeek 保持现有 account pool
- ChatGPT/Qwen 第一阶段先只做单账号
- 账号池抽象接口保留 provider 维度，但默认不开启多账号轮换

理由：

- ChatGPT 挑战与风控更复杂
- Qwen 虽然可做，但先把稳定性跑通再扩多账号

### 8.4 恢复策略

provider 切换、driver 重启、profile 切换、登录重做时，统一走 `recovery`。

原则不变：

- DSH 看到的是连续 API
- 网页看到的是可能被重建的新对话
- 网关负责压缩并恢复上下文

---

## 9. 需要新增的测试面

### 9.1 单元/离线测试

新增测试建议：

1. `tests/test-provider-registry.js`
   - provider 注册完整性
   - model id 唯一性

2. `tests/test-provider-model-mapping.js`
   - model → provider → adapter config 映射

3. `tests/test-chatgpt-selectors.js`
   - selector 优先级与回退逻辑

4. `tests/test-qwen-selectors.js`
   - selector 优先级与回退逻辑

5. `tests/test-provider-errors.js`
   - login/challenge/quota/dom-changed 映射

6. `tests/test-tool-parser-provider-cases.js`
   - ChatGPT/Qwen 风格 tool_call 解析

7. `tests/test-session-provider-isolation.js`
   - session 不跨 provider 串用

### 9.2 集成测试

建议后续补：

1. `/v1/models` 返回多 provider 模型
2. `stream=false` 与 `stream=true` 都能跑通
3. provider 登录状态缺失时返回明确错误
4. provider DOM 失效时错误类型可区分
5. recovery 路径在 provider 级别可工作

### 9.3 手工验证清单

至少验证：

- DeepSeek 现有功能零回归
- Qwen 单轮对话可用
- Qwen 连续对话可用
- ChatGPT 单轮对话可用
- ChatGPT 登录失效提示正确
- tool-calling 至少在一个非 DeepSeek provider 上可闭环

---

## 10. 分阶段实施计划

### Phase 0：规划与抽象准备

目标：只抽象，不增加新 provider 行为。

工作项：

1. 盘点 `dsweb-gateway.js` 中 DeepSeek 绑定点
2. 盘点 `driver.js` 中 DeepSeek 绑定点
3. 抽出 provider registry / adapter interface
4. 保证 DeepSeek 通过新接口继续可用

完成标准：

- DeepSeek 行为不变
- 新代码结构允许挂接第二个 provider

### Phase 1：DeepSeek 先迁移到 adapter 架构

目标：把 DeepSeek 自己先变成 `providers/deepseek.js`。

工作项：

1. 抽出 URL / selector / mode / extract / detectLimit
2. driver core 调用 adapter，而不是写死 DeepSeek 逻辑
3. 测试全量回归

完成标准：

- DeepSeek 回归测试通过
- adapter 接口稳定成型

### Phase 2：优先接入 Qwen Web

目标：接入第二个 provider，验证多 provider 架构成立。

工作项：

1. 新增 `providers/qwen.js`
2. 注册 Qwen 模型
3. 实现登录检测、输入、发送、输出提取、thinking/search 基础切换
4. 增加 Qwen provider 测试

完成标准：

- `/v1/models` 中出现 qwen 模型
- Qwen 文本对话可用
- Qwen 基本 streaming 可用

### Phase 3：接入 ChatGPT Web

目标：在已有架构上接入 ChatGPT。

工作项：

1. 新增 `providers/chatgpt.js`
2. 实现 DOM 路径与必要的 challenge / login 分类
3. 如可能，增加 network-first 读取路径
4. 增加 ChatGPT provider 测试

完成标准：

- ChatGPT 单轮对话可用
- 登录/挑战/DOM 异常可正确分类

### Phase 4：统一管理面与易用性

目标：让用户可以按 provider 管理登录与状态。

工作项：

1. `/login`、`/login-status`、`/accounts` 增加 provider 参数
2. 首页管理 UI 展示多 provider 状态
3. `/health` 输出 provider 维度统计

完成标准：

- 用户能清楚看到每个 provider 的登录状态与可用性

### Phase 5：高级能力与稳定性加固

候选增强：

1. ChatGPT network stream 解析增强
2. Qwen artifact / iframe 内容增强
3. provider 级 account pool
4. provider 级校准与选择器回放
5. 多模态输入

---

## 11. 风险清单

| 风险 | 说明 | 缓解策略 |
|---|---|---|
| R1 | ChatGPT 反自动化更强 | 将 challenge 识别为一等错误；先做手工登录 + 持久 profile |
| R2 | 页面结构频繁变化 | adapter 化 + 多选择器回退 + provider 级测试 |
| R3 | 不同 provider 的流式语义不一致 | 保持 gateway 输出统一，driver 内部自行适配 |
| R4 | 账号池抽象被过早泛化 | 先 DeepSeek 保持成熟方案，其他 provider 单账号起步 |
| R5 | 工具调用格式漂移 | 保留宽松解析器，补 provider-specific regression case |
| R6 | 同名模型或能力语义混淆 | model id 显式加 provider 前缀 |
| R7 | 不同 provider 复用同一 profile 造成 cookie 污染 | profile 命名带 provider 前缀 |
| R8 | DeepSeek 回归 | 必须先完成 Phase 1 并跑现有测试 |

---

## 12. 推荐实施顺序

**推荐顺序不是先上 ChatGPT，而是：**

1. 抽象 provider 接口
2. 先把 DeepSeek 迁到 adapter 架构
3. 先接 Qwen
4. 再接 ChatGPT

原因：

- 这样最能验证架构是否真的可复用
- Qwen 的首版实现难度和不确定性都更低
- ChatGPT 可以作为更高难 provider 放到第二阶段，不会把底层架构一开始就绑死在它的特殊挑战上

---

## 13. 本次规划的最终建议

### 建议 A：不要复制项目做三个独立插件

不建议：

- `dsh-deepseek-web-adapter`
- `dsh-chatgpt-web-adapter`
- `dsh-qwen-web-adapter`

三份各自复制粘贴。

因为这会导致：

- OpenAI 网关逻辑重复
- tool-calling 逻辑重复
- session/recovery 逻辑重复
- 修 bug 时三边分叉

### 建议 B：保留当前插件名，内部升级为多 provider

建议：

- 先不急着改 npm 包名
- 保留当前入口与安装方式
- 通过模型列表把不同 provider 暴露给 DSH

后续若需要再考虑重命名为更通用的包名。

### 建议 C：短期优先级

短期最优路线：

1. **做 provider adapter 抽象**
2. **Qwen 首接入**
3. **ChatGPT 次接入**
4. **最后再考虑 provider 级多账号**

---

## 14. 交付物定义

本规划阶段完成后，后续编码阶段的目标交付物应包括：

1. provider adapter 基础框架
2. DeepSeek adapter 化重构
3. Qwen adapter 首版
4. ChatGPT adapter 首版
5. 新增 provider 测试集
6. 更新后的 README / 用户文档 / 配置文档

---

## 15. 与现有文件的对应关系

本计划主要影响的现有文件将是：

- `lib/index.js`
- `resources/dsweb-gateway.js`
- `resources/driver.js`
- `tests/test-model-modes.js`
- `tests/test-parser-all.js`
- `tests/test-account-pool.js`
- `spec/SPEC.md`
- `spec/SPEC-v2.md`

预计新增文件：

- `spec/SPEC-multisite.md`
- `resources/providers/deepseek.js`
- `resources/providers/chatgpt.js`
- `resources/providers/qwen.js`
- `resources/provider-registry.js`
- 若干 provider 相关测试文件

---

## 16. 一句话结论

**这件事值得做，而且最优解不是在现有 DeepSeek 代码上继续堆 if/else，而是把项目升级成“多 provider Web-to-OpenAI 网关”：先抽象、先迁 DeepSeek、先落地 Qwen、再接 ChatGPT。**
