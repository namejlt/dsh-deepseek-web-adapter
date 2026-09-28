'use strict';

/**
 * Immutable metadata for the web providers known to this adapter.
 */
const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    siteUrl: 'https://chat.deepseek.com/',
    defaultProfilePrefix: 'deepseek',
  }),
  chatgpt: Object.freeze({
    id: 'chatgpt',
    label: 'ChatGPT',
    siteUrl: 'https://chatgpt.com/',
    defaultProfilePrefix: 'chatgpt',
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen',
    siteUrl: 'https://www.qianwen.com/',
    defaultProfilePrefix: 'qwen',
  }),
});

/**
 * Public web model configurations.
 * DeepSeek 网页版已无独立模型选择入口（仅剩输入框下方的「深度思考 / 智能搜索」
 * 两个 pill 开关），因此所有 DeepSeek 模型收敛为单一基础模型 `deepseek-chat`。
 * 深度思考 / 智能搜索 不再由模型 ID 区分，而是：
 *   - 默认（deepThink=false, search=false）：纯对话；
 *   - 请求体可携带可选字段 deepThink / search 覆盖默认，从而仍触发对应 pill；
 *   - 旧模型 ID（reasoner / search / expert / vision 等）仍被网关回退解析到本模型，向后兼容。
 */
const MODELS = Object.freeze({
  'deepseek-chat': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 对话（网页版）', mode: 'quick', deepThink: false, search: false }),
  'chatgpt-auto': Object.freeze({ providerId: 'chatgpt', name: 'ChatGPT 自动（网页版）', mode: 'auto' }),
  'chatgpt-thinking': Object.freeze({ providerId: 'chatgpt', name: 'ChatGPT 思考（网页版）', mode: 'thinking' }),
  /* qianwen.com 模型选择器中可见的四个页面模型：
   * Qwen3.7-千问（默认）、Qwen3.8-Max、Qwen3.7-Max、Qwen3.6-Flash。 */
  'qwen-auto': Object.freeze({ providerId: 'qwen', name: 'Qwen 自动（网页版）', mode: 'auto', modelName: 'Qwen3.7-千问' }),
  'qwen-thinking': Object.freeze({ providerId: 'qwen', name: 'Qwen 思考（网页版）', mode: 'thinking', modelName: 'Qwen3.7-千问' }),
  'qwen-fast': Object.freeze({ providerId: 'qwen', name: 'Qwen 快速（网页版）', mode: 'fast', modelName: 'Qwen3.7-千问' }),
  'qwen-auto-max': Object.freeze({ providerId: 'qwen', name: 'Qwen 自动 Max（网页版）', mode: 'auto', modelName: 'Qwen3.8-Max' }),
  'qwen-thinking-max': Object.freeze({ providerId: 'qwen', name: 'Qwen 思考 Max（网页版）', mode: 'thinking', modelName: 'Qwen3.8-Max' }),
  'qwen-fast-max': Object.freeze({ providerId: 'qwen', name: 'Qwen 快速 Max（网页版）', mode: 'fast', modelName: 'Qwen3.8-Max' }),
  'qwen-auto-max-37': Object.freeze({ providerId: 'qwen', name: 'Qwen 自动 Max 3.7（网页版）', mode: 'auto', modelName: 'Qwen3.7-Max' }),
  'qwen-thinking-max-37': Object.freeze({ providerId: 'qwen', name: 'Qwen 思考 Max 3.7（网页版）', mode: 'thinking', modelName: 'Qwen3.7-Max' }),
  'qwen-fast-max-37': Object.freeze({ providerId: 'qwen', name: 'Qwen 快速 Max 3.7（网页版）', mode: 'fast', modelName: 'Qwen3.7-Max' }),
  'qwen-auto-flash': Object.freeze({ providerId: 'qwen', name: 'Qwen 自动 Flash（网页版）', mode: 'auto', modelName: 'Qwen3.6-Flash' }),
  'qwen-thinking-flash': Object.freeze({ providerId: 'qwen', name: 'Qwen 思考 Flash（网页版）', mode: 'thinking', modelName: 'Qwen3.6-Flash' }),
  'qwen-fast-flash': Object.freeze({ providerId: 'qwen', name: 'Qwen 快速 Flash（网页版）', mode: 'fast', modelName: 'Qwen3.6-Flash' }),
});

function getProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

function resolveModel(id) {
  if (!Object.prototype.hasOwnProperty.call(MODELS, id)) return null;
  const model = MODELS[id];
  return { id, ...model, provider: getProvider(model.providerId) };
}

function listModels() {
  return Object.entries(MODELS).map(([id, config]) => ({ id, ...config }));
}

function defaultProfile(id) {
  const provider = getProvider(id);
  return provider ? provider.defaultProfilePrefix + '-default' : null;
}

module.exports = { PROVIDERS, MODELS, resolveModel, listModels, getProvider, defaultProfile };