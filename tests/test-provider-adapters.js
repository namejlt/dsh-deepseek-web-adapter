/* Offline unit tests for page-adapter expression strings.
 * Run: node tests/test-provider-adapters.js */
'use strict';

const assert = require('assert');
const vm = require('vm');
const chatgpt = require('../resources/providers/chatgpt');
const qwen = require('../resources/providers/qwen');
const deepseek = require('../resources/providers/deepseek');

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name + ' | ' + error.message);
    throw error;
  }
}

class FakeEvent {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeElement {
  constructor(tagName, options = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = Object.assign({}, options.attributes);
    this.className = options.className || '';
    this.hidden = !!options.hidden;
    this.disabled = !!options.disabled;
    this.textContent = options.text || '';
    this.innerText = options.text || '';
    this.style = Object.assign({ display: '', visibility: '' }, options.style);
    this.children = [];
    this.parentElement = null;
    this.events = [];
    this.clicks = 0;
    this.onClick = options.onClick || null;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  dispatchEvent(event) {
    this.events.push(event);
    return true;
  }

  click() {
    this.clicks++;
    if (this.onClick) this.onClick(this);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSimple(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return descendants(this).filter((element) => matches(element, selector));
  }
}

class FakeTextarea extends FakeElement {
  constructor(options = {}) {
    super('textarea', options);
    this._value = options.value || '';
  }
}
Object.defineProperty(FakeTextarea.prototype, 'value', {
  get() { return this._value; },
  set(value) { this._value = String(value); },
  configurable: true,
});

function descendants(root) {
  const out = [];
  for (const child of root.children || []) {
    out.push(child, ...descendants(child));
  }
  return out;
}

function matches(element, selector) {
  return selector.split(',').some((part) => matchesPath(element, part.trim()));
}

function matchesPath(element, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!matchesSimple(element, parts[parts.length - 1])) return false;
  let current = element.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (current && !matchesSimple(current, parts[i])) current = current.parentElement;
    if (!current) return false;
    current = current.parentElement;
  }
  return true;
}

function matchesSimple(element, selector) {
  const tag = selector.match(/^[a-zA-Z][\w-]*/);
  if (tag && element.tagName !== tag[0].toUpperCase()) return false;
  const id = selector.match(/#([\w-]+)/);
  if (id && element.getAttribute('id') !== id[1]) return false;
  for (const cls of selector.matchAll(/\.([\w-]+)/g)) {
    if (!element.className.split(/\s+/).includes(cls[1])) return false;
  }
  for (const attr of selector.matchAll(/\[([\w-]+)(\*?=)?(?:"([^"]*)")?\]/g)) {
    const actual = attr[1] === 'class' ? element.className : element.getAttribute(attr[1]);
    if (actual === null) return false;
    if (attr[2] === '=' && actual !== attr[3]) return false;
    if (attr[2] === '*=' && !actual.includes(attr[3])) return false;
  }
  return true;
}

function makeDocument(...roots) {
  const document = new FakeElement('document');
  document.body = new FakeElement('body');
  document.append(document.body);
  for (const root of roots) document.body.append(root);
  return document;
}

function run(adapter, expression, document, argument, pathname = '/') {
  const location = { href: 'https://example.test' + pathname, pathname };
  const sandbox = {
    document,
    location,
    Event: FakeEvent,
    HTMLTextAreaElement: FakeTextarea,
    getComputedStyle: (element) => element.style,
    Array,
    Object,
    String,
    RegExp,
    JSON,
    Set,
  };
  vm.createContext(sandbox);
  const value = vm.runInContext(adapter.expressions[expression], sandbox, { filename: adapter.id + '-' + expression + '.js' });
  return { result: typeof value === 'function' ? value(argument) : value, location };
}

function button(options = {}) {
  return new FakeElement('button', options);
}

check('ChatGPT exposes the expected pure adapter metadata', () => {
  assert.deepStrictEqual(
    { id: chatgpt.id, label: chatgpt.label, siteUrl: chatgpt.siteUrl, defaultProfilePrefix: chatgpt.defaultProfilePrefix },
    { id: 'chatgpt', label: 'ChatGPT Web', siteUrl: 'https://chatgpt.com/', defaultProfilePrefix: 'chatgpt' },
  );
  assert.deepStrictEqual(Object.keys(chatgpt.expressions).sort(), [
    'applyMode', 'clickSend', 'detectChallenge', 'detectGenerating', 'detectLimit', 'detectLogin',
    'extractLatest', 'fillPrompt', 'findComposer', 'openNewChat',
  ]);
  assert(Object.values(chatgpt.expressions).every((expression) => typeof expression === 'string'));
});

check('ChatGPT finds the visible semantic composer and fills it via input event', () => {
  const form = new FakeElement('form', { attributes: { 'data-testid': 'prompt-form' } });
  const hidden = form.append(new FakeTextarea({ hidden: true }));
  const composer = form.append(new FakeTextarea());
  const document = makeDocument(form);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(chatgpt, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(chatgpt, 'fillPrompt', document, 'hello ChatGPT').result, true);
  assert.strictEqual(hidden.value, '');
  assert.strictEqual(composer.value, 'hello ChatGPT');
  assert.strictEqual(composer.events.length, 1);
  assert.strictEqual(composer.events[0].type, 'input');
});

check('ChatGPT recognizes and fills its current contenteditable prompt', () => {
  const form = new FakeElement('form', { attributes: { 'data-testid': 'prompt-form' } });
  const composer = form.append(new FakeElement('div', { attributes: { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox' } }));
  const submit = form.append(button({ attributes: { type: 'submit' } }));
  const document = makeDocument(form);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(chatgpt, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(chatgpt, 'fillPrompt', document, 'hello editable ChatGPT').result, true);
  assert.strictEqual(composer.textContent, 'hello editable ChatGPT');
  assert.strictEqual(composer.events[0].type, 'input');
  assert.strictEqual(run(chatgpt, 'clickSend', document).result, true);
  assert.strictEqual(submit.clicks, 1);
});

check('ChatGPT send lookup stays inside the composer form and prefers submit', () => {
  const form = new FakeElement('form', { attributes: { 'data-testid': 'prompt-form' } });
  const composer = form.append(new FakeTextarea());
  const submit = form.append(button({ attributes: { type: 'submit' } }));
  const fallback = form.append(button());
  const pageDecoy = button({ attributes: { type: 'submit' } });
  const document = makeDocument(form, pageDecoy);
  assert.strictEqual(run(chatgpt, 'clickSend', document).result, true);
  assert.strictEqual(submit.clicks, 1);
  assert.strictEqual(fallback.clicks, 0);
  assert.strictEqual(pageDecoy.clicks, 0);
  assert.strictEqual(composer.closest('form'), form);
});

check('ChatGPT clicks the current composer submit button by id and data-testid', () => {
  const form = new FakeElement('form', { attributes: { 'data-testid': 'prompt-form' } });
  form.append(new FakeElement('div', { attributes: { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox' } }));
  const send = form.append(button({ attributes: { id: 'composer-submit-button', 'data-testid': 'send-button', 'aria-label': '发送提示' } }));
  const fallback = form.append(button());
  const document = makeDocument(form);
  assert.strictEqual(run(chatgpt, 'clickSend', document).result, true);
  assert.strictEqual(send.clicks, 1);
  assert.strictEqual(fallback.clicks, 0);
});

check('ChatGPT composer helpers ignore a preceding unrelated textarea form', () => {
  const decoyForm = new FakeElement('form', { attributes: { 'aria-label': 'Newsletter signup' } });
  const decoyComposer = decoyForm.append(new FakeTextarea());
  const decoySend = decoyForm.append(button({ attributes: { type: 'submit' } }));
  const composerForm = new FakeElement('form', { attributes: { 'data-testid': 'prompt-form' } });
  const composer = composerForm.append(new FakeTextarea());
  const send = composerForm.append(button({ attributes: { type: 'submit' } }));
  const document = makeDocument(decoyForm, composerForm);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(chatgpt, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(chatgpt, 'fillPrompt', document, 'only the chat prompt').result, true);
  assert.strictEqual(composer.value, 'only the chat prompt');
  assert.strictEqual(decoyComposer.value, '');
  assert.strictEqual(run(chatgpt, 'clickSend', document).result, true);
  assert.strictEqual(send.clicks, 1);
  assert.strictEqual(decoySend.clicks, 0);
});

check('ChatGPT uses prompt-textarea fallback without touching an unrelated textarea form', () => {
  const decoyForm = new FakeElement('form', { attributes: { 'aria-label': 'Newsletter signup' } });
  const decoyComposer = decoyForm.append(new FakeTextarea());
  const decoySend = decoyForm.append(button({ attributes: { type: 'submit' } }));
  const promptForm = new FakeElement('form');
  const composer = promptForm.append(new FakeTextarea({ attributes: { id: 'prompt-textarea' } }));
  const send = promptForm.append(button({ attributes: { type: 'submit' } }));
  const document = makeDocument(decoyForm, promptForm);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(chatgpt, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(chatgpt, 'fillPrompt', document, 'prompt textarea fallback').result, true);
  assert.strictEqual(composer.value, 'prompt textarea fallback');
  assert.strictEqual(decoyComposer.value, '');
  assert.strictEqual(run(chatgpt, 'clickSend', document).result, true);
  assert.strictEqual(send.clicks, 1);
  assert.strictEqual(decoySend.clicks, 0);
});

check('ChatGPT ignores a hidden sign-in control when deciding authenticated state', () => {
  const hiddenLogin = button({ text: 'Sign in', hidden: true });
  assert.strictEqual(run(chatgpt, 'detectLogin', makeDocument(hiddenLogin)).result, false);
});

check('ChatGPT distinguishes sign-in UI from Turnstile challenge UI', () => {
  const login = makeDocument(button({ text: 'Sign in' }));
  assert.strictEqual(run(chatgpt, 'detectLogin', login).result, true);
  assert.strictEqual(run(chatgpt, 'detectChallenge', login).result, false);

  const challenge = makeDocument(new FakeElement('div', { text: 'Verify you are human with Turnstile' }));
  assert.strictEqual(run(chatgpt, 'detectChallenge', challenge).result, true);
  assert.strictEqual(run(chatgpt, 'detectLogin', challenge).result, false);

  const challengeWithSignIn = makeDocument(
    new FakeElement('div', { text: 'Verify you are human with Turnstile' }),
    button({ text: 'Sign in' }),
  );
  assert.strictEqual(run(chatgpt, 'detectLogin', challengeWithSignIn).result, false);
});

check('ChatGPT extracts only the latest assistant response without duplicate code lines', () => {
  const oldAssistant = new FakeElement('article', { attributes: { 'data-message-author-role': 'assistant' }, text: 'old response' });
  const latest = new FakeElement('article', { attributes: { 'data-message-author-role': 'assistant' }, text: 'Readable answer\nconst answer = 42;' });
  const pre = latest.append(new FakeElement('pre'));
  pre.append(new FakeElement('code', { text: 'const answer = 42;\nsecond code line' }));
  const main = new FakeElement('main');
  main.append(oldAssistant);
  main.append(latest);
  main.append(new FakeElement('article', { text: 'a later unlabelled user turn' }));
  const out = run(chatgpt, 'extractLatest', makeDocument(main)).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), {
    text: 'Readable answer\nconst answer = 42;\nsecond code line', thinking: '',
  });
});

check('ChatGPT toggles its visible thinking pill when requested', () => {
  const pill = button({
    text: '思考',
    attributes: { 'aria-pressed': 'false' },
    onClick: (element) => element.setAttribute('aria-pressed', 'true'),
  });
  const out = run(chatgpt, 'applyMode', makeDocument(pill), { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(pill.clicks, 1);
  assert.strictEqual(pill.getAttribute('aria-pressed'), 'true');
});

check('ChatGPT can also turn its thinking pill back off', () => {
  const pill = button({
    text: 'Thinking',
    attributes: { 'aria-pressed': 'true' },
    onClick: (element) => element.setAttribute('aria-pressed', 'false'),
  });
  const out = run(chatgpt, 'applyMode', makeDocument(pill), { thinking: false }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(pill.clicks, 1);
  assert.strictEqual(pill.getAttribute('aria-pressed'), 'false');
});

check('ChatGPT accepts a thinking pill whose aria state updates asynchronously after click', () => {
  const pill = button({
    text: '思考',
    attributes: { 'aria-pressed': 'false' },
    onClick: () => {},
  });
  const out = run(chatgpt, 'applyMode', makeDocument(pill), { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true, pending: true });
  assert.strictEqual(pill.clicks, 1);
  assert.strictEqual(pill.getAttribute('aria-pressed'), 'false');
});

check('Qwen recognizes and fills a visible contenteditable composer', () => {
  const composer = new FakeElement('div', { attributes: { contenteditable: 'true', role: 'textbox', 'data-placeholder': '请输入问题' } });
  const sendWrap = new FakeElement('div', { className: 'chat-prompt-send-button' });
  const send = sendWrap.append(button({ className: 'send-button', attributes: { 'aria-label': '发送' } }));
  const document = makeDocument(composer, sendWrap);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(qwen, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(qwen, 'fillPrompt', document, '你好 Qwen').result, true);
  assert.strictEqual(composer.textContent, '你好 Qwen');
  assert.strictEqual(composer.events[0].type, 'input');
  assert.strictEqual(run(qwen, 'clickSend', document).result, true);
  assert.strictEqual(send.clicks, 1);
});

check('Qwen prefers its current composer and exact send selector', () => {
  const legacy = new FakeTextarea({ className: 'qwen-chat-v2-input-textarea' });
  const composer = new FakeTextarea({ className: 'message-input-textarea' });
  const sendWrap = new FakeElement('div', { className: 'chat-prompt-send-button' });
  const send = sendWrap.append(button({ className: 'send-button', attributes: { 'aria-label': 'Send' } }));
  const document = makeDocument(legacy, composer, sendWrap);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(qwen, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(qwen, 'clickSend', document).result, true);
  assert.strictEqual(send.clicks, 1);
  assert.strictEqual(run(qwen, 'fillPrompt', document, '你好').result, true);
  assert.strictEqual(composer.value, '你好');
});

check('Qwen sends through its Chinese-labelled control without clicking a generic decoy', () => {
  const sendWrap = new FakeElement('div', { className: 'chat-prompt-send-button' });
  const qwenSend = sendWrap.append(button({ className: 'send-button', attributes: { 'aria-label': '发送' } }));
  const genericSend = button({ attributes: { 'aria-label': 'Send' } });
  const document = makeDocument(sendWrap, genericSend);
  assert.strictEqual(run(qwen, 'clickSend', document).result, true);
  assert.strictEqual(qwenSend.clicks, 1);
  assert.strictEqual(genericSend.clicks, 0);
});

check('Qwen never clicks a generic page Send button outside Qwen controls', () => {
  const genericSend = button({ attributes: { 'aria-label': 'Send' } });
  const document = makeDocument(genericSend);
  assert.strictEqual(run(qwen, 'clickSend', document).result, false);
  assert.strictEqual(genericSend.clicks, 0);
});

check('Qwen recognizes its visible stop control while generating', () => {
  const wrap = new FakeElement('div', { className: 'chat-prompt-send-button' });
  wrap.append(button({ className: 'stop-button', attributes: { 'aria-label': 'Stop' } }));
  assert.strictEqual(run(qwen, 'detectGenerating', makeDocument(wrap)).result, true);
});

check('Qwen configures visible thinking only after the control reports enabled', () => {
  const thinking = button({
    attributes: { 'aria-label': 'Thinking', 'aria-pressed': 'false' },
    onClick: (element) => element.setAttribute('aria-pressed', 'true'),
  });
  const out = run(qwen, 'applyMode', makeDocument(thinking), { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(thinking.clicks, 1);
  assert.strictEqual(thinking.getAttribute('aria-pressed'), 'true');
});

check('Qwen explicitly rejects unavailable search rather than silently using another mode', () => {
  const out = run(qwen, 'applyMode', makeDocument(), { search: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: false, kind: 'mode_unavailable', mode: 'search' });
});

check('Qwen ignores a hidden login control when deciding authenticated state', () => {
  const hiddenLogin = button({ text: '登录', hidden: true });
  assert.strictEqual(run(qwen, 'detectLogin', makeDocument(hiddenLogin)).result, false);
});

check('Qwen detects rate-limit copy', () => {
  const document = makeDocument(new FakeElement('div', { text: '请求过于频繁，请稍后再试' }));
  assert.strictEqual(run(qwen, 'detectLimit', document).result, 'rate_limited');
});

check('DeepSeek adapter is compatibility metadata only', () => {
  assert.deepStrictEqual(
    { id: deepseek.id, label: deepseek.label, siteUrl: deepseek.siteUrl, defaultProfilePrefix: deepseek.defaultProfilePrefix },
    { id: 'deepseek', label: 'DeepSeek Web', siteUrl: 'https://chat.deepseek.com/', defaultProfilePrefix: 'deepseek' },
  );
  assert.deepStrictEqual(deepseek.expressions, {});
});

console.log('\nSummary: ' + pass + ' passed');
