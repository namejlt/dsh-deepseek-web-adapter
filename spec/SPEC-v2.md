# SPEC v2 — 多账号 · 自动登录 · 限流自动切换 · 易用性

> 状态：**P0 已实现并通过测试（tests/test-account-pool.js 61/61）；已补 `/setup` 与内置插件管理前端；2026-08 完备性审计后新增 §11 稳定性加固**
> 前置文档：[SPEC.md](SPEC.md)（v1 现状规格，本文档不重复其内容）
> 责任人：用户 + 本地检查路径（`node tests/` + `curl /health`），无正式角色分工

## 0. 风控模型假设（关键前提修正）

DeepSeek 网页端对免费用户执行**公平使用动态风控**：无公开固定配额数值、无固定重置时间、
触发阈值随负载/账号行为动态变化。因此本设计**显式放弃**两类错误假设：

- ❌ "每日 N 条"——不存在可依赖的固定数值
- ❌ "次日 00:10 解冻"——不存在固定日重置点

取而代之的原则：**只信页面信号，不信数值推断**。受限信号只能来自 streamAsk 轮询中读到的
页面文案（`detectLimit` 模式表）；恢复策略采用**指数退避 + 探测恢复**（§5.1）——因为解冻
时间未知，唯一安全的恢复方式是到期后用一次真实请求探测，成功才回 active。

---

## 1. 背景、目标与非目标

### 1.1 现状缺口（v1 实证）

| # | 缺口 | 证据（代码位置） |
|---|------|------------------|
| G1 | DSH 实际调用路径（`streamAsk`）**没有配额/限流检测**——`detectLimit` 仅在任务模式 `runTask` 循环里调用 | driver.js:1539（唯一调用点）；streamAsk 轮询循环只读 `extractLast`/`generating` |
| G2 | driver 已有 profile 基建（`CFG.profiles`/`profileDir`/`handleQuota` 轮换）但**网关从不使用**——streamAsk 恒用 `default` profile | driver.js:1978 `ensureChannelPage('main')` 硬编码 default |
| G3 | 登录纯手动：会话失效时 streamAsk 只返回错误文案"请打开 /login"，**不自动开登录窗口** | driver.js:2271 错误分支 |
| G4 | 多账号 = 每账号一个浏览器实例，但 driver 的 `browser` 是**单例对象**，切 profile = 重启浏览器 | driver.js:295/303 单例 + 同名复用判断 |
| G5 | 使用门槛：需手改 `~/.dsh/settings.yaml` + `.credentials.yaml`，无配置引导、无账号管理界面 | README「配置 DSH 模型提供方」全手动 |
| G6 | 账号状态（登录态/冷却/统计）无任何持久化与可见性 | 无 accounts 状态文件，/health 只有 driver 概要 |

### 1.2 目标（Goals）

1. **多账号保存**：账号池（≥1 个），每账号独立浏览器 profile 持久化，跨重启保留登录态
2. **自动登录**：会话失效时自动弹出有头登录窗口（可配置），登录完成自动重试原请求
3. **限流自动切换**：quota/captcha 信号 → 当前账号进入冷却 → 自动切下一个可用账号并重建上下文继续任务
4. **易用性**：`/setup` 配置引导 JSON；`/` 卡片化插件管理前端；`/accounts` 管理 API；启动即登录引导；状态聚合页
5. **单账号零回归**：只有 1 个账号时行为与 v1 完全一致（含会话亲和并发模型）

### 1.3 非目标（Non-Goals）

- 不存储账号密码/不做自动填充凭据（安全红线，见 §8 风险 R5）
- 不做对 DSH 主程序仓库的原生设置页改动；当前仓库提供内置 HTML 卡片管理页与可复用 HTTP/JSON 接口
- 不做验证码自动求解（captcha 永远转人工）
- 不做跨机器/多 IP 分散（同 IP 多账号轮换的风控缓解仅限行为层，见 R1）

### 1.4 约束（Constraints）

- 零第三方运行时依赖（仅 Node 内置 + Chrome）——沿用 v1
- DeepSeek 登录态是 cookie：**不同账号必须不同 user-data-dir**（= 不同 Chrome 实例）
- 内存预算：每常驻 Chrome 约 200-400MB → 常驻账号数默认上限 3
- OpenAI 兼容契约对 DSH 不可变（SSE 格式、模型 ID 不变）

---

## 2. 架构决策记录（ADR）

### D1 账号池放在网关侧

- **Forces**：调度需要 HTTP 请求上下文（重试、SSE 已建立）+ 会话亲和注册表（sessions Map 在网关）+ 状态需跨 driver 重启存活；driver 保持"浏览器语义"单一职责
- **被拒**：driver 侧轮换——task 模式的 `handleQuota` 已证明难以复用到流式路径（G1/G2 根因）；且 driver respawn（epoch 失配）会丢状态
- **后果**：+ 网关新增 ~300 行 AccountPool 模块；- driver 需新增多浏览器实例管理（D2）
- **可逆性**：高——单账号时调度退化为"恒选唯一账号"，旁路整个池逻辑

### D2 每账号一个常驻 Chrome 实例

- **Forces**：cookie 隔离的硬约束；切换零成本（实例已常驻）；会话保持（切回时网页历史还在）
- **被拒**：单实例切 profile——v1 driver 切 profile 需重启浏览器（3-8s），且丢所有页面/通道绑定
- **后果**：driver 的 `browser` 单例 → `browsers: Map<profile, BrowserState>`；空闲账号实例 30 分钟回收（保 cookie 不保进程）
- **可逆性**：中——driver 页面管理函数全部要加 profile 参数；分两阶段实现（见 §9）

### D3 限流切换时上下文走 recovery 重建

- **Forces**：切账号后新网页版是空白会话；DSH 每轮发完整 messages → recovery 压缩重建机制（v1 已实现并测试）可直接复用
- **被拒**：全量重灌（网页版超长发送失败，v1 教训）；丢弃上下文重问（用户体验差、工具循环状态丢失）
- **后果**：切换后首轮请求 mode='recovery'；需要把"账号切换"注入 epoch 语义（同 driver epoch 但账号变了 → 也触发 recovery）

### D4 登录自动化 = 有头窗口 + 轮询检测，不存密码

- **Forces**：v1 的 `handlers.login` 已实现该模式（打开窗口→轮询→自动检测完成）；密码落盘是安全红线
- **被拒**：凭据保险库/自动填充——引入密钥管理复杂度与泄露面，收益仅省一次手动输入
- **后果**：登录窗口会抢焦点（桌面场景可接受，可配置关闭 autoRelogin）

### D5 易用性 = HTTP 引导面（/setup、/、/accounts、状态页）

- **Forces**：本包无卡片 UI（G5）；网关已有 HTTP 面；引导逻辑（检测 settings.yaml、打印片段）最适合放 host（lib/index.js 有文件系统权限感知用户目录）
- **被拒**：等卡片 UI 仓库（外部依赖，进度不可控）；CLI 子命令（DSH 插件无此挂载点）

---

## 3. 系统地图（目标态）

```
DSH (pi-ai provider: dsweb)
    │ POST /v1/chat/completions（SSE）
    ▼
┌─ Gateway (dsweb-gateway.js) ────────────────────────────────┐
│  OpenAI 兼容层（不变）                                        │
│  SessionRegistry（v1 已有，新增 account 绑定）                │
│  AccountPool（新增）★                                         │
│   ├─ 状态机: active / cooling / needs_login / disabled       │
│   ├─ 调度: 粘性优先 → 最久未用 active → 全受限则等待最早解冻    │
│   ├─ 落盘: runtime/accounts.json（跨重启保留冷却/统计）        │
│   └─ 切换重试: quota 信号 → 标记 cooling → 换账号 → recovery   │
│  /setup / /accounts /health （HTTP 面 + 管理前端）            │
└──────────────┬ stdio RPC（扩展 account 参数）─────────────────┘
               ▼
┌─ Driver (driver.js) ────────────────────────────────────────┐
│  Browser Farm（改造）: browsers Map<profile, Chrome 实例>     │
│  Channel/页面管理（v1 已有，扩展 per-profile）                 │
│  streamAsk 限流检测（新增）: 轮询中读 bodyTail → detectLimit   │
│    → stream-end { limitKind: 'quota'|'captcha'|'length' }    │
│  handlers.login（v1 已有，网关自动触发）                       │
└──────────────┬ CDP × N（每账号一条）──────────────────────────┘
               ▼
   Chrome#default  Chrome#acc2  Chrome#acc3   …（≤ maxAccounts）
   (chat.deepseek.com, 各自 cookie)
```

**信任边界**：账号 cookie 只存在于 driver 侧 profile 目录；网关的 accounts.json **不含任何凭据**（只有名字/状态/统计）——这是可测试不变量（FF8）。

---

## 4. 有界上下文映射

| 上下文 | 责任（检查路径） | 模型/语言 | 上游 | 下游 | 与邻居关系 |
|---|---|---|---|---|---|
| Host 引导（lib/index.js） | 生命周期 + setup 检测（本地跑 `dsh plugin add` 后看日志） | Cordis effect | DSH Cordis | Gateway | 对 Gateway conformist（沿用 spawn 契约） |
| Gateway API | OpenAI 契约 + 账号管理面（`curl /health`） | HTTP/SSE | DSH pi-ai | AccountPool, SessionRegistry | 对 DSH 是 customer/supplier（契约不可变） |
| AccountPool ★ | 账号状态机/调度/落盘（`tests/test-accounts.js`） | 状态机 + JSON | Gateway API | Driver(login/streamAsk) | 对 Driver 是 customer/supplier（rpc 契约）；对 SessionRegistry partnership（共享 account 字段） |
| SessionRegistry | 会话亲和（v1 已有，`tests/` 20 项） | 指纹 + 通道 | Gateway API | Driver channels | 对 AccountPool partnership |
| Browser Farm | 多 Chrome 实例生命周期（`/debug`） | CDP | Driver handlers | Chrome | 防腐层：对 DeepSeek UI 的 EXPR 适配集中在此 |
| Anti-Limit | 限流信号检测（driver 内 `detectLimit`） | 文本模式匹配 | streamAsk 轮询 | stream-end 事件 | 对 AccountPool 是事件源（上游），模型翻译点：bodyTail 文本 → limitKind 枚举 |

**翻译面**：Anti-Limit 把网页文案（中英文多模式）翻译成 `limitKind` 枚举是唯一跨上下文模型转换点——误判控制集中在 `detectLimit` 的模式表（见 R4）。

---

## 5. 核心设计细节

### 5.1 账号状态机

```
              添加账号(login成功)                     
  (新增) ──────────────────► active ◄──── 解冻(cooldownUntil 到期)────┐
                                │ │                                  │
              quota 信号(二次确认)│ │ login 失效检测                    │
                                ▼ ▼                                  │
                            cooling  needs_login ── login 成功 ──► active
                                │        │                            │
                        captcha/用户禁用 │ login 超时(5min)            │
                                ▼        ▼                            │
                            disabled  disabled(可重新启用)             │
                                ▲____________________________________│
```

- **quota 二次确认**：同一账号 10 分钟内两次 quota 信号才进 cooling（防单次误判，R4）；
  首次信号只记录计数并**立即切换**到下一账号（不让单次疑似信号中断服务），该账号暂标 `suspect`
- **cooling 时长 = 指数退避（动态风控核心）**：解冻时间未知，退避序列
  `coolBaseMs × 2^(连续受限次数-1)`，封顶 `coolMaxMs`；探测成功 → 退避计数清零；
  探测再受限 → 计数 +1 继续退避。默认 5min → 10min → 20min → 40min → … → 6h 封顶
- **探测恢复（probe）**：cooling 到期后账号变为 `probing`（探测候选）——调度时与 active
  同等可用，但首个请求成功才正式回 active（清零退避）；再受限则立即回 cooling 并翻倍退避。
  恢复判定只信"一次真实请求成功"，**不做带外探测**（探测请求本身消耗风控预算且信号不可靠）
- **disabled**：captcha 或用户手动禁用；手动启用后回 needs_login 验证

### 5.2 调度算法（每次 streamAsk 前执行）

```
pickAccount(session?):
  1. session 已绑账号且该账号 active/probing → 粘性返回（保网页版历史；probing 顺带完成探测）
  2. active ∪ probing 账号中选 lastUsedAt 最旧者（轮转均衡；probing 到期即真实探测）
  3. 全部 cooling → 抛 429 语义错误（SSE content 提示最早退避到期时间——注意是
     "最早探测时间"而非"解冻时间"，动态风控下不承诺届时可用）
  4. 全 disabled/needs_login → 触发自动登录流程（D4）后重试一次
```

### 5.3 streamAsk 限流检测（driver 改造，已实现）

轮询循环内（`Promise.all` 并行探测 extractLast/generating/thinking，轮询周期减半）：

```
新回复文本稳定后：
  limit = detectLimit(finalText)        // 模式表：quota（含"服务器繁忙，请稍后再试"等动态文案）/ captcha / length

  误判防线（两层）：
  - 仅当新回复 <400 字符才检测（防正常长回复复述关键词误命中）
  - 仅在新回复实际出现（firstSeen）后检测（防把上一轮旧回复当信号）

  quota / captcha:
    emitEvent('stream-end', { streamId, ok: false, errorKind: kind })
    // 网关收到结构化信号后走 AccountPool 切换重试（§5.4），不把错误文本发给 DSH

  length（对话过长/上下文超限）:
    driver 内部迁移+摘要重试，不上报网关不切账号：
    1. digest = extractHistoryDigest(pageId)   // 最近 15 条消息、每条 150 字压缩
    2. newChat → 新会话
    3. 注入【之前的对话摘要】+ 原问题重发
    4. 重试预算 2 次；用尽 → ok:false 无 errorKind（网关按普通错误上报 DSH）
```

### 5.4 网关侧切换重试与 epoch 语义（已实现）

**切换重试循环**（单请求预算 `maxAccountSwitchesPerRequest=2`，防循环）：

```
streamAsk 返回 errorKind（结构化信号）:
  quota:
    1. poolMarkQuota(当前账号)   // 计数+调度绕开；确认窗口(10min)内二次 → cooling+指数退避
    2. next = poolPick()；无可用（全 cooling）→ SSE 返回 429 语义提示（最早探测时间）
    3. session.epoch = -1（强制下轮 recovery）+ poolMarkAccountSwitch
    4. rpc('streamAsk', { ...原参数, profile: next, reset: true })
    5. recovery 模式重建上下文（压缩最近 10 条对话灌入新账号会话）
  captcha:
    账号 disabled（转人工，/accounts/enable 重新启用）；同 quota 路径换号重试
  login:
    autoRelogin 开启 → 触发登录流程（§5.5）后重试；否则 SSE 返回登录指引
  成功（ok）:
    poolMarkOk → requestCount++ + lastUsedAt 落盘（accounts.json，防重启丢统计）
```

**epoch 语义**（会话上下文一致性核心）：

```
driverEpoch：全局代数，driver 进程 respawn 时递增
  ├─ 会话命中且 epoch 一致 → mode='delta'（网页版历史还在，只发增量）
  ├─ 会话命中但 epoch 失配 → mode='recovery'（网页历史随进程死亡，压缩重建）
  ├─ profile 切换 → driver 发 'channels-reset' 事件 → 网关全部会话 epoch=-1
  └─ 异常路径（rpc 失败/超时/切换账号）→ 该会话 epoch=-1（下轮强制 recovery）
```

### 5.5 自动登录流程

```
streamAsk 检测 needsLogin（或调度第 4 步）:
  1. state.autoRelogin=true 时: rpc('login', { profile: 目标账号, timeoutMs: 300000 })
     （复用 v1 handlers.login：开有头窗口 + 2s 轮询 + login-progress 事件）
  2. 登录期间该请求挂起等待（SSE 保持打开，超时 5 分钟）
  3. 成功 → 账号回 active → 重试原请求（recovery 模式）
  4. 超时 → 账号标 needs_login，SSE 返回明确指引文案
  并发约束：同时只允许一个登录窗口（登录互斥锁）
```

### 5.6 落盘格式（runtime/accounts.json）

```json
{
  "version": 1,
  "accounts": [
    { "name": "default",  "state": "cooling",  "addedAt": 1735000000000,
      "cooldownUntil": 1735000300000, "backoffCount": 2,
      "quotaHits": 3, "lastQuotaAt": 1735000000000,
      "lastUsedAt": 1735010000000, "requestCount": 412 }
  ]
}
```

不含密码/cookie/token（FF8 不变量）。登录态本体在各 profile 的 user-data-dir（Chrome 自管）。

### 5.7 新增/变更 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/setup` | 返回 settings.yaml 片段 + 检测 `~/.dsh/settings.yaml` 配置状态 |
| GET | `/accounts` | 账号列表（状态/冷却剩余/统计） |
| POST | `/accounts/add` | `{ name }` → 开有头登录窗口，成功后入池 |
| POST | `/accounts/disable` `/enable` `/remove` | 管理（remove 同时删 profile 目录，二次确认参数 `confirm: true`） |
| GET | `/health` | 升级：HTML 只读状态页（账号/通道/会话/最近切换事件，`Accept: application/json` 时仍返回 JSON） |

### 5.8 配置项变更

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `accountPool` | true | bool | false 时完全旁路（恒用 default，v1 行为，回退开关） |
| `maxAccounts` | 3 | 1-8 | 常驻浏览器实例上限（内存预算） |
| `accountIdleReapMs` | 30min | 5min-24h | 空闲账号 Chrome 进程回收（cookie 保留） |
| `autoRelogin` | true | bool | 会话失效自动弹登录窗口 |
| `quotaBackoffBaseMs` | 300000 | 1min-1h | 指数退避基数（动态风控：无固定解冻点，只能探测恢复） |
| `quotaBackoffMaxMs` | 21600000 | 30min-24h | 退避封顶（默认 6h） |
| `quotaConfirmWindowMs` | 600000 | 1min-1h | 二次确认窗口（窗口内二次受限才 cooling） |
| `maxAccountSwitchesPerRequest` | 2 | 1-5 | 单请求切换预算 |

---

## 6. 健身函数（可测试架构不变量）

| # | 不变量 | 度量/阈值 | 测量源 | 频率 | 失败响应 | 本地检查路径 |
|---|---|---|---|---|---|---|
| FF1 | 单账号零回归 | v1 会话测试 20/20 + 解析器 54/54 通过 | tests/ | 每次改动 | 阻断合并 | `node tests/` |
| FF2 | 账号 cookie 隔离 | 两账号通道提取的登录用户名不同 | /debug + 手工 | 每次账号改动 | 阻断 | `curl /accounts` + 页面查看 |
| FF3 | 切换延迟 | quota→新账号开始重试 ≤15s（实例常驻）/≤40s（冷启动） | 网关日志时间戳 | P0 验收 | 性能缺陷 | 日志 grep `切换账号` |
| FF4 | 切换不丢上下文 | 切换后首轮 mode 必为 recovery | 单测断言 | 每次 | 阻断 | tests/test-accounts.js |
| FF5 | 状态持久 | 网关重启后 cooling 退避到期时间/退避次数恢复误差 ≤2s | accounts.json 单测 | 每次 | 阻断 | tests/test-accounts.js |
| FF5b | 退避正确性 | 退避序列 = base×2^(n-1) 封顶 max；探测成功清零；再受限翻倍 | 单测断言 | 每次 | 阻断 | tests/test-accounts.js |
| FF6 | 资源上限 | 常驻 Chrome 数 ≤ maxAccounts | /health | 空闲回收定时器 | 告警日志 | `curl /health` |
| FF7 | OpenAI 契约不变 | DSH 冒烟（问答+工具调用各 1 轮）成功 | 手工 e2e | 每次发布前 | 阻断发布 | DSH 实测 |
| FF8 | 无凭据泄漏 | accounts.json 与全部日志 grep 不到 password/cookie/token 值 | 静态检查 | 每次 | 阻断 | `grep -r` 检查脚本 |

---

## 7. 交互风格决策（quota 压力下的同步 vs 探测）

DSH 请求是同步 SSE 长连接，quota 检测有两种交互风格：

| 方案 | 说明 | 判定 |
|---|---|---|
| **带内检测（选定）** | streamAsk 轮询循环顺带读 bodyTail（零额外请求） | 选中：零成本、信号即时报 |
| 带外探测 | 定时器开小号页面探测配额余量 | 拒绝：额外页面消耗、探测本身消耗额度、UI 改版脆弱 |
| 事件化 | 检测异步事件化，请求不等待 | 拒绝：quota 发生在请求中途，必须同步处置（切号重试） |

---

## 8. 风险登记册

| # | 风险 | 可能性 | 影响 | 缓解 | 触发重审 |
|---|---|---|---|---|---|
| R1 | 多账号同 IP 轮换触发 DeepSeek 风控/封号 | 中 | 高 | 默认串行使用（调度粘性）；切换加 2-5s 随机延迟；README 明示 ToS 风险自担 | 任何封号报告 |
| R2 | 多 Chrome 实例内存膨胀 | 中 | 中 | maxAccounts 上限 + 空闲回收 | /health 常驻内存 >1.5GB |
| R3 | 登录窗口打扰用户 | 高 | 低 | autoRelogin 可关；弹窗前日志预告；登录互斥（同时只一个） | — |
| R4 | detectLimit 误判正常回复为 quota | 中 | 中 | 仅匹配 bodyTail；二次确认机制（§5.1）；模式表集中维护 | 误切率 >1%/日 |
| R5 | 凭据泄露面扩大 | 低 | 高 | 设计红线：不存密码（D4）；accounts.json 无凭据（FF8） | 任何凭据入库的 PR |
| R6 | driver 多浏览器改造引入回归 | 中 | 中 | 分阶段（§9）：先切换单浏览器，再多实例并行 | FF1 失败 |
| R7 | 动态风控文案/行为变化：受限提示语改版、阈值收紧、退避期实际更长 | 中 | 中 | §0 原则：只信页面信号；模式表集中可热更；退避无上限假设（封顶 6h 后仍受限 → 账号实际上不可用，靠多账号池兜底）；/health 暴露各账号退避次数供人工判断 | 模式表匹配率下降（/health 统计）或退避封顶账号占比 >50% |

---

## 9. 分阶段交付

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P0** | AccountPool（状态机+指数退避+探测恢复+落盘+调度）+ streamAsk 带 quota 检测 + **单浏览器按 profile 切换**（切换=重启浏览器，3-8s 可接受）+ `/accounts` API + 网关切换重试 | FF1/4/5/5b/8；quota 场景手工 e2e |
| **P1** | 多 Chrome 实例常驻（Browser Farm）+ 切换零成本 + 自动登录 + `/setup` + `/health` HTML | FF2/3/6/7 |
| **P2** | 空闲实例回收调优 + 切换事件统计页 + README.en 同步 | FF6 长稳观测 |

---

## 10. 责任与后续检查

- **责任**：用户（跑 `node tests/` 与 DSH 冒烟）；spec 维护者（本文件，随实现偏差更新）
- **后续检查（≤2）**：
  1. 实现 P0 的 streamAsk 重试循环前，过一次退避/重试/熔断参数化评审（dependency-resilience 面：切换预算与冷却参数的耦合）
  2. 若未来有人提议"记住密码自动登录"，先做凭据存储安全评审（当前设计明确不做，R5 红线）

---

## 11. 稳定性加固（2026-08 完备性审计，已实现）

> 背景：v2 主体落地后做了一轮全链路审计与完备性复查，共修复 14 项问题
> （审计 9 项 + 完备性 5 项）。全部有回归测试锁定：
> `tests/test-audit-fixes.js`（26 断言）+ `tests/test-completeness.js`（35 断言）。

### 11.1 正确性修复（P0）

| # | 问题 | 修复 |
|---|------|------|
| A1 | 超时/异常时返回**上一轮旧回复**（新回复未出现却拿 lastText 兜底） | 新回复未出现 → 直接报错，绝不返回旧回复 |
| A2 | 流式 delta 按前缀切片增量（页面编辑旧文本时产生乱码增量） | 首 delta 发全量、后续从新回复自身差分，不做前缀切片 |
| A3 | profile 切换后旧会话残留 epoch → 上下文污染 | channels-reset 事件重置全部会话 epoch=-1，强制 recovery |
| A4 | stream:false 请求返回 SSE 文本流（违反 OpenAI 契约） | 非流式聚合为标准 chat.completion JSON |
| C1 | SSE 已开始后异常 → 连接悬挂（无 [DONE]、catch 补发头） | headersSent 检查；异常路径仍发 [DONE]；writeHead 恰好 1 次 |
| C2 | length 信号被当 quota 上报切账号（其实换号无用） | length 走 driver 内迁移+摘要重试（§5.3），不上报不切号 |
| C3 | epoch 失配仍发 delta → 网页版历史已丢、增量无意义 | 失配强制 recovery（§5.4 epoch 语义） |
| C4 | driver 卡死时流等待无限挂起（会话锁永久占用） | askOnce 兜底超时 20min，报错释放锁 |
| C5 | toolsText 超长（大工具集）→ 网页版发送失败 | 渐进降级：截断到 6000 字符 → 纯列表 → 仅计数 |

### 11.2 稳定性修复（P1）

| # | 问题 | 修复 |
|---|------|------|
| B1 | 多账号时 maxConcurrent>1 导致并发切 profile → 浏览器反复重启 | 多账号时信号量退化为 1（切 profile 需重启浏览器） |
| B2 | 客户端断开（DSH 取消）后浏览器仍在空转生成 | req.on('close') → rpc('streamStop') 停止页面生成 |
| B3 | 账号统计（requestCount/lastUsedAt）只在内存，重启归零 | poolMarkOk 时同步落盘 accounts.json |

### 11.3 性能优化（P2）

| # | 问题 | 修复 |
|---|------|------|
| D1 | 轮询串行探测三个 CDP 表达式 → 周期 3×350ms | Promise.all 并行，周期减半 |
| D2 | runtime-context 识别三条件 AND → approval=never 变体漏识别，真实用户问题被顶替 | 多特征任一命中；指纹计算排除 runtime-context（防漂移） |

### 11.4 已知未处理项（评估后接受）

- **重复指纹孤儿会话**：两个 DSH 会话首条 user 消息完全相同 → 指纹碰撞共享 sessionId。
  概率低；后果为上下文串扰但不崩溃；修复需引入更多熵（如消息时间戳），暂不引入。
