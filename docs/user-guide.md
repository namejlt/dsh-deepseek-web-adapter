# dsh-deepseek-web-adapter 使用教程

> 把 **DeepSeek 网页版（chat.deepseek.com）** 变成 DSH 的免 API Key 模型提供方。
> 本文档面向**使用者**；插件开发请看 [dsh-plugin-tutorial.md](dsh-plugin-tutorial.md) 与 [dsh-plugin-best-practices.md](dsh-plugin-best-practices.md)，发布请看 [publishing.md](publishing.md)。

---

## 目录

1. [它是什么，怎么工作的](#1-它是什么怎么工作的)
2. [环境要求](#2-环境要求)
3. [五分钟上手](#3-五分钟上手)
4. [四个模型怎么选](#4-四个模型怎么选)
5. [多账号与限流自动切换](#5-多账号与限流自动切换)
6. [日常运维（API 速查）](#6-日常运维api-速查)
7. [故障排查 FAQ](#7-故障排查-faq)
8. [卸载与数据清理](#8-卸载与数据清理)

---

## 1. 它是什么，怎么工作的

DeepSeek 网页版免费但没提供 API。本插件在你电脑上启动一个本地网关，用真实浏览器驱动网页版，对外伪装成标准的 OpenAI 兼容接口——DSH 以为自己在调一个普通模型，实际上回答来自网页版。

```
DSH ──OpenAI 兼容 API──▶ 本地网关(:5688) ──stdio RPC──▶ driver ──CDP──▶ Chrome ──▶ chat.deepseek.com
```

插件加载时网关自动拉起，卸载时自动回收，全程无需手动管理进程。

**能力一览：**

| 能力 | 说明 |
|---|---|
| 连续对话 | 网页版历史保持；超过轮数上限（默认 50）自动摘要迁移新会话 |
| 工具调用 | 网页版无原生 function calling，网关用提示工程 + 54 场景容错解析桥接，DSH 原生执行 |
| 会话亲和并发 | 指纹识别会话 → 专属浏览器通道；同会话串行、异会话并行 |
| 多账号池 | 每账号独立浏览器 profile，账号状态落盘（`accounts.json`，不含凭据） |
| 限流自动切换 | 网页版公平使用风控受限时，指数退避冷却 + 自动切换账号 + 压缩重建上下文 |
| 自动登录 | 会话失效自动弹登录窗口，完成后自动重试原请求 |

**安全边界（务必了解）：**

- 登录态保存在本机 `resources/runtime/profiles/` 浏览器目录，插件不上传任何数据
- `accounts.json` 只记录账号名/状态/统计，不含密码或 cookie
- 使用网页版驱动方式访问，请自行评估并遵守 DeepSeek 服务条款；账号风控/封禁风险自担

---

## 2. 环境要求

| 依赖 | 版本/说明 |
|---|---|
| Node.js | ≥ 18 |
| Chrome | 本机已安装（网关通过 CDP 驱动） |
| DSH | 已安装并能运行 `dsh` 命令 |
| pnpm | DSH 插件安装依赖（`dsh plugin` 底层转发） |

---

## 3. 五分钟上手

### 第 1 步：安装插件

```bash
dsh plugin --profile web add dsh-deepseek-web-adapter
# 或从 GitHub（npm 发布前）：
dsh plugin --profile web add github:你的用户名/dsh-deepseek-web-adapter
```

插件加载后网关自动启动（约 3-8 秒）。看到 DSH 终端输出 `DeepSeek 网页版网关已监听 5688` 即成功。

### 第 2 步：配置 DSH 模型提供方

编辑 `~/.dsh/settings.yaml`，在 `llm-pi-ai.providers: { ... }` 内加入：

```yaml
dsweb:
  {
    displayName: DeepSeek 网页版 (免 API),
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
        { id: deepseek-vision-reasoner, name: DeepSeek 识图+深度思考 }
      ]
  }
```

再在 `~/.dsh/.credentials.yaml` 加一行（任意值即可，网关不校验）：

```yaml
MOCK_LLM_KEY: sk-mock-any-value
```

DSH 配置热加载，模型选择器会立即出现「DeepSeek 网页版」。

### 第 3 步：登录 DeepSeek

浏览器打开：

```
http://127.0.0.1:5688/login
```

会弹出 Chrome 窗口，在其中登录 chat.deepseek.com。

> **务必勾选"保持登录 / 记住我"**——登录态持久保存在浏览器 profile 目录，关窗口、重启电脑都不丢（直到 DeepSeek 令牌过期）。

登录是否完成会自动检测，也可手动查：`http://127.0.0.1:5688/login-status`。

### 第 4 步：开始使用

DSH 模型选择器选 **DeepSeek 网页版**（快速/深度思考/智能搜索/专家/识图等 8 种组合），像普通模型一样对话即可。工具调用（读文件、执行命令等）由 DSH 原生执行，无需额外配置。

---

## 4. 八个模型怎么选

模式映射对齐 2026-08 页面改版——网页版为**三模式入口**（快速 / 专家 / 识图）+ 输入框下方 pill 开关，网关按模型幂等切换（先读模式/开关状态，不一致才点击）：

| 模式入口 | 可选 pill | 模型 ID | 名称 | 适用 |
|---|---|---|---|---|
| 快速 | — | `deepseek-chat` | DeepSeek 快速 | 日常问答、轻量任务，响应最快 |
| 快速 | 深度思考 | `deepseek-reasoner` | DeepSeek 深度思考 | 复杂推理、代码架构，质量高但更慢 |
| 快速 | 智能搜索 | `deepseek-search` | DeepSeek 智能搜索 | 需要联网查资料、时效性问题 |
| 快速 | 深度思考+智能搜索 | `deepseek-think-search` | DeepSeek 深度思考+搜索 | 复杂问题且需联网查证 |
| 专家 | — | `deepseek-expert` | DeepSeek 专家 | 专家能力（页面专家模式） |
| 专家 | 深度思考 | `deepseek-expert-reasoner` | DeepSeek 专家+深度思考 | 专家模式下的深度推理 |
| 识图 | — | `deepseek-vision` | DeepSeek 识图 | 图片理解 |
| 识图 | 深度思考 | `deepseek-vision-reasoner` | DeepSeek 识图+深度思考 | 图片深度分析 |

pill 开关由驱动自动操作，无需手动干预。若网页版再次改版导致 pill 找不到（日志出现 `pill not found`），可用**校准功能**录制兜底点击路径：

```bash
curl http://127.0.0.1:5688/calibrate/record   # 弹有头窗口，按提示点击模型切换处
# 点击完成后：
curl -X POST http://127.0.0.1:5688/calibrate/collect -d '{"pageId": "<record 返回的 ID>"}'
curl -X POST http://127.0.0.1:5688/calibrate/save -d '{"key": "deepseek-reasoner", "clicks": "<collect 结果>"}'
curl -X POST http://127.0.0.1:5688/calibrate/close -d '{"pageId": "<同上>"}'
```

---

## 5. 多账号与限流自动切换

### 5.1 为什么需要多账号

网页版有**公平使用动态风控**：无公开配额数值、无固定解冻时间，触发时机随负载与账号行为变化。单账号高频使用迟早受限。账号池让你在账号 A 受限时自动切到账号 B，服务不中断。

### 5.2 添加账号

```bash
# 添加账号（立即弹出该账号的登录窗口，5 分钟超时）
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"name": "acc2"}'
```

每个账号有独立的浏览器 profile（`runtime/profiles/<账号名>/`）。也可以直接用 URL 登录指定账号：

```
http://127.0.0.1:5688/login?profile=acc2
```

账号名规则：字母数字与 `-_`，≤ 32 字符。默认上限 3 个账号（`/config` 可调，最多 8）。

### 5.3 受限时会发生什么（重要：正确预期）

网关对风控的处理原则是**只信页面信号，不做数值推断**：

1. **首次受限信号**：账号仅标记 suspect，调度时暂时绕开，10 分钟内不再出现则照常
2. **二次确认**（10 分钟窗口内再次受限）：账号进入 cooling 冷却——指数退避，**5 分钟起步，每次翻倍，封顶 6 小时**
3. **到期探测**：冷却到期后账号转为 probing，由下一次真实请求探测；成功则恢复，失败则退避翻倍继续冷却
4. **请求中途受限**：自动切换下一个可用账号，用压缩历史重建上下文继续回答（每个请求最多切 2 次）
5. **全部账号受限**：该请求返回受限提示（含最早探测时间，但**不承诺解冻时刻**——这是风控的现实，不是 bug）

查看各账号状态与退避情况：

```bash
curl http://127.0.0.1:5688/accounts
```

返回示例：

```json
{
  "enabled": true,
  "total": 2,
  "accounts": [
    { "name": "default", "state": "active",  "backoffCount": 0, "quotaHits": 3, "requestCount": 412 },
    { "name": "acc2",    "state": "cooling", "backoffCount": 2, "cooldownRemainMs": 640000, "quotaHits": 5 }
  ]
}
```

### 5.4 账号状态说明

| 状态 | 含义 | 恢复方式 |
|---|---|---|
| `active` | 正常可用 | — |
| `cooling` | 确认受限，退避冷却中 | 到期自动转 probing |
| `probing` | 冷却到期，等待真实请求探测 | 下次请求自动探测 |
| `needs_login` | 登录失效 | 自动弹登录窗（autoRelogin 开启时），或手动 `/login?profile=` |
| `disabled` | 验证码/人工禁用 | 人工处理后 `/accounts/enable` |

### 5.5 注意：多账号时并发降为 1

当前为单浏览器架构：切换账号需重启浏览器（profile 隔离），因此**账号数 > 1 时全局并发退化为串行**，单账号时保持会话亲和并发不变。若你重度依赖并发子代理，建议单账号使用，或多账号仅作受限兜底。

### 5.6 关闭账号池（回到 v1 行为）

```bash
curl -X POST http://127.0.0.1:5688/config -H 'Content-Type: application/json' -d '{"accountPool": false}'
```

关闭后恒用 default 账号，受限时按退避策略重试，不切换。

---

## 6. 日常运维（API 速查）

网关地址 `http://127.0.0.1:5688`（端口可用环境变量 `DSWEB_PORT` 改）。

### 状态查看

```bash
curl http://127.0.0.1:5688/v1/models       # 模型列表（网关存活探测）
curl http://127.0.0.1:5688/health          # 全量状态：登录态/会话/通道/账号池/配置
curl http://127.0.0.1:5688/login-status    # 登录状态
curl http://127.0.0.1:5688/accounts        # 账号池详情（状态/退避/统计）
curl http://127.0.0.1:5688/debug           # 主页面 DOM 结构（选择器排查用）
```

### 运行时配置（POST /config，立即生效）

| 参数 | 取值（默认） | 说明 |
|---|---|---|
| `headless` | bool（false） | 无头模式；变更需重启网关并重新登录 |
| `maxConcurrent` | 1-5（2） | 全局并发生成上限 |
| `maxPages` | 1-8（4） | 浏览器通道数上限（满则驱逐最久空闲会话） |
| `maxTurnsPerChat` | 2-500（50） | 单网页会话轮数上限（超出自动迁移+摘要） |
| `accountPool` | bool（true） | 账号池开关 |
| `maxAccounts` | 1-8（3） | 账号数上限 |
| `autoRelogin` | bool（true） | 登录失效自动弹窗重试 |
| `quotaBackoffBaseMs` | 60s-1h（5min） | 风控退避基数 |
| `quotaBackoffMaxMs` | 30min-24h（6h） | 风控退避封顶 |

示例：

```bash
curl -X POST http://127.0.0.1:5688/config -H 'Content-Type: application/json' -d '{"maxConcurrent": 3, "quotaBackoffBaseMs": 300000}'
```

### 账号管理

```bash
curl -X POST http://127.0.0.1:5688/accounts/add    -d '{"name": "acc2"}'                    # 添加
curl -X POST http://127.0.0.1:5688/accounts/disable -d '{"name": "acc2"}'                   # 禁用
curl -X POST http://127.0.0.1:5688/accounts/enable  -d '{"name": "acc2"}'                   # 启用（需登录验证）
curl -X POST http://127.0.0.1:5688/accounts/remove  -d '{"name": "acc2", "confirm": true}'  # 删除（profile 目录保留）
```

> `remove` 只移出账号池，浏览器 profile 目录（登录态）保留在 `runtime/profiles/acc2/`，彻底删除请手动清理。`default` 账号不可删除（可禁用）。

### 重启网关

```bash
dsh plugin --profile web remove dsh-deepseek-web-adapter && dsh plugin --profile web add dsh-deepseek-web-adapter
```

---

## 7. 故障排查 FAQ

**Q: 模型选择器里没有 DeepSeek 网页版？**
检查 `settings.yaml` 缩进与 `providers` 层级；确认 `.credentials.yaml` 已加 `MOCK_LLM_KEY`；DSH 配置热加载，不行就重启 DSH。

**Q: 请求报错「login required / 请打开 /login」？**
DeepSeek 令牌过期。正常情况网关会自动弹登录窗口（`autoRelogin` 开启时），登录后原请求自动重试。若自动登录超时（5 分钟），手动打开 `http://127.0.0.1:5688/login` 登录即可。

**Q: 回答特别慢或提示「服务器繁忙」？**
大概率触发了公平使用风控。查 `/accounts` 看是否有账号 cooling。这是网页版风控，等退避到期自动探测恢复；多账号可自动切换，无需干预。

**Q: 回答内容串了别的会话？**
v2 已用会话亲和（指纹 + 专属通道）隔离。若仍出现，执行 `/health` 看 `sessions` 列表，确认各会话 pageKey 不同；并检查是否多账号模式下手工切换过 profile。

**Q: 深度思考/智能搜索切不过去（一直普通回答）？**
网页版 UI 改版导致 pill 识别失灵（日志可见 `pill not found`）。按 [第 4 节](#4-四个模型怎么选)录制校准兜底路径。

**Q: 网关起不来 / 端口冲突？**
5688 被占用时用 `DSWEB_PORT` 换端口（同时改 settings.yaml 的 baseURL）。查看 DSH 终端的网关日志定位。

**Q: 工具调用失败？**
网页版模型输出格式怪异时解析器可能失手（已有 54 场景容错）。重试一次通常可恢复；持续失败请到 [Issues](https://github.com/huermi/dsh-deepseek-web-adapter/issues) 附上模型原始输出反馈。

---

## 8. 卸载与数据清理

```bash
# 卸载插件（网关随之停止）
dsh plugin --profile web remove dsh-deepseek-web-adapter
```

残留数据（如需彻底清理）：

| 路径 | 内容 |
|---|---|
| `resources/runtime/profiles/` | 各账号浏览器 profile（登录态） |
| `resources/runtime/accounts.json` | 账号池状态 |
| `resources/runtime/calibration.json` | 校准数据 |
| `~/.dsh/settings.yaml` | `dsweb` provider 配置（手动删除） |
| `~/.dsh/.credentials.yaml` | `MOCK_LLM_KEY`（手动删除） |
