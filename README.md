# dsh-deepseek-web-adapter — Beta 多站点 Web-to-OpenAI 网关

> **English**: [README.en.md](README.en.md)

> ⚠️ **Beta（开发者预览）**：这是一个本地 **Web-to-OpenAI** 网关，把 DeepSeek、ChatGPT 与 Qwen 的已登录网页版接到同一个 OpenAI 兼容出口。
> 多站点路由、provider 隔离与离线测试已经实现；**尚未完成真实已登录账号的手工验收，不宣称已完成在线/真实环境验证**。
> 请仅使用你有权使用的账号，并在发布前完成下方的手工登录 smoke test。

网关仍由 DSH 插件自动拉起，提供 `/v1/models` 与 `/v1/chat/completions`（SSE）接口。DeepSeek 保持既有模型；Beta 新增 ChatGPT 与 Qwen provider：

- ChatGPT：`chatgpt-auto`、`chatgpt-thinking`
- Qwen：`qwen-chat`、`qwen-thinking`、`qwen-search`
- 每个 provider 使用独立浏览器 profile、会话与登录态；不能跨站复用 cookie 或会话。

**保守能力边界**：仅支持文本、代码块和基础 SSE。**不支持**附件、图像或其他多模态输入；不解决或绕过 CAPTCHA/Turnstile/其他挑战；不转换网页原生工具卡片、trace、iframe 或 native artifacts（原生产物）。

**文档**：[使用教程](docs/user-guide.md) · [发布指南](docs/publishing.md) · [多站点规格](spec/SPEC-multisite.md) · [插件开发教程](docs/dsh-plugin-tutorial.md)

## 已知限制

| 限制 | 说明 |
|---|---|
| 多站点 Beta | provider 路由已实现并有离线覆盖；真实已登录账号的手工验收仍待执行，不宣称已在线验证 |
| 多账号并发退化为串行（P0） | 多账号时并发降为 1（切账号需重启单一浏览器）；单账号保持会话亲和并发 |
| 动态风控不可预知 | 公平使用无公开数值/解冻时间——网关只信页面信号，指数退避+到期探测，**不承诺解冻时刻** |
| 插件管理前端为内置 HTML 卡片页 | 本包现在自带插件管理前端：打开 `http://127.0.0.1:5688/` 即可看到安装引导、快速登录、状态检查、账户检查、配置管理与诊断卡片。未来如需接入 DSH 原生设置卡片，可直接复用同一组 JSON 接口（`/setup`、`/health`、`/accounts`、`/config`） |
| 依赖真实浏览器 | 需要本机安装 Chrome；登录态保存在 `runtime/profiles/` 浏览器配置目录，勾选"保持登录"后跨重启有效，DeepSeek 令牌过期后需重新登录 |
| Provider profile 隔离 | DeepSeek、ChatGPT、Qwen 具有独立 profile；请使用 `/login?provider=...` 分别登录 |
| 保守协议边界 | 仅文本、代码块、基础 SSE；无附件/多模态、挑战求解、网页原生 artifact/iframe 语义 |
| ChatGPT challenge | 返回需手工操作的 provider challenge 错误，不与 DOM 选择器错误混同 |
| Qwen 模式开关 | thinking/search 无法识别或不可用时返回 `mode_unavailable`，不静默降级 |
| 依赖 DeepSeek 网页版 UI | 网页版改版可能导致选择器失效（校准/发送/提取），届时需更新 `driver.js` |
| 解析器有兜底但非万能 | 54 场景回归覆盖常见格式；模型输出极端怪异格式时工具调用仍可能失败 |

## 安装

```bash
dsh plugin --profile web add dsh-deepseek-web-adapter
# 或从 GitHub（发布后）：
dsh plugin --profile web add github:你的用户名/dsh-deepseek-web-adapter
```

插件加载后，网关自动启动（3-8 秒，日志见 DSH 终端：`DeepSeek 网页版网关已监听 5688`）。

安装完成后，直接打开 `http://127.0.0.1:5688/` 进入**插件管理页**：
- 安装与接入卡片：复制 `settings.yaml` / `.credentials.yaml` 片段
- 快速登录卡片：默认账号登录、其它账号登录入口
- 运行状态卡片：gateway / driver / 会话 / 通道摘要
- 账户检查与管理卡片：账号状态、冷却、启用/禁用/删除
- 运行配置卡片：直接调用 `/config` 管理常用参数
- 诊断与维护卡片：`/health`、`/debug`、校准等快捷入口

## 配置 DSH 模型提供方

编辑 `~/.dsh/settings.yaml`，在 `llm-pi-ai.providers: { ... }` 内加入：

```yaml
dsweb:
  {
    displayName: Beta 多站点 Web-to-OpenAI (免 API),
    apiKeyEnv: MOCK_LLM_KEY,
    api: openai-completions,
    baseURL: http://127.0.0.1:5688/v1/,
    models:
      [
        { id: deepseek-chat, name: DeepSeek 快速 },
        { id: deepseek-reasoner, name: DeepSeek 深度思考 },
        { id: deepseek-search, name: DeepSeek 智能搜索 },
        { id: deepseek-think-search, name: DeepSeek 深度思考+搜索 },
        { id: deepseek-expert, name: DeepSeek 专家 },
        { id: deepseek-expert-reasoner, name: DeepSeek 专家+深度思考 },
        { id: deepseek-vision, name: DeepSeek 识图 },
        { id: deepseek-vision-reasoner, name: DeepSeek 识图+深度思考 },
        { id: chatgpt-auto, name: ChatGPT 自动（Beta） },
        { id: chatgpt-thinking, name: ChatGPT 思考（Beta） },
        { id: qwen-chat, name: Qwen 对话（Beta） },
        { id: qwen-thinking, name: Qwen 思考（Beta） },
        { id: qwen-search, name: Qwen 搜索（Beta） }
      ]
  }
```

并在 `~/.dsh/.credentials.yaml` 加：`MOCK_LLM_KEY: sk-mock-any-value`（任意值，网关不校验）。
DSH 配置热加载——模型选择器立即出现 DeepSeek 网页版。

## 登录

三个 provider **必须分别手工登录**。先打开管理页，再在同一台本机 Chrome 中完成相应站点的账号登录：

```text
http://127.0.0.1:5688/login?provider=deepseek
http://127.0.0.1:5688/login?provider=chatgpt
http://127.0.0.1:5688/login?provider=qwen
```

它们分别使用 `deepseek-default`、`chatgpt-default`、`qwen-default` profile；不要复制或共享 provider 间的 profile 目录。省略 `provider` 时仍兼容旧入口，默认 DeepSeek。

如果 ChatGPT 检测到 Cloudflare、Turnstile 或其他 challenge，网关返回**需要人工操作**的 `challenge_required`/`provider_challenge_required` 错误并指向上述登录入口；这与页面选择器失配导致的 DOM 错误不同，网关不会自动解题或绕过挑战。Qwen 的 thinking/search 开关不可用时返回 `mode_unavailable`，不会静默改用错误模式。

## 使用

DSH 模型选择器选择 **Beta 多站点 Web-to-OpenAI**。DeepSeek 保持既有 8 个模型；ChatGPT/Qwen 仅承诺文本、代码块和基础 SSE 的 Beta 通道。
模式映射对齐 2026-08 页面改版（三模式入口 + pill 开关，幂等切换）：

| 模式入口 | 可选 pill | 对应模型 ID |
|---|---|---|
| 快速 | 深度思考、智能搜索（可同开） | `deepseek-chat` / `deepseek-reasoner` / `deepseek-search` / `deepseek-think-search` |
| 专家 | 深度思考 | `deepseek-expert` / `deepseek-expert-reasoner` |
| 识图（视图） | 深度思考 | `deepseek-vision` / `deepseek-vision-reasoner` |

| 能力 | 说明 |
|---|---|
| 连续对话 | 网页版历史保持，超长度限制（默认 50 条，可调）自动迁移+摘要 |
| 工具调用 | 模型输出 `tool_call` 代码块 → 网关解析（54 场景容错）→ DSH 执行 |
| 模式切换 | pill 开关幂等切换（先读状态不一致才点击）；pill 未找到时回放校准录制兜底 |
| 会话亲和并发 | 指纹识别会话 → 专属浏览器通道；同会话串行、异会话并行、空闲回收 |
| 多账号保存 | 每账号独立浏览器配置目录（cookie 持久化），`/accounts` API 管理（v2 已实现） |
| 自动登录 | 会话失效自动弹登录窗口（互斥单窗口），登录后同账号 recovery 重试（v2 已实现） |
| 限流自动切换 | 动态风控：指数退避（5min×2ⁿ 封顶 6h）+ 到期探测；受限时自动切换账号并压缩重建上下文（v2 已实现） |

## 手动控制

```bash
# 打开插件管理页（推荐）
open http://127.0.0.1:5688/
# 查看引导 JSON（供未来 DSH 设置卡片复用）
curl http://127.0.0.1:5688/setup
# 查看网关日志 / 状态
curl http://127.0.0.1:5688/v1/models
# 查看运行状态（登录态 / 会话 / 通道 / 账号池 / 配置）
curl http://127.0.0.1:5688/health
# 查看登录状态（登录完成自动检测）
curl http://127.0.0.1:5688/login-status
# 调整运行时配置（参数见下表）
curl -X POST http://127.0.0.1:5688/config -H 'Content-Type: application/json' -d '{"maxConcurrent": 3}'
# 模型校准（模式 pill 找不到时的兜底录制：record → collect → save）
curl http://127.0.0.1:5688/calibrate/list     # 已存校准数据
curl http://127.0.0.1:5688/calibrate/record   # 开始录制（有头窗口 + 点击录制）
# DOM 结构诊断（模型选择器排查）
curl http://127.0.0.1:5688/debug
# 重启网关（卸载插件即停止网关；重新启用即自动拉起）
dsh plugin --profile web remove dsh-deepseek-web-adapter && dsh plugin --profile web add dsh-deepseek-web-adapter
```

`/config` 可调参数（POST JSON，立即生效）：

| 参数 | 取值（默认） | 说明 |
|---|---|---|
| `headless` | bool（false） | 无头模式（变更需重启网关并重新登录） |
| `maxConcurrent` | 1-5（2） | 全局并发生成上限 |
| `maxPages` | 1-8（4） | 浏览器通道数上限（满则驱逐最久空闲会话） |
| `maxTurnsPerChat` | 2-500（50） | 单网页会话轮数上限（超出自动迁移+摘要） |
| `accountPool` | bool（true） | 账号池开关（false = 恒用 default，v1 行为） |
| `maxAccounts` | 1-8（3） | 账号数上限 |
| `autoRelogin` | bool（true） | 会话失效自动弹登录窗口并重试 |
| `quotaBackoffBaseMs` | 60s-1h（5min） | 风控指数退避基数 |
| `quotaBackoffMaxMs` | 30min-24h（6h） | 风控指数退避封顶 |

账号管理（v2 已实现）：

```bash
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"name": "acc2"}'       # 添加账号（弹登录窗口，5 分钟超时）
curl http://127.0.0.1:5688/accounts                                         # 账号状态列表（含退避/统计）
curl -X POST http://127.0.0.1:5688/accounts/disable -d '{"name": "acc2"}'   # 禁用
curl -X POST http://127.0.0.1:5688/accounts/enable -d '{"name": "acc2"}'    # 启用（需登录验证后恢复）
curl -X POST http://127.0.0.1:5688/accounts/remove -d '{"name": "acc2", "confirm": true}'  # 删除（profile 目录保留）
```

✅ 已实现：`GET /setup` 安装引导 JSON；`GET /` 插件管理前端（卡片化 HTML 页）。

## 目录结构

```
lib/index.js          # host：加载时自动拉起网关，卸载时回收
resources/
  dsweb-gateway.js    # 核心网关（OpenAI API + 登录 + 校准 + 会话亲和并发 + 账号池 + 工具解析）
  driver.js           # 浏览器引擎（常驻 Chrome + 通道管理 + 限流检测）
  runtime/            # 本地运行时数据（校准数据 + accounts.json + profiles/ 账号目录 + 日志）
spec/
  SPEC.md             # v1 开发规格（现状）
  SPEC-v2.md          # v2 规格（多账号 / 自动登录 / 限流切换——核心已实现）
cordis.patch.yml      # bundle 配置补丁
```

## 工作原理

```
DSH (dsweb provider) → 网关 5688 → driver (provider 独立 Chrome profile) → DeepSeek / ChatGPT / Qwen Web
插件加载 → 自动 spawn 网关 → 卸载 → 自动回收
```

DeepSeek 网页版没有原生 function calling——网关用提示工程让模型输出 `tool_call` JSON，
再经多层容错解析（嵌套/别名/单反斜杠路径/尾逗号/缺引号/安全网重试）转换为标准 `tool_calls`
交给 DSH 执行。工具结果回传网页版继续。

网页端公平使用风控**无公开数值/解冻时间**，网关不做数值推断：受限信号只来自页面文案检测
（`detectLimit` 模式表，含"服务器繁忙"等动态文案），10 分钟窗口内二次命中才确认冷却；
确认后指数退避（5min×2ⁿ 封顶 6h），到期由真实请求探测恢复。请求中途受限时自动切换账号
（每请求预算 2 次）并以压缩历史重建上下文。回归测试 54 解析场景 + 61 账号池场景（`tests/`）。

## 开发 / 接手

**本仓库采用 MIT License——任何人可以自由 fork、修改、继续开发、再发布，无需授权。**

如果你要接手或贡献：

```bash
# 1. fork 或 clone
git clone https://github.com/huermi/dsh-deepseek-web-adapter.git
# 2. 安装依赖（无第三方运行时依赖，仅 Node 18+ 与 Chrome）
# 3. 本地启动网关调试
node resources/dsweb-gateway.js --port 5688 --base resources/runtime
# 4. 跑回归测试（改动 driver.js / dsweb-gateway.js 后必须跑）
node tests/test-parser-all.js    # 期望 54/54 通过
node tests/test-account-pool.js  # 期望 61/61 通过
```

**开发仓库**（含卡片 UI、host 自动拉起、完整回归套件）：见 `dsweb-plugin/` 目录说明或
[Issues](https://github.com/huermi/dsh-deepseek-web-adapter/issues) 讨论。

主要维护点：
- `resources/driver.js` —— 浏览器引擎 + 工具调用解析器 + 限流检测（DeepSeek 网页版 UI 变化时改这里；**单一源码**，网关运行时直接执行此文件，无需再同步任何副本）
- `resources/dsweb-gateway.js` —— 网关（OpenAI API / 登录 / 校准 / 并发 / 账号池 / 迁移）
- `lib/index.js` —— 插件 host（加载时拉起网关，卸载时回收）

## License

MIT —— 保留版权声明即可自由使用/修改/再分发。详细条款见 [LICENSE](LICENSE)。
