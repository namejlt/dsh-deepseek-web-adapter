/* Unit test: standalone registry for supported web providers and public models.
 * Run: node tests/test-provider-registry.js */
const assert = require('assert');
const {
  PROVIDERS,
  MODELS,
  resolveModel,
  listModels,
  getProvider,
  defaultProfile,
} = require('../resources/provider-registry');

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (error) {
    console.log('FAIL ' + name + ' | ' + error.message);
    throw error;
  }
}

check('exports the provider registry API', () => {
  assert.deepStrictEqual(
    Object.keys(require('../resources/provider-registry')).sort(),
    ['MODELS', 'PROVIDERS', 'defaultProfile', 'getProvider', 'listModels', 'resolveModel'],
  );
});

check('defines exactly the immutable provider metadata', () => {
  assert.deepStrictEqual(Object.keys(PROVIDERS), ['deepseek', 'chatgpt', 'qwen']);
  assert.deepStrictEqual(PROVIDERS.deepseek, {
    id: 'deepseek', label: 'DeepSeek', siteUrl: 'https://chat.deepseek.com/', defaultProfilePrefix: 'deepseek',
  });
  assert.deepStrictEqual(PROVIDERS.chatgpt, {
    id: 'chatgpt', label: 'ChatGPT', siteUrl: 'https://chatgpt.com/', defaultProfilePrefix: 'chatgpt',
  });
  assert.deepStrictEqual(PROVIDERS.qwen, {
    id: 'qwen', label: 'Qwen', siteUrl: 'https://www.qianwen.com/', defaultProfilePrefix: 'qwen',
  });
  assert(Object.isFrozen(PROVIDERS));
  assert(Object.isFrozen(PROVIDERS.deepseek));
  const originalLabel = PROVIDERS.deepseek.label;
  try { PROVIDERS.deepseek.label = 'Changed'; } catch (_) { /* strict mode may throw */ }
  assert.strictEqual(PROVIDERS.deepseek.label, originalLabel);
});

check('preserves all eight DeepSeek models with provider ownership', () => {
  assert.deepStrictEqual(Object.keys(MODELS).slice(0, 8), [
    'deepseek-chat', 'deepseek-reasoner', 'deepseek-search', 'deepseek-think-search',
    'deepseek-expert', 'deepseek-expert-reasoner', 'deepseek-vision', 'deepseek-vision-reasoner',
  ]);
  assert.deepStrictEqual(MODELS['deepseek-chat'], {
    providerId: 'deepseek', name: 'DeepSeek 快速（网页版）', mode: 'quick', deepThink: false, search: false,
  });
  assert.deepStrictEqual(MODELS['deepseek-reasoner'], {
    providerId: 'deepseek', name: 'DeepSeek 深度思考（网页版）', mode: 'quick', deepThink: true, search: false,
  });
  assert.deepStrictEqual(MODELS['deepseek-search'], {
    providerId: 'deepseek', name: 'DeepSeek 智能搜索（网页版）', mode: 'quick', deepThink: false, search: true,
  });
  assert.deepStrictEqual(MODELS['deepseek-think-search'], {
    providerId: 'deepseek', name: 'DeepSeek 深度思考+搜索（网页版）', mode: 'quick', deepThink: true, search: true,
  });
  assert.deepStrictEqual(MODELS['deepseek-expert'], {
    providerId: 'deepseek', name: 'DeepSeek 专家（网页版）', mode: 'expert', deepThink: false, search: false,
  });
  assert.deepStrictEqual(MODELS['deepseek-expert-reasoner'], {
    providerId: 'deepseek', name: 'DeepSeek 专家+深度思考（网页版）', mode: 'expert', deepThink: true, search: false,
  });
  assert.deepStrictEqual(MODELS['deepseek-vision'], {
    providerId: 'deepseek', name: 'DeepSeek 识图（网页版）', mode: 'vision', deepThink: false, search: false,
  });
  assert.deepStrictEqual(MODELS['deepseek-vision-reasoner'], {
    providerId: 'deepseek', name: 'DeepSeek 识图+深度思考（网页版）', mode: 'vision', deepThink: true, search: false,
  });
});

check('lists all public models with the final twelve qianwen entries in defined order', () => {
  const listed = listModels();
  assert.strictEqual(listed.length, 22);
  assert.deepStrictEqual(listed.slice(-12), [
    { id: 'qwen-auto', providerId: 'qwen', name: 'Qwen 自动（网页版）', mode: 'auto', modelName: 'Qwen3.7-千问' },
    { id: 'qwen-thinking', providerId: 'qwen', name: 'Qwen 思考（网页版）', mode: 'thinking', modelName: 'Qwen3.7-千问' },
    { id: 'qwen-fast', providerId: 'qwen', name: 'Qwen 快速（网页版）', mode: 'fast', modelName: 'Qwen3.7-千问' },
    { id: 'qwen-auto-max', providerId: 'qwen', name: 'Qwen 自动 Max（网页版）', mode: 'auto', modelName: 'Qwen3.8-Max' },
    { id: 'qwen-thinking-max', providerId: 'qwen', name: 'Qwen 思考 Max（网页版）', mode: 'thinking', modelName: 'Qwen3.8-Max' },
    { id: 'qwen-fast-max', providerId: 'qwen', name: 'Qwen 快速 Max（网页版）', mode: 'fast', modelName: 'Qwen3.8-Max' },
    { id: 'qwen-auto-max-37', providerId: 'qwen', name: 'Qwen 自动 Max 3.7（网页版）', mode: 'auto', modelName: 'Qwen3.7-Max' },
    { id: 'qwen-thinking-max-37', providerId: 'qwen', name: 'Qwen 思考 Max 3.7（网页版）', mode: 'thinking', modelName: 'Qwen3.7-Max' },
    { id: 'qwen-fast-max-37', providerId: 'qwen', name: 'Qwen 快速 Max 3.7（网页版）', mode: 'fast', modelName: 'Qwen3.7-Max' },
    { id: 'qwen-auto-flash', providerId: 'qwen', name: 'Qwen 自动 Flash（网页版）', mode: 'auto', modelName: 'Qwen3.6-Flash' },
    { id: 'qwen-thinking-flash', providerId: 'qwen', name: 'Qwen 思考 Flash（网页版）', mode: 'thinking', modelName: 'Qwen3.6-Flash' },
    { id: 'qwen-fast-flash', providerId: 'qwen', name: 'Qwen 快速 Flash（网页版）', mode: 'fast', modelName: 'Qwen3.6-Flash' },
  ]);
  assert.strictEqual(listed[0].id, 'deepseek-chat');
  assert.strictEqual(listed[0].provider, undefined);
});

check('resolves models with a fresh record and matching provider metadata', () => {
  const resolved = resolveModel('qwen-fast');
  assert.deepStrictEqual(resolved, {
    id: 'qwen-fast', providerId: 'qwen', name: 'Qwen 快速（网页版）', mode: 'fast', modelName: 'Qwen3.7-千问',
    provider: PROVIDERS.qwen,
  });
  assert.strictEqual(resolved.mode, 'fast');
  assert.notStrictEqual(resolved, MODELS['qwen-fast']);
  resolved.name = 'changed only here';
  assert.strictEqual(MODELS['qwen-fast'].name, 'Qwen 快速（网页版）');
  assert.strictEqual(resolveModel('missing-model'), null);
});

check('looks up all providers and derives all default profiles', () => {
  assert.strictEqual(getProvider('chatgpt'), PROVIDERS.chatgpt);
  assert.strictEqual(getProvider('qwen'), PROVIDERS.qwen);
  assert.strictEqual(getProvider('deepseek'), PROVIDERS.deepseek);
  assert.strictEqual(getProvider('unknown'), null);
  assert.strictEqual(defaultProfile('deepseek'), 'deepseek-default');
  assert.strictEqual(defaultProfile('chatgpt'), 'chatgpt-default');
  assert.strictEqual(defaultProfile('qwen'), 'qwen-default');
  assert.strictEqual(defaultProfile('unknown'), null);
});

check('rejects inherited keys in all lookup helpers', () => {
  for (const id of ['toString', 'constructor', '__proto__']) {
    assert.strictEqual(getProvider(id), null, 'getProvider(' + id + ')');
    assert.strictEqual(resolveModel(id), null, 'resolveModel(' + id + ')');
    assert.strictEqual(defaultProfile(id), null, 'defaultProfile(' + id + ')');
  }
});

console.log('\n结果: ' + pass + ' 通过, 0 失败');