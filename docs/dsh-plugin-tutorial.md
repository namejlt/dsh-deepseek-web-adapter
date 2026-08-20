# DSH 插件开发简明教程

> 以 dsh-deepseek-web-adapter 为完整示例，从零开始构建一个 DSH Cordis 插件。

---

## 目录

1. [概述：什么是 DSH 插件](#1-概述什么是-dsh-插件)
2. [环境准备](#2-环境准备)
3. [项目结构](#3-项目结构)
4. [第一步：编写插件入口](#4-第一步编写插件入口)
5. [第二步：配置 Bundle Patch](#5-第二步配置-bundle-patch)
6. [第三步：实现业务逻辑](#6-第三步实现业务逻辑)
7. [第四步：进程间通信](#7-第四步进程间通信)
8. [第五步：注册到 DSH](#8-第五步注册到-dsh)
9. [第六步：调试与测试](#9-第六步调试与测试)
10. [第七步：发布](#10-第七步发布)
11. [完整示例：最简插件](#11-完整示例最简插件)

---

## 1. 概述：什么是 DSH 插件

DSH 插件是基于 Cordis 框架的模块，可以扩展 DSH 的功能。最常见的是 LLM Provider 插件——让 DSH 支持新的 AI 模型提供方。

本教程以 dsh-deepseek-web-adapter 为示例，展示如何构建一个完整的 LLM Provider 插件。

**核心概念：**

```
DSH (Cordis Host)
  │
  ├── pi-ai           ← LLM 提供方抽象层
  │   └── providers   ← 插件注册的模型提供方
  │       ├── openai
  │       ├── anthropic
  │       └── dsweb   ← 本插件
  │
  └── plugins/        ← 插件加载目录
      └── dsh-deepseek-web-adapter/
```

DSH 的 pi-ai 模块通过 OpenAI 兼容 API 调用模型提供方。插件的工作就是提供一个兼容的 HTTP 端点。

---

## 2. 环境准备

```bash
# 必须
Node.js >= 18
npm

# 可选
Chrome/Edge（如果插件需要浏览器）
```

**项目初始化：**

```bash
mkdir my-dsh-plugin
cd my-dsh-plugin
npm init -y
```

---

## 3. 项目结构

一个标准的 DSH 插件项目结构如下：

```
my-dsh-plugin/
├── lib/
│   └── index.js              # Cordis 插件入口（必须）
├── resources/                 # 业务逻辑（可选，按需）
│   └── server.js
├── tests/                     # 测试（推荐）
│   └── test.js
├── cordis.patch.yml           # Bundle 配置补丁（必须）
├── package.json               # 包配置（必须）
└── README.md                  # 文档（推荐）
```

**本项目的实际结构：**

```
dsh-deepseek-web-adapter/
├── lib/
│   └── index.js              # Host 插件入口
├── resources/
│   ├── dsweb-gateway.js      # 核心网关（HTTP 服务）
│   ├── driver.js             # 浏览器引擎
│   ├── package.json          # CommonJS 声明 {"type": "commonjs"}
│   └── runtime/              # 运行时数据目录
├── tests/
│   ├── package.json          # CommonJS 声明
│   └── test-parser-all.js    # 回归测试
├── cordis.patch.yml          # Bundle 配置
├── package.json              # 主包配置
└── README.md
```

---

## 4. 第一步：编写插件入口

### 4.1 package.json

```json
{
  "name": "my-dsh-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib/", "resources/", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "keywords": ["dsh-plugin"],
  "license": "MIT"
}
```

关键字段：

| 字段 | 说明 |
|------|------|
| `"type": "module"` | Cordis 插件必须是 ESM 模块 |
| `"main": "lib/index.js"` | 插件入口文件 |
| `"dsh.bundle.patch"` | 指向 bundle 配置补丁 |
| `"keywords": ["dsh-plugin"]` | 让 DSH 识别为插件 |

### 4.2 lib/index.js — Cordis 插件入口

```javascript
/**
 * my-dsh-plugin — Cordis 插件入口
 *
 * apply(ctx) 在插件加载时被调用
 * ctx.effect() 返回的清理函数在插件卸载时被调用
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 插件的唯一标识
export const name = 'my-dsh-plugin';

// 依赖注入列表（如需使用其他插件提供的服务）
export const inject = [];

// 插件加载时调用
export function apply(ctx) {
  ctx.effect(() => {
    // === 异步初始化 ===
    console.log('[my-plugin] 插件已加载');

    // 在这里启动你的服务
    // 例如：spawn 一个 HTTP 网关子进程
    const serverPath = path.join(__dirname, '..', 'resources', 'server.js');
    const cp = spawn(process.execPath, [serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 转发子进程日志到 DSH 终端
    cp.stdout.on('data', (c) => process.stderr.write(c));
    cp.stderr.on('data', (c) => process.stderr.write(c));

    // 通知 DSH 状态
    ctx.emit?.('my-plugin/status', { status: 'started', pid: cp.pid });

    // === 返回清理函数 ===
    // 插件卸载时自动调用
    return () => {
      console.log('[my-plugin] 插件卸载，清理资源');
      try { cp.kill('SIGTERM'); } catch (e) { /* ignore */ }
    };
  });
}
```

**本项目的实际代码**（lib/index.js）：

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
    return () => { stopGateway(); };
  });
}
```

---

## 5. 第二步：配置 Bundle Patch

### 5.1 cordis.patch.yml

```yaml
# 把插件挂进 DSH 配置树
- insert:
  - id: my-plugin-id           # 唯一 ID，在 DSH 配置树中不能重复
    name: my-dsh-plugin        # npm 包名（与 package.json 的 name 一致）
```

**本项目的配置：**

```yaml
- insert:
  - id: dsweb-adapter
    name: dsh-deepseek-web-adapter
```

id 是 DSH 内部的唯一标识符，name 是 npm 包名。DSH 的 Loader 按 name 去 import 对应的包。

---

## 6. 第三步：实现业务逻辑

### 6.1 作为 LLM Provider 插件

如果要让 DSH 使用你的插件作为模型提供方，你需要实现一个 OpenAI 兼容的 HTTP API。

**DSH 的 pi-ai 模块期望的接口：**

```
GET  /v1/models              → { "object": "list", "data": [...] }
POST /v1/chat/completions    → SSE 流式响应
```

### 6.2 实现模型列表端点

```javascript
// resources/server.js
const http = require('http');

const MODELS = {
  'my-model': { name: '我的模型' },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: Object.entries(MODELS).map(([id, m]) => ({
        id,
        object: 'model',
        owned_by: 'my-plugin',
        name: m.name,
      })),
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(5688, '127.0.0.1', () => {
  console.log('Server listening on http://127.0.0.1:5688');
});
```

**本项目的模型列表**（dsweb-gateway.js）：

```javascript
const MODELS = {
  'deepseek-chat':    { name: 'DeepSeek 快速', mode: 'quick',  deepThink: false },
  'deepseek-reasoner': { name: 'DeepSeek 专家', mode: 'expert', deepThink: true },
  'deepseek-vision':  { name: 'DeepSeek 识图', mode: 'vision', deepThink: false },
};
```

### 6.3 实现 Chat Completions 端点（SSE 流式）

```javascript
// POST /v1/chat/completions
if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
  // 读取请求体
  const body = await readBody(req);
  const payload = JSON.parse(body);

  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });

  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  // 发送 role
  send({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk',
    model: payload.model || 'my-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });

  // 发送内容（你的业务逻辑）
  const content = '你好！这是来自我的插件的回复。';
  for (let i = 0; i < content.length; i += 10) {
    send({
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk',
      model: payload.model || 'my-model',
      choices: [{ index: 0, delta: { content: content.slice(i, i + 10) }, finish_reason: null }],
    });
  }

  // 发送结束
  send({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk',
    model: payload.model || 'my-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });

  res.write('data: [DONE]\n\n');
  res.end();
}
```

**本项目的核心处理**（dsweb-gateway.js handleChatCompletion）：

```javascript
async function handleChatCompletion(req, res, payload) {
  const release = await acquireSem();  // 获取并发槽位
  try {
    const question = buildContext(payload);
    const toolsText = buildToolsText(payload.tools);
    const { streamId } = await rpc('streamAsk', { question, ... });
    // 通过 RPC 从 driver 获取流式结果
    const consumer = makeConsumer(d, streamId);
    sseHeaders(res);
    // 循环读取 driver 推送的 delta
    for (;;) {
      const evt = await consumer.next();
      if (evt.delta) sendChunk({ ... delta: { content: evt.delta } });
      if (evt.ok !== undefined) break;
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    release();  // 释放并发槽位
  }
}
```

---

## 7. 第四步：进程间通信

### 7.1 JSON-lines RPC 协议

当插件需要与子进程通信时，推荐使用 JSON-lines over stdio：

```
每行一个 JSON 对象，以 \n 分隔

请求格式：{"id":1,"method":"methodName","params":{...}}
响应格式：{"id":1,"ok":true,"result":{...}}
事件格式：{"event":"eventName","data":{...}}
```

### 7.2 在子进程中实现 RPC Handler

```javascript
// 在子进程中（driver.js 风格）
const pending = new Map();
let rpcSeq = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, ok, result, error) {
  if (ok) send({ id, ok: true, result });
  else send({ id, ok: false, error: String(error) });
}

function emitEvent(name, payload) {
  send({ event: name, ...(payload || {}) });
}

const handlers = {
  ping: async () => 'pong',
  echo: async (params) => params.message,
  // 更多 handler...
};

let stdinBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  for (;;) {
    const i = stdinBuf.indexOf('\n');
    if (i < 0) break;
    const line = stdinBuf.slice(0, i).toString('utf8').trim();
    stdinBuf = stdinBuf.slice(i + 1);
    if (!line) continue;

    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }

    if (msg.id !== undefined && msg.method) {
      const h = handlers[msg.method];
      if (!h) { respond(msg.id, false, null, 'unknown method'); continue; }
      Promise.resolve()
        .then(() => h(msg.params || {}))
        .then((res) => respond(msg.id, true, res))
        .catch((err) => respond(msg.id, false, null, err));
    }
  }
});
```

### 7.3 在父进程中调用 RPC

```javascript
// 在父进程中（dsweb-gateway.js 风格）
function rpc(method, params, timeoutMs) {
  return ensureDriver().then((d) => new Promise((resolve, reject) => {
    const id = ++d.seq;
    const t = setTimeout(() => {
      d.pending.delete(id);
      reject(new Error('rpc timeout: ' + method));
    }, timeoutMs || 120000);
    d.pending.set(id, { r: resolve, j: reject, t });
    d.cp.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
  }));
}

// 使用
const result = await rpc('ping', {}, 5000);
console.log(result); // "pong"
```

---

## 8. 第五步：注册到 DSH

### 8.1 配置 settings.yaml

编辑 `~/.dsh/settings.yaml`，在 `llm-pi-ai.providers` 下添加：

```yaml
llm-pi-ai:
  providers:
    my-provider:
      displayName: 我的插件模型
      apiKeyEnv: MY_PLUGIN_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:5688/v1/
      models:
        - { id: my-model, name: 我的模型 }
```

### 8.2 配置 credentials.yaml

编辑 `~/.dsh/.credentials.yaml`：

```yaml
MY_PLUGIN_KEY: sk-any-value
```

### 8.3 安装插件

```bash
# 从 npm 安装
dsh plugin add my-dsh-plugin

# 或本地开发时直接链接
dsh plugin add ./my-dsh-plugin
```

安装后，DSH 的模型选择器中会出现 "我的插件模型"。

---

## 9. 第六步：调试与测试

### 9.1 本地运行网关

```bash
# 不通过 DSH，直接启动网关调试
node resources/server.js
```

### 9.2 测试 API

```bash
# 测试模型列表
curl http://127.0.0.1:5688/v1/models

# 测试聊天
curl -N http://127.0.0.1:5688/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"my-model","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### 9.3 回归测试

```bash
# 每个改动后跑测试
node tests/test.js
```

**本项目的测试：**

```bash
node tests/test-parser-all.js    # 54 场景 / 期望 54/54 通过
```

### 9.4 查看日志

插件启动后，DSH 终端会显示日志：

```
[my-plugin] 插件已加载
Server listening on http://127.0.0.1:5688
```

如果看不到日志，检查 `lib/index.js` 中是否正确转发了子进程的 stdout/stderr。

---

## 10. 第七步：发布

### 10.1 发布前检查

```bash
# 语法检查
node --check lib/index.js
node --check resources/server.js

# 跑测试
node tests/test.js

# 检查 package.json
cat package.json  # 确认 type/module/main/files 正确
```

### 10.2 发布到 npm

```bash
npm publish
```

### 10.3 发布检查清单

- [ ] package.json 正确：type: "module"、main、files、keywords
- [ ] cordis.patch.yml 存在且正确
- [ ] 所有文件语法正确
- [ ] 测试全部通过
- [ ] README 包含安装/配置/使用说明
- [ ] 子进程日志正确转发
- [ ] 卸载时资源清理干净

---

## 11. 完整示例：最简插件

以下是一个最小可用的 DSH 插件，直接返回固定回复：

### 项目结构

```
hello-dsh-plugin/
├── lib/
│   └── index.js
├── cordis.patch.yml
└── package.json
```

### package.json

```json
{
  "name": "hello-dsh-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib/", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "keywords": ["dsh-plugin"],
  "license": "MIT"
}
```

### cordis.patch.yml

```yaml
- insert:
  - id: hello-plugin
    name: hello-dsh-plugin
```

### lib/index.js

```javascript
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5699;

export const name = 'hello-dsh-plugin';
export const inject = [];

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'hello', object: 'model', owned_by: 'hello', name: 'Hello' }],
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      });
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      const cid = 'chatcmpl-' + Date.now();
      send({ id: cid, object: 'chat.completion.chunk', model: 'hello',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      send({ id: cid, object: 'chat.completion.chunk', model: 'hello',
        choices: [{ index: 0, delta: { content: 'Hello from DSH plugin!' }, finish_reason: null }] });
      send({ id: cid, object: 'chat.completion.chunk', model: 'hello',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('[hello-plugin] Server on http://127.0.0.1:' + PORT);
  });

  return server;
}

export function apply(ctx) {
  let server = null;

  ctx.effect(() => {
    server = startServer();
    ctx.emit?.('hello-plugin/status', { status: 'started' });
    return () => {
      if (server) server.close();
      console.log('[hello-plugin] Stopped');
    };
  });
}
```

### 注册到 DSH

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    hello:
      displayName: Hello Plugin
      apiKeyEnv: HELLO_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:5699/v1/
      models:
        - { id: hello, name: Hello }
```

```yaml
# ~/.dsh/.credentials.yaml
HELLO_KEY: sk-any
```

### 安装

```bash
dsh plugin add ./hello-dsh-plugin
```

选择 "Hello Plugin" 模型，发送任意消息，会收到 "Hello from DSH plugin!"。

---

## 总结

通过本教程，你学会了：

1. DSH 插件的标准项目结构
2. Cordis 生命周期管理（apply/effect/cleanup）
3. Bundle patch 配置
4. OpenAI 兼容 API 实现（SSE 流式）
5. JSON-lines RPC 进程间通信
6. 注册到 DSH 的配置方法
7. 调试、测试和发布流程

以 dsh-deepseek-web-adapter 为参考，你可以构建任何类型的 DSH LLM Provider 插件。
