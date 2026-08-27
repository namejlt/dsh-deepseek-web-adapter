# SPEC-hardening-2026-08-27 — Web-to-OpenAI 网关安全、可靠性与可维护性加固规格

> 状态：**提案（基于 2026-08-27 仓库只读审计）**
> 范围：`dsh-deepseek-web-adapter` 的 Cordis 插件宿主、本地 OpenAI 兼容网关、CDP 浏览器驱动、DeepSeek / ChatGPT / Qwen 适配器、账号池、测试和发布链路。
> 不在本规格中执行运行时代码改动；实现前应以本文件为验收基线。

---

## 1. 结论与决策

项目已经具备可工作的核心链路：Cordis 插件启动本地网关，网关以 JSON-lines RPC 调用常驻 driver，driver 使用独立 Chrome profile 和 CDP 驱动三个网页端，再将结果转为 OpenAI Chat Completions SSE。Provider 注册表、按 provider 隔离的 profile/channel/account，以及基本的账号冷却与恢复机制已经落地。

当前最大风险不在“再增加一个网页选择器”，而在以下四件事：

1. **本地控制面无鉴权且允许任意 Origin 跨站调用**：网关绑定 loopback，但返回 `Access-Control-Allow-Origin: *`，并把 `/config`、`/accounts/*`、`/calibrate/*`、`/debug`、`/login` 等控制操作暴露给浏览器来源。任意恶意网页有机会诱导用户浏览器跨站操控本地网关，或读取其状态。
2. **登录态和可变运行数据存放在 npm 安装包目录**：当前插件固定将 `BASE_DIR` 指向 `resources/runtime`。升级、重装、权限变化和误打包都会影响 profile/cookie、账号池与校准数据的持久性和保密性。
3. **离线测试数量多但测试可信度与真实网页验证不足**：审计实际执行的 13 个测试文件中，11 个通过；2 个失败均为测试自身断言/fixture 失效，并非本次可复现的生产逻辑失败。现有测试大量依赖源码切片、`eval`/VM 和字符串断言，重构时容易出现“测试通过、运行时断裂”。三个 provider 尚未有已登录真实网页的可重复验收证据。
4. **核心行为过度集中**：`resources/driver.js`（约 4k 行）同时承担 CDP、浏览器生命周期、DeepSeek 页面逻辑、跨 provider 流、工具调用文本协议、任务调度和校准；`resources/dsweb-gateway.js`（约 2.2k 行）同时承担 HTTP、SSE、会话、账号池、管理页面和 RPC。继续在其中追加页面特例会放大回归面。

### 推荐策略

采用 **“先封闭控制面与状态面，再固化契约和测试，最后模块化与扩展并发”** 的三阶段路线：

- **Phase A（发布阻断 / P0）**：控制面鉴权、稳定状态目录、发布包卫生、可重复的测试入口与真实浏览器验收门槛。
- **Phase B（可靠性 / P1）**：OpenAI 协议契约、取消/超时/进程恢复、工具调用严格化、可观测性与测试替换。
- **Phase C（演进 / P2）**：driver/gateway 分层、provider capability 机制、多浏览器 worker 与可选的自动化框架迁移评估。

**不建议**在 P0/P1 未完成前直接将整个自定义 CDP 控制层替换为 Playwright/Puppeteer。当前零依赖特性有实际分发价值；先把接口和测试边界固定，之后才能低风险替换底层实现。

---

## 2. 审计范围与已验证事实

### 2.1 架构与实现现状

```text
DSH / pi-ai
  └─ HTTP + SSE: 127.0.0.1:5688/v1
       └─ resources/dsweb-gateway.js
            ├─ OpenAI Chat Completions / 模型列表
            ├─ 会话、账号池、管理页与本地控制 API
            └─ JSON-lines RPC over stdio
                 └─ resources/driver.js
                      ├─ Chrome 生命周期与手写 CDP WebSocket 客户端
                      ├─ DeepSeek 专用页面驱动
                      ├─ ChatGPT / Qwen adapter 流式路径
                      └─ 工具调用文本解析、流终止、校准
```

- Provider 注册表公开 22 个模型：DeepSeek 8 个、ChatGPT 2 个、Qwen 12 个。
- `resources/provider-registry.js` 已是模型/provider 元数据的单一来源；但 DeepSeek 仍主要走 `driver.js` 内的专用逻辑，ChatGPT/Qwen 才使用 adapter 表达式，抽象不对称。
- provider/profile/channel/account 名称已隔离，且多账号时为了避免单浏览器 profile 切换互相覆盖，实际并发会降为 1。这是当前正确但吞吐受限的安全选择。
- 插件入口 `lib/index.js` 只负责启动/停止固定端口上的 gateway；没有网关身份校验、崩溃自愈或持久化状态目录迁移。

### 2.2 本次验证结果

已执行：

```bash
for f in tests/test-*.js; do node "$f"; done
for f in lib/index.js resources/*.js resources/providers/*.js tests/test-*.js; do node --check "$f"; done
npm pack --dry-run --json
```

结果：

- 11 个测试文件通过，包括账号池、SSE/会话完整性、provider 路由、管理台、模型模式、adapter DOM fixture、工具提示词和 registry。
- `tests/test-parser-all.js`：75 通过、1 失败。失败项 `E9` 将已经计算好的布尔值 `e9.length === 1` 传给了期待文本的 `check()` helper；单独复现 `parseToolCalls()` 返回正确的首个 `pwsh` 调用。因此这是**测试调用错误**，不是 parser 返回多个调用。
- `tests/test-runtime-context.js`：33 通过、1 失败。`SYS_LONG.length` 实际为 7701，却断言应大于 9000；后续“尾部标记不丢失”的运行时断言通过。因此这是**fixture 长度前置条件陈旧**，不是系统消息被截断。
- `node --check` 对所有 runtime、provider、插件入口与测试文件通过。
- `npm pack --dry-run` 显示发布包仍包含 `resources/runtime/calibration.json`、所有测试文件以及 `tests/node_modules` 元数据；这与“可变 runtime 数据绝不随包发布”的目标不一致。

### 2.3 已知验证边界

当前 provider 测试主要是 fake driver、静态 DOM fixture 或 VM 纯函数测试；README 和用户文档也明确声明尚未完成三端“真实已登录 profile”的手工验收。该声明应继续保留，直到 Phase A 的 live smoke 证据完成。

---

## 3. 风险清单与优先级

| 优先级 | 问题 | 证据/影响 | 目标 |
|---|---|---|---|
| P0 | 本地控制面无鉴权 + `Access-Control-Allow-Origin: *` | 网关的生成与管理 API 都无 token；跨站页面可请求 loopback 服务 | 所有敏感路由必须要求 bearer token；默认拒绝跨 Origin |
| P0 | 状态目录位于包内 | `lib/index.js` 将 base 固定为 `resources/runtime`；profile/cookie 可能被更新、卸载或打包流程影响 | 状态移至用户数据目录，且权限最小化 |
| P0 | 发布包包含 mutable runtime 与测试依赖元数据 | `npm pack --dry-run` 显示 `resources/runtime/calibration.json` 和 `tests/node_modules/*` | 包只含运行必要文件，绝不含 profile/账号/校准状态 |
| P0 | 测试套件不是可靠发布门禁 | 两个失败是测试缺陷；根包无标准 `test` script；无 CI | 单命令、确定性、可判断的质量门禁 |
| P0 | 无可重复的真实网页 smoke 证据 | 所有 provider 仍声明未 live verified | 发布前形成最小可审计验收记录 |
| P1 | 本地服务身份与端口冲突处理不足 | 插件只要 `/v1/models` 返回 2xx 就视为“自己的网关”；固定 `5688` | 进程身份/版本握手、清晰冲突提示、受控重启 |
| P1 | HTTP/OpenAI 错误契约不统一 | 一些 JSON 解析或控制面异常会走通用 `{ok:false,error:string}` | `/v1/*` 始终返回规范 OpenAI 错误；控制面有独立 schema |
| P1 | 工具调用解析过度宽松 | 允许裸 JSON、仅参数对象、名称推断和必填参数自动补齐；网页正文中的示例可能被误执行 | 默认仅接受明确、授权、完整的工具协议；兼容模式必须显式开启 |
| P1 | gateway / driver 过度耦合 | 两个巨型文件混合协议、状态、UI、DOM 与恢复 | 固化接口后拆成可独立测试的模块 |
| P1 | 生命周期与可观测性不足 | 子进程退出没有插件侧监督；健康检查不含实例身份；诊断缺少结构化 request id | 可恢复、可定位、不暴露敏感内容 |
| P1 | 文档、包描述与测试数字已陈旧 | README 仍写 parser 54/54、account pool 61/61，当前实际为 76/78 等；description 仍 DeepSeek-only | 文档只引用统一测试命令与生成的摘要 |
| P2 | 多账号吞吐被单浏览器串行限制 | 账号数 > 1 时全局并发降为 1 | provider/profile worker 隔离后可受控提升并发 |
| P2 | 自定义 WebSocket/CDP 实现维护成本高 | 手写 RFC6455/CDP 需持续维护协议细节和资源上限 | 先覆盖关键单测，再评估保留或替换底层 |

---

## 4. 目标、非目标与兼容性约束

### 4.1 目标

1. 将 gateway 从“本机任意网页可调用的 HTTP 服务”收紧为“仅 DSH 插件/受信本机客户端可调用的受保护服务”。
2. 保证更新、重装和发布不会删除、打包或意外公开登录 profile、账号池与校准数据。
3. 为 `/v1/models`、`/v1/chat/completions`（stream/non-stream、tool calls、取消、错误）建立稳定的 OpenAI 兼容契约。
4. 让每一项网页适配改动同时有纯单元测试、fake-driver 集成测试和最小 live smoke 证据。
5. 在不破坏既有 DeepSeek model ID、`/v1/` 路径、历史 `default` profile 和 DSH 手动配置的前提下完成迁移。

### 4.2 非目标

- 不绕过 CAPTCHA、Turnstile、站点限制或服务条款。
- 不承诺第三方网页 UI 的永久稳定性。
- 不把网页端的“免费/无 API Key”表述当作功能或可用性保证。
- Phase A/B 不新增 provider、不承诺附件、多模态、网页 artifact/iframe 语义，也不把多账号并发从 1 直接提高。
- 不在未获得真实账号授权时自动登录或存储任何明文 cookie/token。

### 4.3 兼容性

- 已有模型 ID 必须保持可解析；新增 capability 只能改变显式声明的模型行为。
- `/v1/models`、`/v1/chat/completions` 与 `/chat/completions` 别名保留一个兼容周期。
- 旧 `deepseek/default` profile 可读，但首次写入新状态时迁移为 provider-scoped 数据，并生成可回滚备份。
- 管理页面和控制 API 迁移到鉴权后，必须提供用户可执行的 DSH 配置更新与 CLI/浏览器访问说明；不得静默把 token 放进日志或 URL 查询参数。

---

## 5. Phase A — 发布阻断项（P0）

### A1. 认证、Origin 与控制面分级

#### 需求

1. gateway 首次启动时生成 32-byte 随机实例密钥，Base64URL 编码；密钥文件仅用户可读写（POSIX `0600`，Windows 使用用户目录 ACL 的最佳努力策略）。
2. `/v1/*` 与所有管理/诊断/校准/账号路由都要求 `Authorization: Bearer <token>`，唯一例外是受限的本机 bootstrap 路径（若保留）。
3. 默认不返回 `Access-Control-Allow-Origin: *`：
   - API 请求不需要浏览器跨域访问时，不发送 CORS header；
   - 管理页由 gateway 同源提供，使用同源请求与 cookie-less bearer bootstrap；
   - 若明确启用跨 Origin 管理，使用 allowlist、`Vary: Origin`、仅 `GET/POST/OPTIONS` 所需 header，且不可用通配符。
4. 对控制面进行权限分级：
   - **生成面**：`/v1/models`、`/v1/chat/completions`；
   - **只读运维面**：`/health`、`/providers`、`/setup`；默认不返回 profile 路径、完整错误正文、账号使用计数等敏感详情；
   - **破坏性控制面**：账号启禁/删除、校准写入、配置修改、登录/重启；要求同一 bearer token 且检查方法、Content-Type、body schema。
5. 每个拒绝请求返回无敏感信息的结构化错误：`401 invalid_api_key`、`403 origin_not_allowed` 或控制面统一错误码；不得回显 token、cookie、profile 绝对路径或完整页面文本。

#### DSH 配置策略

- 插件启动 gateway 后读取其私有 token，并通过插件可配置的 provider credentials/运行时注入使用该 token。
- 如果 Cordis/DSH 当前无法安全动态注入 credentials，则暂时生成一段用户必须复制到本地 settings 的 token，并在启动日志中只显示其文件位置、不显示值；管理页不得把 token 写进 DOM、URL 或复制到日志。
- 旧 `MOCK_LLM_KEY` 配置不可继续作为安全边界；迁移期间仅可作为明确的非安全兼容占位。

#### 验收

- 无 `Authorization`、错误 token、来自不允许 Origin 的跨站请求均无法调用生成或管理端点。
- 持有正确 token 的 DSH 能正常调用 stream/non-stream completions。
- 同源管理页完整可用，网络面板没有 token 出现在 URL/HTML/控制台日志中。
- 新增 HTTP 集成测试覆盖 401/403、预检、方法限制、敏感控制操作与 token 脱敏。

### A2. 独立状态目录与安全迁移

#### 需求

1. 插件默认状态目录改为用户级路径：
   - macOS/Linux：`${XDG_STATE_HOME:-~/.local/state}/dsh-web-adapter`；
   - Windows：`%LOCALAPPDATA%/dsh-web-adapter`；
   - 环境变量 `DSWEB_STATE_DIR` 可覆盖；`--base` 只用于开发/测试，不作为安装版默认。
2. 目录至少包含：`profiles/`、`accounts.json`、`calibration.json`、`gateway-token`、`logs/`、`backups/`，并为每种文件定义 owner-only 权限。
3. 首次迁移检测旧 `resources/runtime`：仅当目标为空且旧目录属于当前用户时复制（不移动）必要数据；生成带时间戳的备份与迁移结果记录。迁移失败时启动只读提示，不删除旧数据。
4. 所有 JSON 写入使用原子写法：写入同目录临时文件、`fsync`、严格权限、原子 rename；解析失败时保留损坏原件并从最小安全默认值恢复。
5. 删除账号默认只删除账号池记录；“删除登录 profile”必须是单独、二次确认且 provider/account 精确匹配的操作。

#### 验收

- `npm update`、重新安装插件、删除包目录均不影响用户状态目录中的 profile 与账号池。
- package 内不存在 runtime state、profile、token、日志或校准文件。
- 中断写入后重启，账号池/校准不会被截断 JSON 导致 gateway 无法启动。
- 状态目录迁移与权限行为有跨平台单元测试和手工验证清单。

### A3. 发布包、脚本和 CI 门禁

#### 需求

1. 重构 `package.json.files` 为 allowlist：只发布 `lib/`、`resources/` 中明确的运行时源文件、`cordis.patch.yml`、LICENSE、README；显式排除 `resources/runtime/**`、`tests/**`、`output/**`、`.playwright-cli/**`。
2. 增加根 package scripts：
   - `test:unit`：纯函数/模块测试；
   - `test:integration`：fake driver + HTTP/SSE 集成测试；
   - `test`：按确定顺序执行以上两类，任一失败立即非零退出；
   - `check`：`node --check`、发布包文件断言、文档模型数一致性检查；
   - `pack:check`：`npm pack --dry-run --json` 后断言禁止路径不存在。
3. 引入 CI（Node 18 LTS 与当前支持 Node LTS），在 pull request 与 tag/release 前执行 `npm ci`、`npm run check`、`npm test`、`npm run pack:check`。
4. 测试输出采用机器可读 summary（文件数、assertion 数、失败详情）；README 不再硬编码脆弱的断言总数。

#### 验收

- `npm test` 和 `npm run check` 在干净 clone 中可运行，不依赖已存在的 `tests/node_modules` 或运行时 profile。
- `npm pack --dry-run` 的文件清单不含 `runtime/`、`tests/`、`output/`、`.playwright-cli/`。
- CI 任一门禁失败时不允许发布。

### A4. 测试失真修复与真实网页登录验收

#### 必做修复

1. 修复 `tests/test-parser-all.js` 的 E9：对 `e9` 直接断言 `Array.isArray(e9) && e9.length === 1`，不得把布尔值传入文本解析 helper。
2. 修复 `tests/test-runtime-context.js` 的长系统提示 fixture：要么将内容扩至真实超过 9000 字符，要么把断言改为与历史阈值一致的 `> 8000`；保留“尾部标记不丢失”的行为断言。
3. 将这两项失败纳入回归测试：错误的 helper 调用或 fixture 前置条件必须让测试明确失败，而不是伪装为产品回归。

#### live smoke 门槛

每个 provider 的每个发布候选至少执行一次授权账号的有头浏览器 smoke，并将**不含身份信息**的记录保存为 release artifact：

| 场景 | DeepSeek | ChatGPT | Qwen |
|---|---:|---:|---:|
| 登录态检测与 `/v1/models` | 必须 | 必须 | 必须 |
| 新会话普通文本 SSE | 必须 | 必须 | 必须 |
| 代码块 / Markdown 回复 | 必须 | 必须 | 必须 |
| 配置一个有差异的模型/思考模式 | 必须 | 必须 | 必须 |
| 取消流与超时错误映射 | 必须 | 必须 | 必须 |
| provider/profile 隔离 | 必须 | 必须 | 必须 |
| 至少一个授权工具调用 | 必须 | Beta 限定/明确 N/A | Beta 限定/明确 N/A |

验收记录至少包含：日期、commit SHA、OS/Chrome major version、provider、模型 ID、场景结果、已知失败 selector、截图/DOM fixture 哈希。不得记录账号名、cookie、完整 prompt 或模型私密回复。

---

## 6. Phase B — 可靠性与协议契约（P1）

### B1. Gateway 身份、端口与进程生命周期

#### 需求

1. `/health` 返回协议版本、实例 ID、启动时间、PID（仅认证后）、driver epoch 和 capabilities；`/v1/models` 不再是插件判定“端口上的服务就是自己”的唯一依据。
2. `lib/index.js` 启动时执行认证后的健康握手，验证协议 major version、实例 token 和 plugin-owned 标记；端口被其他进程占用时给出明确错误与恢复指引，绝不接管未知进程。
3. 监听 gateway child 的 `exit`/`error`：
   - 正常卸载时不重启；
   - 非预期退出采用指数退避、有限次数重启；
   - 重启失败通过 Cordis event 和 `/health` 公开“degraded”状态；
   - 重启后会话必须显式进入 recovery，不得把旧 channel 当作仍可用。
4. 对 driver 也建立同样的状态机：starting → ready → degraded → restarting → stopped；request id 和 driver epoch 贯穿日志。

#### 验收

- 任意非本插件服务占用端口时，插件不会错误声明 gateway 已就绪。
- 人为 kill gateway/driver 后，状态可观察、策略符合退避设置，活动会话返回可重试的规范错误而非无限挂起。
- 进程重启不会泄漏孤儿 Chrome 子进程。

### B2. OpenAI HTTP/SSE 契约

#### 需求

1. 将 HTTP 路由按 API 面与控制面拆分；所有 `/v1/*` 都使用 OpenAI 风格错误 envelope：

```json
{
  "error": {
    "message": "human-readable message",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_json"
  }
}
```

2. 对 malformed JSON、body 超限、错误 Content-Type、未知字段策略、请求方法、客户端断开、driver 超时、浏览器未登录、challenge、限流、DOM 缺失分别定义固定 HTTP status/type/code。
3. SSE 始终满足：首 chunk 为 assistant role；content/tool_calls 不混淆；每次流恰有一个 finish chunk；`[DONE]` 最后且仅一次；客户端断开时取消 driver stream 并释放会话锁/信号量。
4. 非流式结果返回标准 `chat.completion`，而非从 SSE 分支拼接；usage 在没有可靠 token 计数时明确为估计值或省略，不可伪造精确值。
5. 明确支持矩阵：仅承诺 `model`、`messages`、`stream`、`tools`、`tool_choice` 的指定子集；对于 `temperature`、`top_p`、`n`、`response_format`、`parallel_tool_calls`、多模态 content blocks 等不支持字段，返回显式 `unsupported_parameter` 或在文档中声明忽略策略，不能静默表现为已生效。

#### 验收

- 使用 OpenAI SDK 兼容测试客户端覆盖 stream、non-stream、cancel、tool calls 和错误路径。
- API 契约测试不再通过“源码含某字符串”判断 SSE 行为，改为读取实际 HTTP/SSE wire output。
- 响应中没有网页 DOM、内部 profile 路径或原始 exception stack。

### B3. 工具调用安全协议

#### 问题

现有 parser 为了兼容网页模型的非标准输出，接受裸 JSON、仅参数对象、函数样式和 schema 推断；也会为缺失 required 字段自动填默认值。对于能读写文件、执行命令或控制宿主的 DSH 工具，这会将“模型讲解中的 JSON 示例”误判为执行请求，且模糊 `tool_choice: "none"` 的语义。

#### 需求

1. 默认 `toolProtocol=strict`：仅接受完整、显式、单一的 `<tool_call>…</tool_call>` 或 ````tool_call` 代码块；必须含已授权 `name` 与 JSON object `arguments`。
2. 严格尊重 OpenAI 参数：
   - `tool_choice: "none"` 时绝不解析/输出 tool calls；
   - 未提供 `tools` 时绝不进行名称推断；
   - `parallel_tool_calls: false` 时强制单调用；当前 gateway 不支持并行时应拒绝 `true` 或明确降级。
3. 对 arguments 用 JSON Schema 校验，缺少 required 字段时返回模型可恢复的格式错误；不得自动补充权限、审批、路径、命令或理由等安全敏感字段。
4. 若必须支持旧格式，放在 `toolProtocol=compat` 明确开关内：只允许低风险非执行工具，且每次触发都记录脱敏审计事件。
5. 将“模型输出文本”与“工具指令”分离：strict 模式下普通 Markdown/JSON 示例必须作为 content 原样透传，不得执行。

#### 验收

- 含工具 JSON 示例的普通回答不会产生 `tool_calls`。
- 未授权工具、缺失 name、缺失 required、`tool_choice:none`、多工具输出、异常 JSON 都有单独测试。
- 只有显式 protocol 且 schema 通过的调用才能被返回给 DSH。

### B4. 可观测性、限额与隐私

#### 需求

1. 每个请求生成 `requestId`，贯穿 gateway RPC、driver stream、账号调度和 SSE 完成日志。
2. 结构化日志采用 JSONL，记录 provider/model/profile 的匿名 ID、耗时、状态、错误码、重试次数、response length；默认不记录 prompt、response、token、cookie、DOM 全文、账号名或绝对 state path。
3. 提供认证后的 metrics/health 摘要：active streams、queue length、driver/browser 状态、provider readiness、各错误码计数、最近错误时间。不得在默认健康响应中暴露具体账号状态。
4. 为 HTTP body、WebSocket frame 累积、CDP pending calls、SSE 单请求缓存、日志文件大小设置上限与轮转策略。
5. 账号池只根据明确页面信号做状态迁移；每次 quota/login/challenge 判断必须带 provider 与可解释 signal 类别，避免跨 provider 污染。

#### 验收

- 一次失败请求可用 `requestId` 在 gateway 和 driver 日志中关联。
- 运行高频失败/大 body/断流压测后，内存、文件和 pending RPC 不无限增长。
- 默认日志抽样检查不含敏感正文与 credential。

### B5. 测试体系重构

#### 目标分层

| 层级 | 目的 | 必须覆盖 |
|---|---|---|
| Pure unit | parser、映射、状态机、schema、错误码 | 无浏览器、无子进程、无源码切片 |
| Contract | gateway HTTP/SSE 与 fake driver 的真实字节流 | stream/non-stream、取消、错误、认证、版本握手 |
| Adapter fixture | 每个 provider 的 DOM adapter 函数 | composer、send、extract、登录/challenge、模式能力 |
| Browser smoke | 有头 Chrome + 授权账号 | Phase A 表中的 release 场景 |
| Packaging/upgrade | `npm pack`、状态迁移、权限、端口冲突 | 禁止文件、升级不丢 profile、错误可诊断 |

#### 需求

1. 停止依赖 `src.indexOf(...)` 截取函数并 `eval` 测试生产源码；将纯逻辑显式 export 到小模块，由 CJS/ESM 边界适配。
2. 用 `node:test` + `assert` 或保持零依赖的等效 runner，但所有测试必须有确定退出码、子测试名和统一 runner。
3. 每次修 bug 先增加可观察行为测试，不以源代码字符串存在与否作为主要断言。
4. 保留现有丰富 DOM fixture，但给 fixture 标注 provider、采集日期、页面版本/语言、对应 live smoke 证据；fixture 过期时应明确标红。
5. 增加 mutation-style tests：例如将 CORS 改回通配、将 token 校验删除、把 profile key 去 provider 前缀、将 `tool_choice:none` 忽略，测试应失败。

---

## 7. Phase C — 架构演进与性能（P2）

### C1. 目标模块边界

```text
resources/
  gateway/
    http-api.js          # route/auth/body/error/SSE transport
    openai-contract.js   # response/error serialization
    sessions.js          # session fingerprint/lock/recovery
    account-pool.js      # provider-scoped state machine + persistence
    supervisor.js        # driver lifecycle/identity/restart
    management-api.js    # authenticated management DTOs
  driver/
    cdp-client.js        # browser protocol transport only
    browser-worker.js    # one profile/worker lifecycle
    stream-controller.js # cancellation, timeout, delta and finalization
    tools.js             # strict/compat tool protocol only
    calibration.js
  providers/
    contract.js          # capability interface and normalized errors
    deepseek.js
    chatgpt.js
    qwen.js
  shared/
    state-store.js
    errors.js
    ids.js
```

模块只能通过明确 DTO 通信：`ProviderAdapter` 不应读取 gateway 全局状态；`AccountPool` 不应理解 DOM；HTTP 层不应拼接网页 prompt；driver 不应生成 OpenAI SSE JSON。

### C2. Provider capability contract

每个 provider 必须显式声明：

```js
{
  id,
  models,
  capabilities: {
    text: true,
    code: true,
    toolCalls: 'strict' | false,
    imageInput: false,
    thinking: 'supported' | 'best-effort' | false,
    search: 'supported' | false,
    concurrentProfiles: 1
  },
  login: { interactive: true, challenge: 'manual-only' },
  adapterVersion
}
```

gateway 根据 capability 在请求进入浏览器前返回可解释错误。禁止把未支持的附件、多模态、网页 artifact 或并行工具调用悄悄当文本处理。

### C3. 多 worker 并发（仅在 P0/P1 验收后）

1. 从“单一 browser + profile 切换”改为“每个活跃 provider/account 一个 BrowserWorker”，worker 拥有独立 user-data-dir、CDP、page pool 与资源配额。
2. 账号池调度只选择 worker；切换账号不再杀掉无关 provider/session 的浏览器与 channel。
3. 全局设置 CPU/内存/worker 数上限，默认仍保守；每个 worker 支持 idle shutdown 和 crash backoff。
4. 先对 DeepSeek 单 provider 验证，再扩展 ChatGPT/Qwen；不得以并发提高为由降低 profile 隔离。

### C4. CDP 传输的决策门

保留手写 CDP 的前提：

- WebSocket 输入累计和 fragment 有明确上限；
- CDP pending call、事件订阅、连接关闭、浏览器退出都有单元/集成测试；
- 不需要引入网页自动化框架才能修复关键稳定性问题。

若以上任一条件长期无法满足，再在已固定的 `BrowserWorker` 接口后评估迁移 Playwright/Puppeteer。迁移必须保留零网络依赖可选路径、状态目录、错误码与 smoke suite，不能以“框架替换”代替验收。

---

## 8. 实施顺序、里程碑与发布条件

### Milestone 0：基线修复与冻结

- 修复 E9 和长系统消息 fixture 的测试缺陷。
- 增加统一 `test/check/pack:check`，记录当前基线。
- 纠正文档中已过期的 54/54、61/61、35 assertion 等硬编码数字。
- 更新包 description 为多 provider Beta，避免“free/no API key”成为安全或可用性承诺。

**退出条件**：干净 clone 下 `npm run check && npm test && npm run pack:check` 全绿。

### Milestone 1：控制面与状态面

- token/auth/CORS、独立 state dir、状态迁移、发布 allowlist。
- HTTP 契约中先覆盖 auth 与结构化错误。

**退出条件**：未认证 API/控制请求全被拒绝；升级不丢 profile；pack 清单无 runtime；真实 DSH 可携 token 完成一次普通 SSE。

### Milestone 2：协议、工具与恢复

- API 错误/SSE contract、严格工具协议、进程身份/监督、结构化日志与限额。
- 将 fake-driver integration test 扩展为正式 contract test。

**退出条件**：所有 P1 contract test 通过；kill/restart/cancel/timeout 具备确定结果；示例 JSON 不会触发工具调用。

### Milestone 3：三端 live release gate

- 收集三 provider 的最小 smoke artifact。
- 回归 DOM fixture，明确每个模型的 capability 和不支持项。

**退出条件**：每个 provider 的 release matrix 全绿，或未通过项已从公开模型/文档中移除并有明确错误码。

### Milestone 4：模块化与 worker（可选）

- 按 §7 分层，保持每个小提交均有 contract 测试。
- 完成后再评估 per-profile worker 并发。

**退出条件**：行为兼容测试与 live smoke 不退化；多账号 worker 不共享 profile/cookie/channel。

### 发布阻断条件

在以下任一条件未满足时，禁止将项目标记为 stable 或 live verified：

- control plane 仍无 token 或仍回 `Access-Control-Allow-Origin: *`；
- profile/账号/token 仍保存在包目录或会进入 npm tarball；
- `npm test`、`npm run check`、`npm run pack:check` 不全绿；
- 三 provider 没有与当前 commit 对应的最小 authenticated smoke 记录；
- 文档仍声称不支持的参数/模式已经被支持，或仍把失效断言数当作当前验证结果。

---

## 9. 变更清单（实现时按职责分配）

| 文件/区域 | 预期变化 |
|---|---|
| `lib/index.js` | state dir 解析、gateway token 注入、带身份的 readiness handshake、child supervisor、端口冲突错误 |
| `resources/dsweb-gateway.js` | 逐步拆出 auth/HTTP/SSE/session/account/management；OpenAI error contract；路由方法与 body schema |
| `resources/driver.js` | 逐步拆出 CDP、browser worker、DeepSeek 流、stream controller、strict tool protocol；资源上限 |
| `resources/provider-registry.js` 与 `resources/providers/*` | capability contract、模型支持矩阵、adapter 版本与统一错误 |
| `package.json` / lockfile | engines、scripts、publish files allowlist、版本策略 |
| `.github/workflows/*` | CI/test/pack/release gate |
| `tests/*` | node:test/统一 runner、auth/state/contract/browser smoke/packaging regression |
| `README*`、`docs/user-guide.md`、`docs/publishing.md`、旧 spec | 新的 state 路径、token 配置、统一命令、能力矩阵、live 验收状态 |

---

## 10. 完成定义（Definition of Done）

一次加固版本只有同时满足以下条件才算完成：

1. **安全**：未经授权的本机或跨 Origin 请求不能调用生成、登录、校准、账号或配置操作；日志和包内无 credential/state。
2. **可靠性**：gateway/driver/browser 的启动、退出、重启、取消、超时、限流和登录失效都有固定状态与错误契约。
3. **兼容性**：已有 DSH 模型 ID、DeepSeek legacy profile、OpenAI stream/non-stream 基本调用不回归；不支持项明确失败。
4. **可验证性**：干净 clone 的统一质量命令全绿；包清单测试通过；每个已公开 provider 有当前 release 的 smoke 证据。
5. **可维护性**：新网页选择器或 provider 能在 adapter 层改动，并由 fixture + contract + smoke 覆盖；不再要求在 4k 行 driver 中跨越 HTTP、账号池和工具协议修改。
