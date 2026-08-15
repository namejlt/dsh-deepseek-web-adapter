# dsh-deepseek-web-adapter

> **English**: [README.en.md](README.en.md)

把 **DeepSeek 网页版（chat.deepseek.com）** 变成 DSH 的免 API Key 模型提供方。
插件加载后自动拉起本地网关（`resources/dsweb-gateway.js` + `driver.js`，单一常驻浏览器），
提供 OpenAI 兼容 API。支持：连续对话、工具调用、模型校准、子 agent 并发。

- 无需 API Key、无需登录第三方平台（只需登录你自己的 DeepSeek 账号）
- `dsh plugin add` 一条命令，网关自动启动/停止

## 安装

```bash
dsh plugin --profile web add dsh-deepseek-web-adapter
# 或从 GitHub（发布后）：
dsh plugin --profile web add github:你的用户名/dsh-deepseek-web-adapter
```

插件加载后，网关自动启动（3-8 秒，日志见 DSH 终端：`DeepSeek 网页版网关已监听 5688`）。

## 配置 DSH 模型提供方

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
        { id: deepseek-reasoner, name: DeepSeek 专家 },
        { id: deepseek-vision, name: DeepSeek 识图 }
      ]
  }
```

并在 `~/.dsh/.credentials.yaml` 加：`MOCK_LLM_KEY: sk-mock-any-value`（任意值，网关不校验）。
DSH 配置热加载——模型选择器立即出现 DeepSeek 网页版。

## 登录

浏览器打开 `http://127.0.0.1:5688/login` → 登录 chat.deepseek.com
（若有"保持登录/记住我"务必勾上——会话持久，关窗口/重启不丢）。

## 使用

DSH 模型选择器选 **DeepSeek 网页版**（快速/专家/识图）直接使用。

| 能力 | 说明 |
|---|---|
| 连续对话 | 网页版历史保持，超长度限制（默认 50 条，可调）自动迁移+摘要 |
| 工具调用 | 模型输出 `tool_call` 代码块 → 网关解析（54 场景容错）→ DSH 执行 |
| 模型校准 | `deepseek-reasoner` → 专家模式（校准数据内置，可重录） |
| 子 agent 并发 | 并发请求用独立页面（多窗口并行） |

## 手动控制

```bash
# 查看网关日志 / 状态
curl http://127.0.0.1:5688/v1/models
# 重启网关（卸载插件即停止网关；重新启用即自动拉起）
dsh plugin --profile web remove dsh-deepseek-web-adapter && dsh plugin --profile web add dsh-deepseek-web-adapter
```

## 目录结构

```
lib/index.js          # host：加载时自动拉起网关，卸载时回收
resources/
  dsweb-gateway.js    # 核心网关（OpenAI API + 登录 + 校准 + 并发 + 迁移 + 工具解析）
  driver.js           # 浏览器引擎（单一常驻页面）
  runtime/            # 运行时（driver 副本 + 校准数据；profile 首次启动自动生成）
cordis.patch.yml      # bundle 配置补丁
```

## 工作原理

```
DSH (dsweb provider) → 网关 5688 → driver (单一常驻 Chrome) → chat.deepseek.com
插件加载 → 自动 spawn 网关 → 卸载 → 自动回收
```

DeepSeek 网页版没有原生 function calling——网关用提示工程让模型输出 `tool_call` JSON，
再经多层容错解析（嵌套/别名/单反斜杠路径/尾逗号/缺引号/安全网重试）转换为标准 `tool_calls`
交给 DSH 执行。工具结果回传网页版继续。回归测试 54 场景（`tests/` 见开发仓库）。

## License

MIT
