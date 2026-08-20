# DSH 插件开发最佳实践

> 基于 [dsh-deepseek-web-adapter](https://github.com/huermi/dsh-deepseek-web-adapter) 项目总结的实战经验，适用于所有 DSH (DeepSeek Harness) Cordis 插件开发。

---

## 目录

1. [插件架构设计](#1-插件架构设计)
2. [Cordis 生命周期管理](#2-cordis-生命周期管理)
3. [进程管理与通信](#3-进程管理与通信)
4. [错误处理与容错](#4-错误处理与容错)
5. [配置管理](#5-配置管理)
6. [测试策略](#6-测试策略)
7. [安全实践](#7-安全实践)
8. [发布与分发](#8-发布与分发)

---

## 1. 插件架构设计

### 1.1 分层原则

DSH 插件应遵循明确的分层架构，每层职责单一：

```
┌──────────────────────────────────────┐
│  lib/index.js          ← Cordis 入口 │  Host 层：生命周期管理
├──────────────────────────────────────┤
│  resources/xxx.js      ← 核心业务    │  Logic 层：业务逻辑
├──────────────────────────────────────┤
│  resources/runtime/    ← 运行时数据  │  Data 层：状态持久化
└──────────────────────────────────────┘
```

**本项目示例：**

| 层 | 文件 | 职责 |
|----|------|------|
| Host | lib/index.js | apply() 启动网关，ctx.effect() 卸载回收 |
| Logic | resources/dsweb-gateway.js | HTTP API、并发控制、提示词组装 |
| Logic | resources/driver.js | 浏览器控制、工具解析、反限制 |
| Data | resources/runtime/ | 校准数据、driver 运行时副本 |

### 1.2 单一职责

每个模块只做一件事：

- **好的做法**：dsweb-gateway.js 只管 HTTP 和 RPC 转发，driver.js 只管浏览器操作
- **坏的做法**：把所有逻辑塞进一个 index.js

### 1.3 进程边界

如果插件需要长时间运行的后台服务（如 HTTP 网关、浏览器进程），必须用独立子进程，不要阻塞 Cordis 事件循环：

```javascript
// lib/index.js — 正确做法：spawn 独立进程
const cp = spawn(process.execPath, [GATEWAY_FILE, '--port', String(port)], {
  cwd: RESOURCES_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

```javascript
// 错误做法：在主进程中启动 HTTP 服务器
// 这会阻塞 DSH 的事件循环，且无法被 Cordis 正确回收
const server = http.createServer(...).listen(port); // 错误
```

---

## 2. Cordis 生命周期管理

### 2.1 标准插件结构

```javascript
// lib/index.js
export const name = 'your-plugin-name';      // 唯一标识
export const inject = [];                     // 依赖注入列表（可选）

export function apply(ctx) {
  // 加载时执行
  const resource = initialize();

  ctx.effect(() => {
    // 异步初始化
    const started = resource.start();
    started.catch((e) => {
      ctx.emit?.('your-plugin/error', e.message);
    });

    // 返回清理函数 卸载时自动调用
    return () => {
      resource.stop();
    };
  });
}
```

**本项目实际代码**（lib/index.js）：

```javascript
export const name = 'dsh-deepseek-web-adapter';
export const inject = [];

export function apply(ctx) {
  ctx.effect(() => {
    const started = ensureGateway();
    started.then((r) => {
      ctx.emit?.('dsweb/gateway-status', r);
    }).catch((e) => {
      ctx.emit?.('dsweb/gateway-error', String(e.message || e));
    });
    return () => { stopGateway(); };  // 关键：返回清理函数
  });
}
```

### 2.2 生命周期最佳实践

| 阶段 | 做什么 | 本项目示例 |
|------|--------|-----------|
| apply() 执行 | 同步初始化（尽量轻量） | 声明常量、检查文件存在 |
| ctx.effect() | 异步启动资源 | ensureGateway() 启动子进程 |
| 返回的清理函数 | 释放所有资源 | stopGateway() kill 进程 |
| 事件通知 | 用 ctx.emit() 通知状态 | dsweb/gateway-status、dsweb/gateway-error |

### 2.3 避免的陷阱

```javascript
// 错误：apply() 中启动异步操作但不等待
export function apply(ctx) {
  startServer();  // 异步启动，但 apply() 同步返回
  // 如果 startServer 失败，无法通知 DSH
}

// 正确：在 ctx.effect() 中处理异步
export function apply(ctx) {
  ctx.effect(() => {
    const p = startServer();
    p.catch((e) => ctx.emit?.('error', e));
    return () => stopServer(p);
  });
}
```

```javascript
// 错误：不返回清理函数
ctx.effect(() => {
  startServer();  // 卸载时不会停止
});

// 正确：必须返回清理函数
ctx.effect(() => {
  const server = startServer();
  return () => server.stop();
});
```

---

## 3. 进程管理与通信

### 3.1 子进程生命周期

DSH 插件通常需要 spawn 子进程。遵循以下模式：

```javascript
// 单例模式：确保只有一个子进程
let process = null;
let processPromise = null;

function ensureProcess() {
  if (processPromise) return processPromise;
  processPromise = spawnProcess()
    .catch((e) => { processPromise = null; throw e; });
  return processPromise;
}

function stopProcess() {
  if (process) {
    try { process.kill(); } catch (e) { /* ignore */ }
  }
  process = null;
  processPromise = null;
}
```

**本项目的实现**（lib/index.js）：

```javascript
let gwProcess = null;
let gwStartedByUs = false;
let gwEnsurePromise = null;

function ensureGateway() {
  if (gwEnsurePromise) return gwEnsurePromise;
  gwEnsurePromise = doEnsureGateway()
    .finally(() => { gwEnsurePromise = null; });
  return gwEnsurePromise;
}
```

### 3.2 进程间通信 (IPC)

推荐使用 JSON-lines over stdio 协议——简单、可靠、零依赖：

```
→ {"id":1,"method":"ping","params":{}}
← {"id":1,"ok":true,"result":"pong"}
← {"event":"stream-delta","streamId":"s1","delta":"你好"}
← {"event":"stream-end","streamId":"s1","ok":true,"result":"..."}
```

**协议要点：**

- 每行一个 JSON 对象，以 \n 分隔
- 请求带 id，响应带相同 id（请求-响应模式）
- 事件用 event 字段，无 id（推送模式）
- 错误用 ok: false + error 字段

**driver.js 中的实现：**

```javascript
// 发送
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// 接收
process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  for (;;) {
    const r = readLine(stdinBuf);  // 按 \n 拆行
    if (!r) break;
    stdinBuf = r.rest;
    const msg = JSON.parse(r.line);
    // 路由到 handler
    const h = handlers[msg.method];
    h(msg.params).then((res) => respond(msg.id, true, res));
  }
});
```

### 3.3 日志转发

子进程的日志必须能到达 DSH 终端，否则用户无法排查问题：

```javascript
// lib/index.js
const cp = spawn(process.execPath, [script], {
  stdio: ['ignore', 'pipe', 'pipe'],  // stdout 和 stderr 都要 pipe
});

// 转发到 DSH 的 stderr（DSH 会显示在终端）
cp.stdout.on('data', (c) => process.stderr.write(c));
cp.stderr.on('data', (c) => process.stderr.write(c));
```

这是一个极易踩的坑：如果 stdout 设为 'ignore'，所有 console.log 输出将丢失，用户看不到任何日志。

---

## 4. 错误处理与容错

### 4.1 分层错误处理

```
DSH 用户
  ↑ SSE 错误 chunk（友好提示）
Gateway（dsweb-gateway.js）
  ↑ try/catch RPC 调用
Driver（driver.js）
  ↑ try/catch 浏览器操作
Chrome CDP
```

每一层都要捕获错误并转换为对上一层友好的格式：

```javascript
// Gateway 层：捕获 RPC 错误，转为 SSE 错误
try {
  const d = await ensureDriver();
  const { streamId } = await rpc('streamAsk', payload, 30000);
  // ...
} catch (e) {
  sendChunk({
    choices: [{ delta: { content: '[错误] ' + String(e.message) } }]
  });
}
```

### 4.2 子进程崩溃自动重生

```javascript
cp.on('close', (code, signal) => {
  if (terminating) return;  // 主动关闭不重生
  log('driver exited — respawn in 1.5s');
  // 清理 pending 请求
  for (const p of d.pending.values()) p.j(new Error('driver exited'));
  d.pending.clear();
  // 自动重生
  setTimeout(() => { ensureDriver().catch(() => {}); }, 1500);
});
```

### 4.3 超时保护

每个可能阻塞的操作都要有超时：

```javascript
function rpc(method, params, timeoutMs) {
  return ensureDriver().then((d) => new Promise((resolve, reject) => {
    const id = ++d.seq;
    const t = setTimeout(() => {
      d.pending.delete(id);
      reject(new Error('rpc timeout: ' + method));
    }, timeoutMs || 120000);
    d.pending.set(id, { r: resolve, j: reject, t });
    d.cp.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  }));
}
```

### 4.4 并发控制

使用信号量限制并发，防止资源耗尽：

```javascript
let semActive = 0;
const semQueue = [];

function acquireSem() {
  if (semActive < maxConcurrent) {
    semActive++;
    return Promise.resolve(() => {
      semActive--;
      const next = semQueue.shift();
      if (next) next();
    });
  }
  return new Promise((resolve) =>
    semQueue.push(() => {
      semActive++;
      resolve(() => {
        semActive--;
        const next = semQueue.shift();
        if (next) next();
      });
    })
  );
}

// 使用
async function handleRequest() {
  const release = await acquireSem();
  try {
    // 处理请求
  } finally {
    release();  // 确保释放
  }
}
```

---

## 5. 配置管理

### 5.1 DSH 端配置

DSH 使用两个配置文件：

**~/.dsh/settings.yaml** — 声明提供方：

```yaml
llm-pi-ai:
  providers:
    your-provider:
      displayName: 你的提供方
      apiKeyEnv: YOUR_API_KEY_ENV
      api: openai-completions
      baseURL: http://127.0.0.1:5688/v1/
      models:
        - { id: model-id, name: 显示名称 }
```

**~/.dsh/.credentials.yaml** — 存储密钥：

```yaml
YOUR_API_KEY_ENV: sk-your-key-here
```

### 5.2 插件端配置

运行时配置通过 HTTP API 暴露，支持热更新：

```javascript
// GET /config — 读取
// POST /config — 修改（带值域校验）
if (p === '/config') {
  if (req.method === 'POST') {
    const b = JSON.parse(await readBody(req));
    if (b.maxConcurrent !== undefined)
      state.maxConcurrent = Math.max(1, Math.min(5, parseInt(b.maxConcurrent)));
    return sendJson(res, { ok: true, config: state });
  }
  return sendJson(res, { ok: true, config: state });
}
```

### 5.3 配置最佳实践

- 默认值要合理：maxConcurrent: 2（不是 100）
- 值域要校验：Math.max(1, Math.min(5, ...))
- 变更要通知：告知用户是否需要重启
- 敏感信息不放代码：API Key 走环境变量或 credentials.yaml

---

## 6. 测试策略

### 6.1 回归测试（必须）

对于有复杂解析逻辑的插件，回归测试是必需品：

```
tests/
  └── test-parser-all.js   # 54 个场景覆盖
```

**测试结构：**

```javascript
// 每个场景：输入 → 期望输出
const cases = [
  { name: '正常 tool_call', input: '...', expected: [{ name: 'read', arguments: '...' }] },
  { name: '缺引号 key',    input: '...', expected: [{ name: 'write', arguments: '...' }] },
  { name: '普通文本',      input: '...', expected: [] },
  // ... 更多场景
];

let pass = 0, fail = 0;
for (const c of cases) {
  const result = parseToolCalls(c.input, tools);
  if (deepEqual(result, c.expected)) {
    console.log(c.name, 'PASS');
    pass++;
  } else {
    console.log(c.name, 'FAIL\n  got:', result, '\n  expected:', c.expected);
    fail++;
  }
}
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + cases.length);
```

### 6.2 测试时机

改动 driver.js 后必须跑回归测试，确保解析器没有被破坏。

```bash
node tests/test-parser-all.js    # 期望 54/54 通过
```

### 6.3 测试覆盖原则

- 正常路径：每种合法输入格式
- 边界情况：空输入、超长输入、嵌套结构
- 容错路径：格式错误、缺字段、类型错误、编码问题
- 回归防护：每个已修复的 bug 对应一个测试用例

---

## 7. 安全实践

### 7.1 最小权限

- 插件只监听 127.0.0.1，不暴露到公网
- 子进程不使用 shell: true（防止命令注入）
- 文件读写限制在 baseDir 内

### 7.2 密钥管理

```yaml
# 正确：用环境变量引用
apiKeyEnv: MOCK_LLM_KEY

# 错误：硬编码密钥
apiKey: sk-abc123...
```

### 7.3 输入校验

```javascript
// 检查 body 大小，防止 OOM
req.on('data', (c) => {
  s += c;
  if (s.length > 8 * 1024 * 1024) {  // 8MB 上限
    req.destroy();
    reject(new Error('too large'));
  }
});
```

### 7.4 进程清理

确保卸载时所有子进程都被终止，不留僵尸进程：

```javascript
function stopGateway() {
  if (gwProcess && gwStartedByUs) {
    try { gwProcess.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
  gwProcess = null;
  gwStartedByUs = false;
}
```

---

## 8. 发布与分发

### 8.1 package.json 配置

```json
{
  "name": "dsh-deepseek-web-adapter",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "files": [
    "lib/",
    "resources/",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "keywords": ["dsh-plugin"],
  "license": "MIT"
}
```

关键字段说明：

| 字段 | 说明 |
|------|------|
| type: "module" | Cordis 插件必须使用 ESM |
| main | 指向插件入口 lib/index.js |
| dsh.bundle.patch | 指向 bundle 配置补丁文件 |
| files | npm 发布时包含的文件（排除测试/开发文件） |
| keywords | 必须包含 dsh-plugin |

### 8.2 cordis.patch.yml

```yaml
# 把插件挂进 DSH 配置树
- insert:
  - id: your-plugin-id       # 唯一标识
    name: your-package-name  # npm 包名
```

id 在 DSH 配置树中必须唯一，name 对应 npm 包名。

### 8.3 发布前检查清单

- [ ] node --check 语法检查通过
- [ ] 回归测试全部通过
- [ ] README 包含安装、配置、使用说明
- [ ] cordis.patch.yml 配置正确
- [ ] package.json 的 files 字段正确
- [ ] 子进程 stdout/stderr 正确转发
- [ ] 卸载时资源全部清理
- [ ] 错误信息对用户友好（中文提示）

---

## 附录：本项目架构速查

```
dsh-deepseek-web-adapter/
├── lib/index.js              # Cordis 插件入口（apply/effect）
├── resources/
│   ├── dsweb-gateway.js      # HTTP 网关（OpenAI 兼容 API）
│   ├── driver.js             # 浏览器引擎（CDP + 工具解析）
│   ├── package.json          # CommonJS 声明
│   └── runtime/              # 运行时数据
│       ├── driver.js         # driver 运行时副本
│       └── calibration.json  # 模型校准数据
├── tests/
│   └── test-parser-all.js    # 54 场景回归测试
├── cordis.patch.yml          # Bundle 配置补丁
├── package.json              # 主包配置
└── README.md
```

数据流：DSH -> pi-ai -> HTTP -> Gateway -> RPC stdio -> Driver -> CDP -> Chrome -> chat.deepseek.com
