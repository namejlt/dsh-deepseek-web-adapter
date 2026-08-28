'use strict';

const assert = require('assert');
const { buildScenarioSpec } = require('./live/run-live-smoke');

const models = [
  { id: 'deepseek-chat', owned_by: 'deepseek-web' },
  { id: 'chatgpt-auto', owned_by: 'chatgpt-web' },
  { id: 'qwen-auto', owned_by: 'qwen-web' },
];

const qwen = buildScenarioSpec('qwen', 'codeBlock', models);
const chatgpt = buildScenarioSpec('chatgpt', 'codeBlock', models);
assert.match(qwen.prompt, /请只输出下面这一个 Markdown 代码块/);
assert.match(qwen.fallbackPrompt, /请只输出下面这一个 Markdown 代码块/);
assert.doesNotMatch(chatgpt.prompt, /请只输出下面这一个 Markdown 代码块/);
assert.match(chatgpt.prompt, /Reply with exactly one fenced Markdown code block/);

console.log('PASS qwen code-block smoke uses the localized primary prompt');
