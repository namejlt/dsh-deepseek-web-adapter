# dsh-deepseek-web-adapter：Beta 多站点 Web-to-OpenAI 网关使用教程

> 把已登录的 **DeepSeek、ChatGPT 与 Qwen 网页版** 接到 DSH 的本地 **Beta Web-to-OpenAI** 网关。多站点实现已落地并有离线测试，真实已登录账号的手工验收仍待完成；本文不宣称已完成在线验证。
> 本文档面向**使用者**；插件开发请看 [dsh-plugin-tutorial.md](dsh-plugin-tutorial.md) 与 [dsh-plugin-best-practices.md](dsh-plugin-best-practices.md)，发布请看 [publishing.md](publishing.md)。

---

## 目录

1. [它是什么，怎么工作的](#1-它是什么怎么工作的)
2. [环境要求](#2-环境要求)
3. [五分钟上手](#3-五分钟上手)
4. [支持的模型与 Beta 边界](#4-支持的模型与-beta-边界)
5. [Provider 隔离的多账号与限流自动切换](#5-provider-隔离的多账号与限流自动切换)
6. [日常运维（API 速查）](#6-日常运维api-速查)
7. [故障排查 FAQ](#7-故障排查-faq)
8. [卸载与数据清理](#8-卸载与数据清理)

---

## 1. 它是什么，怎么工作的

这是一个本地 **Beta 多站点 Web-to-OpenAI 网关**：DSH 调用标准 OpenAI 兼容接口，本机网关再以独立 Chrome profile 驱动你已手工登录的 DeepSeek、ChatGPT 或 Qwen 网页版。

```
DSH ──OpenAI 兼容 API──▶ 本地网关(:5688) ──stdio RPC──▶ driver ──CDP──▶ Chrome profiles ──▶ DeepSeek / ChatGPT / Qwen Web
```

插件加载时网关自动拉起，卸载时自动回收；provider 路由、profile 隔离与离线测试已经实现，但**真实已登录账号的手工验收尚未完成**。

**Beta 能力边界（务必了解）：**

| 项目 | 当前承诺 |
|---|---|
| 支持 | 文本、代码块、基础 SSE、既有文本工具调用协议 |
| 不支持 | 附件、图像或其他多模态输入；网页原生工具卡片、trace、iframe、native artifacts（原生产物）语义 |
| 挑战 | 不自动求解或绕过 CAPTCHA、Cloudflare、Turnstile 或其他 challenge |
| 隔离 | provider 间独立 profile / cookie / 会话，不能跨站复用 |

**安全边界：**登录态仅保存在本机 `resources/runtime/profiles/`；请只使用有权使用的账号，并自行遵守各站服务条款。

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
        { id: qwen-auto, name: Qwen 自动（Beta） },
        { id: qwen-thinking, name: Qwen 思考（Beta） },
        { id: qwen-fast, name: Qwen 快速（Beta） },
        { id: qwen-auto-max, name: Qwen 自动 Max（Beta） },
        { id: qwen-thinking-max, name: Qwen 思考 Max（Beta） },
        { id: qwen-fast-max, name: Qwen 快速 Max（Beta） }
      ]
  }
```

再在 `~/.dsh/.credentials.yaml` 加一行（任意值即可，网关不校验）：

```yaml
MOCK_LLM_KEY: sk-mock-any-value
```

DSH 配置热加载，模型选择器会立即出现 DeepSeek 既有模型与 ChatGPT/Qwen Beta 模型。

### 第 3 步：分别手工登录三个 provider

在本机 Chrome 中分别完成登录；每条链接打开的 profile 都独立：

```text
http://127.0.0.1:5688/login?provider=deepseek   # deepseek-default
http://127.0.0.1:5688/login?provider=chatgpt    # chatgpt-default
http://127.0.0.1:5688/login?provider=qwen       # qwen-default
```

省略 `provider` 的 `/login` 仍默认 DeepSeek，以兼容旧用法。不要复制或共享三个 provider 的 profile 目录。

ChatGPT 若出现 Cloudflare、Turnstile 或其他 challenge，网关返回需要**手动操作**的 `challenge_required`/`provider_challenge_required` 错误；它与 DOM 选择器错误不同，网关不会自动解题或绕过。Qwen thinking/search 不可用时返回 `mode_unavailable`，不会静默改用错误模式。

### 第 4 步：开始使用

在 DSH 模型选择器中选择 **Beta 多站点 Web-to-OpenAI** 下的模型即可。DeepSeek 保持既有能力；ChatGPT/Qwen 只承诺文本、代码块与基础 SSE。工具调用（读文件、执行命令等）仍由 DSH 原生执行，无需额外配置。

---

## 4. 支持的模型与 Beta 边界

| Provider | 模型 ID | Beta 行为 |
|---|---|---|
| DeepSeek | 既有 `deepseek-*` 八种组合 | 保持已有快速/思考/搜索/专家/识图能力 |
| ChatGPT | `chatgpt-auto`、`chatgpt-thinking` | 文本、代码块、基础 SSE；thinking 仅在可靠控件可用时启用 |
| Qwen | `qwen-auto`、`qwen-thinking`、`qwen-fast`、`qwen-auto-max`、`qwen-thinking-max`、`qwen-fast-max` | 文本、代码块、基础 SSE；模式开关不可用时返回 `mode_unavailable` |

请不要把该 Beta 通道用于附件、多模态输入、网页原生 artifact、iframe/web-dev 产物或挑战求解。ChatGPT challenge 必须由人在浏览器中完成；错误会明确提示手动登录路径，而不是伪装成 DOM 问题。

## 5. Provider 隔离的多账号与限流自动切换

### 5.1 为什么需要多账号

网页版有**公平使用动态风控**：无公开配额数值、无固定解冻时间，触发时机随负载与账号行为变化。单账号高频使用迟早受限。账号池让你在账号 A 受限时自动切到账号 B，服务不中断。

### 5.2 添加账号

```bash
# 添加账号（立即弹出该账号的登录窗口，5 分钟超时）
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"name": "acc2"}'
```

账号池状态也按 provider 隔离：ChatGPT/Qwen 的 quota、cooling、登录失效不会冷却或禁用同名的 DeepSeek/Qwen/ChatGPT 账号。DeepSeek 的历史账号名和 `default` profile 保持兼容。

每个 provider 账号有独立的浏览器 profile（`runtime/profiles/<provider>-<账号名>/`）。也可以直接用 URL 登录指定账号：

```
# 保持旧 DeepSeek 入口兼容
http://127.0.0.1:5688/login?profile=acc2

# ChatGPT/Qwen 指定 provider；账号池 API 同样接受 provider 字段
http://127.0.0.1:5688/login?provider=qwen&profile=acc2
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"provider":"qwen","name":"acc2"}'
```

账号名规则：字母数字与 `-_`，≤ 32 字符。默认每个 provider 上限 3 个账号（`/config` 可调，最多 8）。

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

## 5.6 Web Provider Console（5688 管理页）

打开 `http://127.0.0.1:5688/` 后，首页会并列展示 DeepSeek、ChatGPT、Qwen 三张 provider 卡片。每张卡片显示默认 profile、模型数量、登录/challenge 状态与该 provider 的账号池摘要；点击卡片后，详情区只显示该 provider 的模型和账号。

- ChatGPT 的 challenge 会显示“在浏览器中完成 challenge”，不会伪装成普通 DOM 错误。
- Qwen/ChatGPT 的新增、登录、启用、禁用、删除账号操作都会发送对应的 `provider` 参数，不会误操作 DeepSeek 账号。
- 管理页优先选择需要人工操作的 provider；没有待办时默认显示 DeepSeek。
- `GET /providers` 返回管理页使用的三端聚合 JSON，包含 `status`、`action`、`models`、`defaultProfile`、`login` 与 provider 维度账号摘要。

```bash
curl http://127.0.0.1:5688/providers
curl -X POST http://127.0.0.1:5688/accounts/add -d '{"provider":"qwen","name":"acc2"}'
```

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
网页版 UI 改版导致 pill 识别失灵（日志可见 `pill not found`）。按 [第 4 节](#4-八个模型怎么选)录制校准兜底路径。

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