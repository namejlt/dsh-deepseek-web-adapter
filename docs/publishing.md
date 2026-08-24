# Beta 多站点 Web-to-OpenAI 网关：插件发布与分发指南

> 如何把 dsh-deepseek-web-adapter 发布出去，让别人一条命令装上。发布前请先读 [第 3 节：发布安全](#3-发布安全必读)。

---

## 目录

1. [分发渠道总览](#1-分发渠道总览)
2. [命名规则：能不能重名](#2-命名规则能不能重名)
3. [发布安全（必读）](#3-发布安全必读)
4. [发布到 npm（主渠道）](#4-发布到-npm主渠道)
5. [从 GitHub 分发（免 npm）](#5-从-github-分发免-npm)
6. [让别人发现你的插件](#6-让别人发现你的插件)
7. [版本更新流程](#7-版本更新流程)
8. [发布检查清单](#8-发布检查清单)

---

## 1. 分发渠道总览

DSH 插件本质是 **npm 包**（声明 `dsh.bundle` manifest），没有独立的插件注册中心：

| 渠道 | 安装方式 | 适用 |
|---|---|---|
| **npm registry**（主渠道） | `dsh plugin --profile web add dsh-deepseek-web-adapter` | 正式发布，最方便用户 |
| **GitHub 仓库** | `dsh plugin --profile web add github:user/repo` | 不想发 npm / 迭代快 |
| **GitHub tarball** | `dsh plugin --profile web add https://github.com/user/repo/archive/refs/tags/v1.0.0.tar.gz` | 锁定版本 |
| **本地路径** | `dsh plugin --profile web add ./path` | 开发调试 |

三种远程渠道可以并存：npm 发正式版，GitHub 发开发版，互不冲突。

---

## 2. 命名规则：能不能重名

**结论：npm 包名全局唯一，先到先得，不可以重名。** 但有三层命名要分清：

### 2.1 npm 包名（package.json 的 `name`）——全局唯一

这是 npm registry 的硬规则：全世界只能有一个 `dsh-deepseek-web-adapter`。发布时若已被注册会直接报 `403 Forbidden`。

检查名字是否可用：

```bash
npm view dsh-deepseek-web-adapter   # 404 = 可用；返回包信息 = 已被占用
```

> 本仓库写作时已验证：`dsh-deepseek-web-adapter` **尚未被注册，可以直接发布**。建议尽早占位。

**名字被占用时的两种解法：**

1. **换名**：加前缀/后缀，如 `dsh-dwwpseek-web-adapter`、`dsh-deepseek-web-adapter-pro`
2. **Scoped 包（推荐）**：`@你的用户名/dsh-deepseek-web-adapter`——scope 归你所有，永无冲突，且用户安装时 `dsh plugin --profile web add @你的用户名/dsh-deepseek-web-adapter` 一样方便

### 2.2 命名惯例与保留字

- 社区惯例用 `dsh-` 前缀便于检索识别（非强制，但强烈建议）
- **`@deepseek-ai/*` 是官方命名空间，不要使用**
- 名字一旦发布并被用户安装，改名代价很高（老用户找不到更新），发布前想清楚

### 2.3 cordis.patch.yml 的 `id`——仅本机唯一

```yaml
- insert:
  - id: dsweb-adapter            # 只需在该用户的 DSH 配置树内不与其他插件冲突
    name: dsh-deepseek-web-adapter  # 必须与 package.json 的 name 一致（Loader 按此 import）
```

`id` 与别人的插件重名无所谓（不同用户互不影响），但 `name` 改了必须同步改这里。

---

## 3. 发布安全（必读）

**npm pack 不理会 .gitignore**，只看 package.json 的 `files` 字段。本仓库 `resources/runtime/` 在运行后会产生：

| 文件/目录 | 内容 | 发布处理 |
|---|---|---|
| `profiles/` | 各账号浏览器 profile，**含登录 cookie**（30MB+） | **必须排除** |
| `accounts.json` | 账号池状态 | 排除 |
| `*.log` | 运行日志 | 排除 |
| `driver.js` | driver 单一源码（`resources/driver.js`，网关运行时直接执行；本地数据经 `DS_WEB_BASE` 落在 `resources/runtime/`） | **必须保留** |
| `calibration.json` | 内置模式/开关校准数据 | **必须保留** |

package.json 已按此配置（`!` 为排除模式）：

```json
"files": [
  "lib/",
  "resources/",
  "!resources/runtime/profiles",
  "!resources/runtime/*.log",
  "!resources/runtime/accounts.json",
  "cordis.patch.yml",
  "README.md",
  "README.en.md",
  "tests/"
]
```

每次发布前用 dry-run 验证清单，**确认没有 profiles / .log / accounts.json**：

```bash
npm pack --dry-run
```

---

## 4. 发布到 npm（主渠道）

### 4.1 准备

```bash
# 1. 注册 npm 账号（https://www.npmjs.com/signup）并开启 2FA
npm login

# 2. 确认登录身份
npm whoami
```

### 4.2 发布前验证

```bash
# 语法检查
node --check lib/index.js
node --check resources/dsweb-gateway.js
node --check resources/driver.js

# 既有回归
node tests/test-parser-all.js
node tests/test-account-pool.js
node tests/test-completeness.js

# 多站点 provider 离线测试（registry / driver / gateway 路由）
node tests/test-provider-registry.js
node tests/test-driver-providers.js
node tests/test-gateway-providers.js

# 打包清单验证（确认无凭据泄漏，见第 3 节）
npm pack --dry-run
```

### 4.2.1 多站点 Beta 的已认证手工 smoke test（发布前必做）

离线 provider tests 不能证明真实网页登录态、挑战页或页面交互可用。发布前，在**已认证/已登录**的本机 profile 中逐项手工验收；完成前不得声称“live verified”：

1. 分别打开并完成登录：`/login?provider=deepseek`、`/login?provider=chatgpt`、`/login?provider=qwen`。
2. 用 `GET /v1/models` 确认包含 `chatgpt-auto`、`chatgpt-thinking`、`qwen-chat`、`qwen-thinking`、`qwen-search`。
3. 每个 provider 至少验证一条短文本、一段代码请求和一个 SSE 流完成；确认 profile/cookie 没有跨 provider 复用。
4. 验证 Qwen 无法切换 thinking/search 时返回 `mode_unavailable`；验证 ChatGPT challenge 返回需要人工操作的 provider 错误，而不是 DOM 错误。不要自动解题或绕过 challenge。
5. 在发布记录中写明测试日期、已验收 provider、登录账号类型（不要写 cookie/账号标识）与未验收项。

### 4.3 发布

```bash
npm publish
# scoped 包首次发布需公开声明：
npm publish --access public
```

### 4.4 验证

```bash
# 换个目录，像真实用户一样安装
dsh plugin --profile web add dsh-deepseek-web-adapter
# 重启 DSH，确认网关拉起、模型出现、能登录对话
```

---

## 5. 从 GitHub 分发（免 npm）

仓库推到 GitHub 后，用户无需你发布 npm 即可安装：

```bash
# 方式一：仓库引用（跟踪默认分支）
dsh plugin --profile web add github:namejlt/dsh-deepseek-web-adapter

# 方式二：tag tarball（锁版本，社区常用）
dsh plugin --profile web add https://github.com/namejlt/dsh-deepseek-web-adapter/archive/refs/tags/v1.0.0.tar.gz

# 方式三：git 协议
dsh plugin --profile web add git+https://github.com/namejlt/dsh-deepseek-web-adapter.git
```

打 tag 即发版：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

注意：`resources/runtime/` 下产生的 profiles/日志已在 `.gitignore` 排除，但要防止有人误提交（合 PR 时留意）。

---

## 6. 让别人发现你的插件

发布只是第一步，分发渠道决定能不能被找到：

| 渠道 | 做法 |
|---|---|
| **GitHub Topic `dsh-plugin`** | 官方约定的发现入口：仓库加 topic `dsh-plugin`，会被聚合展示（github.com/topics/dsh-plugin） |
| **awesome-dsh-plugin 精选列表** | 提 PR 添加 `data/plugins/<owner>__<repo>.yml`（含 url/name/category/description），人工审核收录 |
| **dsh-market 插件市场** | DSH 内置市场插件（`dsh plugin --profile web add dshmarket`），收录 awesome 列表内容，用户一键安装 |
| **README 互链** | 在仓库 README 醒目位置放一行安装命令（本仓库已做） |

最低成本组合：**GitHub topic + awesome-dsh-plugin PR**，两个都是一次性动作。

---

## 7. 版本更新流程

```bash
# 1. 改动完成，回归全绿
node tests/test-parser-all.js && node tests/test-account-pool.js && node tests/test-completeness.js && node tests/test-provider-registry.js && node tests/test-driver-providers.js && node tests/test-gateway-providers.js

# 2. 语义化版本（SemVer）：
#    补丁 z：bug 修复（1.0.0 → 1.0.1）
#    次版本 y：新功能，向后兼容（1.0.0 → 1.1.0）
#    主版本 x：破坏性变更（1.0.0 → 2.0.0）
npm version patch   # 或 minor / major

# 3. 发布
npm publish

# 4. 同步 GitHub tag
git push --follow-tags
```

用户侧更新：

```bash
dsh plugin --profile web update
```

**上游兼容性**：DSH 处于开发者预览期，可能有破坏性变更。README 中注明已验证的 DSH 版本范围，上游大版本发布后及时回归。

---

## 8. 发布检查清单

- [ ] `npm view <name>` 确认包名可用（或已属于你）
- [ ] 回归与 provider 测试全绿：`test-parser-all.js`、`test-account-pool.js`、`test-completeness.js`、`test-provider-registry.js`、`test-driver-providers.js`、`test-gateway-providers.js`
- [ ] `node --check` 三个主文件语法通过
- [ ] `resources/driver.js` 为唯一 driver 源码，网关 `DRIVER_PATH` 直接指向它（`resources/runtime/driver.js` 副本已移除，无需同步）
- [ ] `npm pack --dry-run` 清单中**无** `profiles/`、`*.log`、`accounts.json`
- [ ] package.json：`type: "module"`、`main`、`files`、`keywords` 含 `dsh-plugin`
- [ ] `cordis.patch.yml` 的 `name` 与 package.json 一致
- [ ] README（中英）安装命令与实际包名一致
- [ ] 版本号符合 SemVer
- [ ] 已认证手工 smoke test：分别登录 DeepSeek/ChatGPT/Qwen → 模型列表 → 文本/代码/SSE；记录未验收项，未完成时不得宣称 live verified
