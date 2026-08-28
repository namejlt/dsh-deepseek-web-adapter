'use strict';

const assert = require('assert');
const { buildScenarioSpec } = require('./live/run-live-smoke');

const models = [
  { id: 'deepseek-chat', owned_by: 'deepseek-web' },
  { id: 'chatgpt-auto', owned_by: 'chatgpt-web' },
  { id: 'qwen-auto', owned_by: 'qwen-web' },
];

const deepseek = buildScenarioSpec('deepseek', 'toolCall', models);
const chatgpt = buildScenarioSpec('chatgpt', 'toolCall', models);
const qwen = buildScenarioSpec('qwen', 'toolCall', models);

assert.match(deepseek.prompt, /ONLY 一个 ```tool_call 代码块|ONLY one ```tool_call/i);
assert.match(chatgpt.prompt, /请仅输出一个 tool_call|tool_call code block/i);
assert.match(chatgpt.prompt, /无需你进行任何tool执行|不用进行任何tool执行/);
assert.match(chatgpt.prompt, /无需你进行网络搜索|不用进行任何tool执行/);
assert.match(chatgpt.fallbackPrompt, /<tool_calls><invoke name="echo_marker">/);
assert.match(chatgpt.fallbackPrompt, /无需你进行任何tool执行|不用进行任何tool执行/);
assert.strictEqual(qwen.expectedToolName, 'echo_marker');

console.log('PASS provider-specific tool-call prompts are wired for DeepSeek and ChatGPT');
