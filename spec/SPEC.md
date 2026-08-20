# dsh-deepseek-web-adapter — 开发规格文档 (Spec)

## 1. 项目概述

### 1.1 项目定位
`dsh-deepseek-web-adapter` 是一个 **Cordis 插件**，用于将 **DeepSeek 网页版（chat.deepseek.com）** 伪装成标准的 OpenAI 兼容 LLM 提供方，供 DSH（DeepSeek Harness）使用。**无需 API Key**，只需用户登录自己的 DeepSeek 账号即可。

### 1.2 核心价值
- 零成本使用 DeepSeek 模型（V3/R1/视觉模型）
- 一条命令安装，网关自动启停
- 完整的工具调用（Tool Calling）能力
- 多模型模式（快速/专家/识图）支持
- 子 Agent 并发（多窗口并行）

### 1.3 技术栈
| 技术 | 说明 |
|------|------|
| 运行环境 | Node.js 18+ |
| 浏览器 | Chrome/Edge（通过 CDP 协议控制） |
| 插件框架 | Cordis (DSH 插件系统) |
| 通信协议 | JSON-lines RPC over stdio (插件 ⇄ driver) |
| API 协议 | OpenAI Chat Completions 兼容 (SSE 流式) |
| 浏览器控制 | 手写 CDP over WebSocket（零第三方依赖） |

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DSH (Cordis Host)                                                      │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  pi-ai Provider (dsweb)                                           │  │
│  │  baseURL: http://127.0.0.1:5688/v1/                               │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                              │ HTTP (SSE)                               │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  lib/index.js (Host Plugin)                                       │  │
│  │  - apply() → 加载时 spawn 网关                                    │  │
│  │  - ctx.effect() → 卸载时 kill 网关                                │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                              │ spawn                                    │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│  resources/dsweb-gateway.js (网关进程 :5688)                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  HTTP API 层                                                      │  │
│  │  POST /v1/chat/completions  → OpenAI 兼容 SSE 流式               │  │
│  │  GET  /v1/models             → 模型列表                           │  │
│  │  GET  /login                 → 有头登录（自动检测完成）            │  │
│  │  GET  /login-status          → 登录状态                           │  │
│  │  POST /calibrate/*           → 模型校准（录制/回放/保存）          │  │
│  │  POST /config                → 运行时配置                         │  │
│  │  GET  /debug                 → DOM 诊断                           │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                              │ stdio JSON-lines RPC                     │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  并发信号量 (maxConcurrent)                                       │  │
│  │  提示词组装 (buildContext / buildToolsText)                        │  │
│  │  SSE 输出 (sseHeaders / sseChunk)                                 │  │
│  │  WorkBuddy 落盘模式 (本地文件通信)                                 │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                              │ spawn                                    │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│  resources/driver.js (浏览器引擎进程)                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  RPC 层 (JSON-lines over stdio)                                   │  │
│  │  handlers: ping/health/config/start/status/result/wait/stop       │  │
│  │           login/inspect/streamAsk/streamStop                      │  │
│  │           calibrateRecord/calibrateCollect/calibrateClose/         │  │
│  │           calibrateSave/calibrateApply/openWindow/shutdown        │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  CDP Client (自实现 WebSocket RFC6455)                            │  │
│  │  - wsConnect() → CdpClient → call(method, params)                 │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  浏览器生命周期管理 (browser)                                       │  │
│  │  - launchBrowser(profile) → 单一常驻 Chrome 实例                  │  │
│  │  - closeBrowser() → 清理进程                                      │  │
│  │  - 页面管理: newPage/closePage/navigate/waitReady                  │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  DOM 表达式引擎 (EXPR)                                            │  │
│  │  - messageCount / extractLast / generating                        │  │
│  │  - findInput / clickSend / clickNewChat                           │  │
│  │  - loginState / buttons / modelBadge / bodyTail / domDebug        │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  工具调用解析器 (parseToolCalls)                                   │  │
│  │  - 多层容错: JSON 修复 / 平衡括号提取 / 参数别名 /                 │  │
│  │    schema 推断 / Python 函数格式 / 安全网重试                       │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  反限制引擎 (Anti-Limit Engine)                                   │  │
│  │  - 上下文压缩 (compactStr / buildDigest)                          │  │
│  │  - 会话迁移 (chat migration)                                      │  │
│  │  - 账号轮换 (profile rotation)                                    │  │
│  │  - 配额退避 (quota backoff)                                       │  │
│  │  - 验证码检测 (captcha detection)                                  │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  任务管理器 (tasks Map)                                            │  │
│  │  - makeTask / runTask / schedule                                  │  │
│  │  - 单页常驻 + 子页面池 (subPages)                                  │  │
│  │  - 工具执行 (read_file/write_file/run_command 等 14 个工具)        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │ CDP (WebSocket)                          │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Chrome / Edge      │
                    │  (chat.deepseek.com)│
                    └─────────────────────┘
```

### 2.2 进程通信模型

```
Host Plugin (lib/index.js)
    │
    │ spawn
    ▼
Gateway (dsweb-gateway.js)  ←── HTTP ── DSH pi-ai Provider
    │
    │ spawn (stdio pipe)
    ▼
Driver (driver.js)  ←── CDP (WebSocket) ── Chrome/Edge
```

关键设计原则：
1. **单一常驻浏览器**：绝不因 headless 参数差异重建 Chrome（重建 = 会话 cookie 丢失）
2. **每请求独立 Page**：并发请求用独立页面（多窗口并行），单页常驻用于连续对话
3. **JSON-lines RPC**：Gateway 与 Driver 之间通过 stdio 管道传递 JSON 行进行 RPC 通信

---

## 3. 模块详细设计

### 3.1 lib/index.js — Host 插件

**职责**：DSH 插件生命周期管理，自动拉起/回收网关进程。

**关键函数**：

| 函数 | 说明 |
|------|------|
| `gatewayAlive()` | 通过 `/v1/models` 健康检查检测网关存活 |
| `waitGatewayReady(timeoutMs)` | 轮询等待网关就绪（每秒一次） |
| `doEnsureGateway()` | 启动网关子进程，等待就绪，超时 25s |
| `ensureGateway()` | 单例保证（防重复启动） |
| `stopGateway()` | 停止网关子进程 |
| `apply(ctx)` | Cordis 入口：加载时启动，卸载时停止 |

**配置常量**：
- `GATEWAY_PORT = 5688` — 网关监听端口
- `RESOURCES_DIR` — 资源目录
- `GATEWAY_FILE` — 网关入口文件
- `BASE_DIR` — 运行时目录 (resources/runtime/)

**启动参数**：
```
node dsweb-gateway.js --port 5688 --base resources/runtime
```

---

### 3.2 resources/dsweb-gateway.js — 核心网关

**职责**：提供 OpenAI 兼容 API，管理 Driver 进程，提示词组装，工具调用格式化。

#### 3.2.1 HTTP API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 返回模型列表（deepseek-chat/reasoner/vision） |
| POST | `/v1/chat/completions` | OpenAI 兼容流式/非流式聊天 |
| GET | `/login` | 打开有头浏览器窗口登录 |
| GET | `/login-status` | 查询登录状态 |
| POST | `/calibrate/record` | 开始模型校准录制 |
| POST | `/calibrate/collect` | 收集录制结果 |
| POST | `/calibrate/close` | 关闭校准窗口 |
| POST | `/calibrate/save` | 保存校准数据 |
| POST | `/calibrate/apply` | 回放校准数据 |
| GET | `/calibrate/list` | 列出校准数据 |
| POST | `/config` | 读写运行时配置 |
| GET | `/debug` | DOM 诊断信息 |

#### 3.2.2 模型定义

```javascript
MODELS = {
  'deepseek-chat':    { name: 'DeepSeek 快速', mode: 'quick',  deepThink: false },
  'deepseek-reasoner': { name: 'DeepSeek 专家', mode: 'expert', deepThink: true  },
  'deepseek-vision':  { name: 'DeepSeek 识图', mode: 'vision', deepThink: false },
}
```

#### 3.2.3 核心流程

**Chat Completion 处理流程**：
```
1. 解析请求 payload（model/messages/tools/stream）
2. 获取并发信号量（acquireSem）
3. 组装上下文（buildContext）— 只发增量（最后一条消息）
4. 组装工具提示词（buildToolsText）— 提示工程让模型输出 tool_call
5. 调用 Driver RPC streamAsk
6. 建立 SSE 消费者（makeConsumer）
7. 流式输出:
   - 首 chunk: delta.role = 'assistant'
   - 内容 chunk: delta.content（每次 120 字符）
   - 工具调用 chunk: delta.tool_calls（分段 60 字符）
   - 结束 chunk: finish_reason = 'stop' | 'tool_calls'
   - 终止: data: [DONE]
8. 释放信号量
```

**会话管理策略**：
- `shouldResetChat(payload)`: 如果最后 3 条消息不含 tool 角色 → 新会话（newChat）
- 否则连续对话（网页版保持历史）

**WorkBuddy 落盘模式**：
- 特殊模型 `workbuddy-agent` 走文件通信
- 请求写入 `mock-api/requests/`，响应从 `mock-api/responses/` 读取
- 超时 900s

#### 3.2.4 运行时状态

```javascript
state = {
  headless: false,          // 无头模式
  maxConcurrent: 2,         // 最大并发数
  maxTurnsPerChat: 50,      // 每次会话最大轮数
}
```

---

### 3.3 resources/driver.js — 浏览器引擎

**职责**：通过 CDP 协议控制 Chrome/Edge，实现网页版交互自动化。

#### 3.3.1 自实现组件

| 组件 | 说明 |
|------|------|
| WebSocket Client | 手写 RFC6455 实现（wsConnect/makeWsClient） |
| CDP Client | Chrome DevTools Protocol 封装（CdpClient.call） |
| RPC 框架 | JSON-lines over stdio（pending Map + seq 机制） |

#### 3.3.2 浏览器生命周期

**launchBrowser(profile)**：
- 查找 Chrome/Edge 路径（按平台搜索）
- 以 `--remote-debugging-port=0` 启动（动态端口）
- 读取 `DevToolsActivePort` 获取 CDP 地址
- 通过 WebSocket 连接 CDP
- 单一常驻：同 profile 复用，不因 headless 差异重建

**Chrome 启动参数**：
```
--user-data-dir=<profileDir>
--remote-debugging-port=0
--no-first-run
--no-default-browser-check
--disable-blink-features=AutomationControlled
--disable-background-networking
--disable-component-update
--disable-sync
--disable-extensions
--disable-features=Translate,OptimizationHints,msEdgeSidebarV2
--window-size=1280,900
[--headless=new]
```

#### 3.3.3 页面管理

| 函数 | 说明 |
|------|------|
| `newPage(opts)` | 创建新 Tab（可选 newWindow） |
| `closePage(pageId)` | 关闭 Tab（保活：无页面时补 about:blank） |
| `navigate(pageId, url)` | 导航到 URL |
| `waitReady(pageId, timeoutMs)` | 等待页面加载完成 |
| `evalJs(pageId, expression)` | 在页面中执行 JavaScript |
| `waitFor(pageId, expression, timeoutMs)` | 轮询等待条件满足 |

#### 3.3.4 DOM 表达式引擎 (EXPR)

所有 DOM 操作通过 `evalJs` 注入 JavaScript 表达式执行，主要表达式：

| 表达式 | 用途 | 容错策略 |
|--------|------|----------|
| `messageCount` | 获取消息数量 | 多选择器 fallback |
| `extractLast` | 提取最后一条助手回复 | 多选择器 + 文本提取（保留代码块格式） |
| `generating` | 检测是否正在生成 | Stop 按钮 + loader 检测 |
| `findInput` | 查找输入框 | textarea + contenteditable |
| `clickSend` | 点击发送按钮 | 多选择器 + 禁用状态检测 |
| `clickNewChat` | 点击新建对话 | 多选择器（中英文） |
| `loginState` | 检测登录状态 | URL + body + password input |
| `buttons` | 获取页面按钮列表 | 去重 + 可见性过滤 |
| `modelBadge` | 获取当前模型标识 | 多选择器 + 文本匹配 |
| `bodyTail` | 获取页面尾部文本 | 用于限制检测 |
| `domDebug` | DOM 诊断信息 | class 频率统计 + input 信息 |

#### 3.3.5 发送消息流程

```
sendMessage(pageId, text):
  1. findInput → 确定输入框类型（textarea / contenteditable）
  2. 清空 + 输入:
     - contenteditable: execCommand('insertText')
     - textarea: 原生 setter + dispatchEvent('input'/'change')
  3. 等待 React 更新按钮状态 (350ms)
  4. 点击发送按钮 (clickSend)
  5. 兜底: CDP Input.dispatchKeyEvent('Enter')
```

#### 3.3.6 回复等待与提取

```
waitForResponse(state, timeoutMs, stableDelayMs):
  1. 等待新消息出现（messageCount 变化，最多 15s）
  2. 轮询 extractLast 直到文本稳定（stableDelayMs 无变化）
  3. 确认 generating 为 false
  4. cleanText 清理（去除 thinking 块、操作按钮文本等）
```

#### 3.3.7 工具调用解析器 (parseToolCalls)

**设计原则**：DeepSeek 网页版无原生 function calling，通过提示工程让模型输出 `tool_call` JSON，再经多层容错解析。

**解析策略（按优先级）**：

| 策略 | 匹配模式 | 容错 |
|------|----------|------|
| 1. tool_call 前缀 | `tool_call\n{...}` | JSON 修复 |
| 2. ```tool_call 代码块 | ` ```tool_call {...} ``` ` | JSON 修复 |
| 3. ```json 代码块 | ` ```json {...} ``` ` | 标准 JSON |
| 4. ``` 无标注代码块 | ` ``` {...} ``` ` | JSON 修复 |
| 5. `<tool_call>` XML 标签 | `<tool_call>{...}</tool_call>` | 贪婪匹配到最后一个 `}` |
| 6. 平衡括号提取 | 从后往前扫描所有 `{...}` | schema 推断工具名 |
| 7. Python 函数格式 | ` ```write(path="a.txt", content="hi")``` ` | 参数解析 |

**JSON 容错修复 (jsonParseTolerant)**：
1. 标准 JSON.parse
2. 修复单反斜杠（Windows 路径 `\U` → `\\U`）
3. 移除尾逗号 `,}` → `}`
4. 补未加引号的 key `{key:` → `{"key":`

**工具名推断 (matchToolByParams)**：
- 按 schema 参数 `properties` 的 key 匹配
- 参数别名：`path→file_path`, `file→file_path`, `cmd→command`, `text→content`
- 评分机制：原样命中 +2，别名命中 +2，未知 key -1.5
- 专一性加成：`file_path` 单参数 → `read_image`（最专一）优先

**安全网重试 (looksLikeToolCall)**：
- 检测文本是否"看起来像工具调用但没被解析"
- 触发条件：含 `tool_call` 标记 / `"name"` 键 / 代码块函数调用 / 已知工具名
- 最多重试 2 次，发送纠正提示

#### 3.3.8 反限制引擎 (Anti-Limit Engine)

**限制类型检测**：

| 类型 | 检测模式 | 处理策略 |
|------|----------|----------|
| length（长度限制） | 对话超长/上下文超限 | 压缩上下文 + 迁移到新会话 |
| quota（配额限制） | 当日次数用完/频率限制 | 账号轮换 / 退避重试 |
| captcha（验证码） | 人机验证/Cloudflare | 终止任务，通知用户手动处理 |

**上下文压缩 (buildDigest)**：
- 保留最近 N 条消息（keepRecent=4）
- 旧消息压缩为 `[ROLE] 摘要 (长度)`
- 工具结果压缩为 `[TOOL RESULT tool] 首行 (长度)`

**会话迁移流程**：
```
1. 检测到限制信号/超限
2. 提取当前会话历史摘要
3. newChat → 创建新会话
4. 注入 [CONTEXT DIGEST] 消息
5. 继续原始任务
```

**账号轮换 (profile rotation)**：
- 支持多 profile 配置（多账号）
- 配额耗尽时自动切换到下一个 profile
- 单 profile 时退避重试（最多 3 次，间隔 60s）

#### 3.3.9 任务管理器

**任务状态机**：
```
queued → starting → running → done/error/stopped/timeout
                              ↓
                           migrating（临时状态，返回 running）
                           rotating（临时状态，返回 running）
```

**并发控制**：
- `activeCount()` 统计运行中任务数
- `schedule()` 按 `maxConcurrent` 限制启动新任务
- 任务完成后自动调度队列中的下一个任务

#### 3.3.10 内置工具集 (TOOLS)

| 工具名 | 功能 | 关键参数 |
|--------|------|----------|
| `read_file` | 读取文件 | path, start_line, end_line |
| `write_file` | 写入文件 | path, content |
| `append_to_file` | 追加文件 | path, content |
| `replace_in_file` | 替换文件内容 | path, find, replace, use_regex |
| `delete_file` | 删除文件 | path |
| `list_directory` | 列出目录 | path, recursive, show_hidden |
| `create_directory` | 创建目录 | path |
| `move_file` | 移动/重命名 | source, destination |
| `copy_file` | 复制文件 | source, destination |
| `get_file_info` | 获取文件信息 | path |
| `run_command` | 执行命令 | command, cwd, timeout |
| `find_files` | 按名称查找文件 | pattern, directory, exclude |
| `search_in_files` | 搜索文件内容 | pattern, directory, file_pattern |
| `read_url` | 获取 URL 内容 | url |
| `write_files` | 批量写入文件 | files (array) |

#### 3.3.11 模型校准系统

**目的**：解决 DeepSeek 网页版模型选择是会话级的问题——新会话会重置为默认模型。

**流程**：
```
1. calibrateRecord: 打开有头窗口，注入 click 事件监听器
2. 用户手动切换模型（点击"专家模式"等）
3. calibrateCollect: 收集录制的点击序列
4. calibrateSave: 保存校准数据到 calibration.json
5. calibrateApply: 在新会话创建后回放点击序列
```

**校准数据格式**：
```json
{
  "deepseek-reasoner": [
    {
      "tag": "div",
      "cls": "dfb78875",
      "text": "专家模式",
      "aria": "",
      "role": ""
    }
  ]
}
```

#### 3.3.12 页面管理策略

**单页常驻 + 子页面池**：

```
thePage: 主 Agent 连续对话（网页版历史保持）
subPages[]: 子 Agent 独立页面池（用完归还复用）
```

- 无并发请求时 → 使用 thePage
- 有并发请求时 → 从 subPages 池取/新建独立页面
- 子页面用完 → newChat 清空 → 归还池
- 池中页面不关闭，复用

---

### 3.4 resources/runtime/ — 运行时资源

| 文件 | 说明 |
|------|------|
| `driver.js` | driver.js 的运行时副本（首次启动自动生成） |
| `calibration.json` | 模型校准数据（内置 deepseek-reasoner 专家模式） |

---

### 3.5 tests/test-parser-all.js — 解析器回归测试

**测试覆盖 54 个场景**，分为 8 大类：

| 类别 | 场景数 | 覆盖内容 |
|------|--------|----------|
| A. 格式变体 | 10 | tool_call/```json/```/XML/平铺 JSON/OpenAI 风格 |
| B. 参数层陷阱 | 7 | 反斜杠/换行转义/中文/嵌套对象/数组/空参数 |
| C. 匹配层 | 10 | 已知 name/schema 推断/纯参数推断/歧义消除 |
| D. 防误判 | 4 | 天气 JSON/代码示例/回复结尾数据/多 JSON |
| E. 特殊 | 6 | 参数值含`}`/数字参数/下划线工具名/连续 tool_call/XML 属性/null 参数 |
| F. 参数别名 | 4 | path→file_path/cmd→command/file→file_path/filepath→file_path |
| G. 参考实现容错 | 9 | args 容器/parameters 容器/input 容器/尾逗号/未加引号 key/Python 格式 |
| H. 安全网检测 | 4 | looksLikeToolCall 辅助检测 |

---

### 3.6 cordis.patch.yml — Bundle 配置补丁

```yaml
- insert:
  - id: dsweb-adapter
    name: dsh-deepseek-web-adapter
```

将插件挂进 DSH 配置树，id 唯一标识，name 指向 npm 包名。

---

## 4. 数据流详解

### 4.1 一次完整的 Chat Completion 请求

```
DSH 用户发送消息
    │
    ▼
DSH pi-ai Provider (dsweb)
    │ POST /v1/chat/completions
    │ { model, messages, tools, stream: true }
    ▼
Gateway (dsweb-gateway.js)
    │
    ├─ 1. 解析 payload
    ├─ 2. acquireSem() 获取并发槽位
    ├─ 3. buildContext(payload) — 只取最后一条消息
    ├─ 4. buildToolsText(payload.tools) — 生成工具调用提示词
    ├─ 5. shouldResetChat(payload) — 判断是否新会话
    ├─ 6. rpc('streamAsk', { question, mode, deepThink, toolsText, ... })
    │
    ▼
Driver (driver.js)
    │
    ├─ 7. ensurePage(profile) — 获取/创建页面
    ├─ 8. ensureLoggedIn(pageId) — 检查登录状态
    ├─ 9. 会话管理:
    │   ├─ reset=true → newChat + 校准
    │   ├─ reset='auto' + 超限 → 迁移 + 摘要注入
    │   └─ 其他 → 连续对话
    ├─ 10. applyCalibration(pageId, calibKey) — 模型切换
    ├─ 11. sendMessage(pageId, payload) — 输入 + 发送
    ├─ 12. 轮询 extractLast 等待回复
    ├─ 13. 安全网重试（最多 2 次）
    ├─ 14. parseToolCalls(finalText, tools) — 解析工具调用
    │
    ▼
Gateway (stream-end event)
    │
    ├─ 15. 有 toolCalls → 构造 SSE tool_calls chunk
    ├─ 16. 无 toolCalls → 构造 SSE content chunk
    ├─ 17. 发送 [DONE] 标记
    ├─ 18. release() 释放信号量
    │
    ▼
DSH pi-ai Provider
    │
    ├─ 有 tool_calls → DSH 执行工具
    │   └─ 工具结果回传 → 下一次 POST /v1/chat/completions
    └─ 无 tool_calls → 显示最终回复
```

### 4.2 工具调用循环

```
DSH 发送消息（含 tools）
    ↓
Gateway 组装提示词（让模型输出 tool_call）
    ↓
Driver 发送到网页版
    ↓
网页版输出 ```tool_call { "name": "read", "args": {...} } ```
    ↓
Driver 解析 → parseToolCalls → [{ name: "read", arguments: "..." }]
    ↓
Gateway 转换为 SSE tool_calls chunk
    ↓
DSH 执行工具 → 获取结果
    ↓
DSH 将结果作为 tool 角色消息发送
    ↓
Gateway 组装 [工具结果] 前缀消息
    ↓
Driver 发送到网页版
    ↓
网页版继续输出下一个 tool_call 或最终回答
    ↓
循环直到 finish_reason = 'stop'
```

---

## 5. 配置与部署

### 5.1 DSH 配置

**settings.yaml**：
```yaml
dsweb:
  displayName: DeepSeek 网页版 (免 API)
  apiKeyEnv: MOCK_LLM_KEY
  api: openai-completions
  baseURL: http://127.0.0.1:5688/v1/
  models:
    - { id: deepseek-chat, name: DeepSeek 快速 }
    - { id: deepseek-reasoner, name: DeepSeek 专家 }
    - { id: deepseek-vision, name: DeepSeek 识图 }
```

**credentials.yaml**：
```yaml
MOCK_LLM_KEY: sk-mock-any-value
```

### 5.2 运行时配置

通过 `POST /config` 可运行时调整：

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| `headless` | false | bool | 无头模式（变更需重启网关） |
| `maxConcurrent` | 2 | 1-5 | 最大并发请求数 |
| `maxTurnsPerChat` | 50 | 2-500 | 每次会话最大轮数（超限迁移） |

### 5.3 Driver 配置 (DEFAULTS)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `headless` | true | 无头模式 |
| `maxConcurrent` | 3 | 最大并发任务数 |
| `maxTurnsPerChat` | 30 | 每会话最大轮数 |
| `compactThresholdChars` | 60000 | 上下文压缩阈值（字符数） |
| `maxOutputLength` | 8000 | 最大输出长度 |
| `responseTimeoutMs` | 240000 | 回复超时（4 分钟） |
| `stableDelayMs` | 2500 | 文本稳定等待（2.5 秒） |
| `sendDelayMs` | 400 | 发送后等待 |
| `maxIterations` | 40 | 最大迭代次数 |
| `maxMigrations` | 24 | 最大迁移次数 |
| `maxQuotaBackoffRetries` | 3 | 配额退避最大重试次数 |
| `profiles` | [{ name: 'default', headless: true }] | 浏览器 Profile 配置 |

---

## 6. 错误处理与容错

### 6.1 网关层

| 场景 | 处理 |
|------|------|
| 网关启动失败 | 25s 超时，kill 进程，抛出异常 |
| 网关已运行 | 检测到端口占用 → 复用 |
| Driver 进程崩溃 | 自动重生（1.5s 后 respawn） |
| RPC 超时 | 120s 超时，pending 清理 |
| 并发超限 | 信号量排队等待 |

### 6.2 Driver 层

| 场景 | 处理 |
|------|------|
| 浏览器启动失败 | 2 次重试，清理残留锁文件 |
| 页面崩溃 | 关闭页面，任务失败 |
| 登录过期 | 终止请求，提示重新登录 |
| 消息发送失败 | CDP Enter 键兜底 |
| 解析失败 | 安全网重试（最多 2 次） |
| 长度限制 | 上下文压缩 + 会话迁移 |
| 配额限制 | 账号轮换 / 退避重试 |
| 验证码 | 终止任务，通知用户 |

### 6.3 解析器容错

| 场景 | 处理 |
|------|------|
| 单反斜杠路径 | 自动修复为双反斜杠 |
| 尾逗号 | 移除 `,}` → `}` |
| 未加引号 key | 补引号 `{key:` → `{"key":` |
| 模型编造工具名 | Schema 参数匹配推断 |
| 纯参数无 name | 按参数推断工具名 |
| Python 函数格式 | 解析 `tool(args)` 格式 |
| 参数别名 | path→file_path, cmd→command 等 |

---

## 7. 已知限制

| 限制 | 说明 |
|------|------|
| Beta 质量 | 未经大规模真实环境验证 |
| 无 Client 卡片 UI | 登录/校准/配置需手动操作（curl 或浏览器） |
| 依赖真实浏览器 | 需要本机安装 Chrome/Edge |
| 依赖网页版 UI | DeepSeek 改版可能导致选择器失效 |
| 解析器非万能 | 极端怪异格式仍可能失败 |
| 登录态为内存 Cookie | 浏览器进程关闭需重新登录 |
| 识图模式未充分验证 | Vision 模式测试有限 |
| 长对话迁移未充分验证 | 多轮工具循环 + 迁移场景测试有限 |

---

## 8. 开发指南

### 8.1 本地调试

```bash
# 启动网关
node resources/dsweb-gateway.js --port 5688 --base resources/runtime

# 跑解析器回归测试（改动 driver.js 后必须跑）
node tests/test-parser-all.js    # 期望 54/54 通过
```

### 8.2 主要维护点

| 优先级 | 文件 | 何时修改 |
|--------|------|----------|
| 高 | `resources/driver.js` | DeepSeek 网页版 UI 变化（选择器/发送/提取） |
| 高 | `resources/driver.js` parseToolCalls | 模型输出新格式时需要适配 |
| 中 | `resources/dsweb-gateway.js` | API 协议变化 / 新增端点 |
| 低 | `lib/index.js` | 启动/回收逻辑变化 |
| 低 | `tests/test-parser-all.js` | 新增解析器测试用例 |

### 8.3 代码规范

- `lib/index.js` — ESM 模块（`import`/`export`）
- `resources/*.js` — CommonJS 模块（`require`/`module.exports`）
- 语言：中文注释 + 英文变量名
- 零第三方运行时依赖（仅 Node.js 内置模块 + Chrome）

### 8.4 新增工具

在 `resources/driver.js` 的 `TOOLS` 对象中添加新工具：

```javascript
TOOLS.new_tool = {
  description: '工具描述',
  parameters: { param1: 'type (REQUIRED): description', ... },
  async execute(args, base) {
    // 实现逻辑
  }
}
```

工具会自动出现在 `getToolDescriptions()` 中，并通过提示词注入给模型。

---

## 9. 文件清单

```
.
├── lib/
│   └── index.js                 # Host 插件（Cordis apply/effect）
├── resources/
│   ├── dsweb-gateway.js         # 核心网关进程
│   ├── driver.js                # 浏览器引擎（~2500 行）
│   ├── package.json             # CommonJS 声明
│   └── runtime/
│       ├── driver.js            # 运行时 driver 副本
│       └── calibration.json     # 模型校准数据
├── tests/
│   ├── package.json             # CommonJS 声明
│   └── test-parser-all.js       # 解析器回归测试（54 场景）
├── cordis.patch.yml             # Bundle 配置补丁
├── package.json                 # 主包配置
├── README.md                    # 中文文档
├── README.en.md                 # 英文文档
├── LICENSE                      # MIT 许可证
└── .gitignore
```

---

## 10. 术语表

| 术语 | 说明 |
|------|------|
| DSH | DeepSeek Harness — LLM 编排框架 |
| Cordis | DSH 的插件系统 |
| pi-ai | DSH 的 LLM 提供方抽象层 |
| CDP | Chrome DevTools Protocol |
| SSE | Server-Sent Events（流式 HTTP 响应） |
| RPC | Remote Procedure Call（JSON-lines over stdio） |
| thePage | 主 Agent 常驻页面（连续对话） |
| subPages | 子 Agent 独立页面池（并发复用） |
| tool_call | 提示工程让模型输出的工具调用格式 |
| calibration | 模型校准（录制/回放 UI 点击序列） |
| migration | 会话迁移（超限时压缩上下文 + 新会话） |
| profile rotation | 账号轮换（多账号配额轮换） |