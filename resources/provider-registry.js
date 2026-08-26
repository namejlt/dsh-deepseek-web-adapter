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
    siteUrl: 'https://chat.qwen.ai/',
    defaultProfilePrefix: 'qwen',
  }),
});

/**
 * Public web model configurations. The DeepSeek entries mirror the existing
 * gateway map so introducing this registry does not change its behavior.
 */
const MODELS = Object.freeze({
  'deepseek-chat': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 快速（网页版）', mode: 'quick', deepThink: false, search: false }),
  'deepseek-reasoner': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 深度思考（网页版）', mode: 'quick', deepThink: true, search: false }),
  'deepseek-search': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 智能搜索（网页版）', mode: 'quick', deepThink: false, search: true }),
  'deepseek-think-search': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 深度思考+搜索（网页版）', mode: 'quick', deepThink: true, search: true }),
  'deepseek-expert': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 专家（网页版）', mode: 'expert', deepThink: false, search: false }),
  'deepseek-expert-reasoner': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 专家+深度思考（网页版）', mode: 'expert', deepThink: true, search: false }),
  'deepseek-vision': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 识图（网页版）', mode: 'vision', deepThink: false, search: false }),
  'deepseek-vision-reasoner': Object.freeze({ providerId: 'deepseek', name: 'DeepSeek 识图+深度思考（网页版）', mode: 'vision', deepThink: true, search: false }),
  'chatgpt-auto': Object.freeze({ providerId: 'chatgpt', name: 'ChatGPT 自动（网页版）', mode: 'auto' }),
  'chatgpt-thinking': Object.freeze({ providerId: 'chatgpt', name: 'ChatGPT 思考（网页版）', mode: 'thinking' }),
  'qwen-auto': Object.freeze({ providerId: 'qwen', name: 'Qwen 自动（网页版）', mode: 'auto', modelName: 'Qwen3.7-Plus' }),
  'qwen-thinking': Object.freeze({ providerId: 'qwen', name: 'Qwen 思考（网页版）', mode: 'thinking', modelName: 'Qwen3.7-Plus' }),
  'qwen-fast': Object.freeze({ providerId: 'qwen', name: 'Qwen 快速（网页版）', mode: 'fast', modelName: 'Qwen3.7-Plus' }),
  'qwen-auto-max': Object.freeze({ providerId: 'qwen', name: 'Qwen 自动 Max（网页版）', mode: 'auto', modelName: 'Qwen3.8-Max' }),
  'qwen-thinking-max': Object.freeze({ providerId: 'qwen', name: 'Qwen 思考 Max（网页版）', mode: 'thinking', modelName: 'Qwen3.8-Max' }),
  'qwen-fast-max': Object.freeze({ providerId: 'qwen', name: 'Qwen 快速 Max（网页版）', mode: 'fast', modelName: 'Qwen3.8-Max' }),
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