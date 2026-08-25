# 三端 Provider 管理台设计

**日期：** 2026-08-25  
**状态：** 已实现并通过离线/浏览器视觉验收；真实登录态验收待用户手工完成  
**范围：** 将 5688 管理页从 DeepSeek 单端页面升级为 DeepSeek、ChatGPT、Qwen 共用的 Provider 指挥台。

## 目标

首页必须在不切换页面的情况下展示三端的登录状态、默认 profile、模型数量、账号池摘要与下一步操作；所有 provider 相关操作必须显式携带 provider，不能再默认落到 DeepSeek。

## 信息架构

1. 顶部全局条展示 gateway/driver、请求、会话、通道、刷新与诊断入口。
2. 固定三张 provider 卡片展示 DeepSeek、ChatGPT、Qwen 的实时状态，点击后切换主工作区。
3. 主工作区展示选中 provider 的登录/challenge/冷却解释、模型、账号池与 provider 作用域操作。
4. 操作队列把未登录、challenge、冷却、烟测等状态转为明确的下一步。
5. 全局配置与原始诊断快照保留在页面底部，保持现有兼容入口。

## 数据契约

新增 `GET /providers`，并令 `/setup` 同时返回 `providers`：

```json
{
  "providers": [{
    "id": "qwen",
    "label": "Qwen Web",
    "siteUrl": "https://chat.qwen.ai/",
    "defaultProfile": "qwen-default",
    "models": [{ "id": "qwen-chat", "name": "Qwen 对话（网页版）" }],
    "login": { "needsLogin": false },
    "status": "ready",
    "action": { "kind": "manage", "label": "管理 Qwen" },
    "accounts": { "total": 1, "active": 1, "cooling": 0, "needsLogin": 0, "disabled": 0 }
  }]
}
```

`status` 只来自可验证状态：`ready`、`needs_login`、`challenge`、`cooling`、`disabled`、`unknown`。ChatGPT 的 challenge 必须优先于登录提示。账号数组继续由 `/accounts` 提供，但每条记录必须包含 `providerId`。

## 操作不变量

- provider 卡片的登录链接使用 `/login?provider=<id>`。
- 添加、启用、禁用、删除账号的请求 body 都包含 `provider`。
- 账号表、统计和操作只显示当前选中的 provider；全局总览只显示汇总数字。
- `refreshAll()` 并行读取 `/setup`、`/health`、`/accounts`、`/config`；不再只按 DeepSeek 的 `health.login` 判定页面状态。
- 首次访问选中第一个处于 `needs_login`/`challenge` 的 provider；没有待办时选 DeepSeek。

## 视觉与文案

采用深色 Provider 指挥台：DeepSeek 蓝、ChatGPT 紫、Qwen 青；状态色统一为绿色 ready、黄色 needs_login/cooling、红色 challenge/disabled。页面不承诺自动绕过 challenge；主操作应说明需要在浏览器中人工完成。

## 验收

- `/setup` 与 `/providers` 都返回三端 provider 聚合状态。
- 管理页存在三张 provider 卡片，且 ChatGPT/Qwen 账号操作携带正确 provider。
- provider 卡片与选中详情根据 `needs_login`、challenge、cooling、disabled、ready 显示对应操作。
- 原有 `/setup`、`/accounts`、`/config`、`/debug` 和 DeepSeek 账号管理仍可用。
- 离线管理页测试、provider gateway 测试和全部回归通过；真实浏览器页面在本机以 fake driver 和可视截图验证布局。
