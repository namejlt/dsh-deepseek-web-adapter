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

  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const idx = siblings.indexOf(this);
      if (idx >= 0) siblings.splice(idx, 1);
      this.parentElement = null;
    }
  }

  cloneNode(deep) {
    const Fake = this.constructor || FakeElement;
    const attrs = {};
    if (this.attributes) for (const k of Object.keys(this.attributes)) attrs[k] = this.attributes[k];
    const clone = new Fake(this.tagName.toLowerCase(), {
      attributes: attrs,
      className: this.className,
      hidden: !!this.hidden,
      disabled: !!this.disabled,
      style: Object.assign({}, this.style),
      text: this.textContent || '',
    });
    if (Fake === FakeTextarea) clone._value = this._value;
    if (deep) for (const c of this.children || []) clone.append(c.cloneNode(true));
    return clone;
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
  assert.ok(composer.events.some((e) => e.type === 'input'), 'at least one input event should be dispatched');
});

check('ChatGPT recognizes and fills its current contenteditable prompt', () => {
  const form = new FakeElement('form', { attributes: { 'data-testid': 'prompt-form' } });
  const composer = form.append(new FakeElement('div', { attributes: { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox' } }));
  const submit = form.append(button({ attributes: { type: 'submit' } }));
  const document = makeDocument(form);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(chatgpt, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(chatgpt, 'fillPrompt', document, 'hello editable ChatGPT').result, true);
  assert.strictEqual(composer.textContent, 'hello editable ChatGPT');
  assert.ok(composer.events.some((e) => e.type === 'input'), 'at least one input event should be dispatched');
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

check('Qwen exposes the qianwen adapter metadata and full expression set', () => {
  assert.deepStrictEqual(
    { id: qwen.id, label: qwen.label, siteUrl: qwen.siteUrl, defaultProfilePrefix: qwen.defaultProfilePrefix },
    { id: 'qwen', label: 'Qwen Web', siteUrl: 'https://www.qianwen.com/', defaultProfilePrefix: 'qwen' },
  );
  assert.deepStrictEqual(Object.keys(qwen.expressions).sort(), [
    'applyMode', 'clickSend', 'detectChallenge', 'detectGenerating', 'detectLimit', 'detectLogin',
    'extractLatest', 'fillPrompt', 'findComposer', 'openNewChat', 'selectModel',
  ]);
  assert(Object.values(qwen.expressions).every((expression) => typeof expression === 'string'));
});

function qianwenComposer() {
  const shell = new FakeElement('div', { attributes: { 'data-chat-input-shell': 'true' } });
  const composer = shell.append(new FakeElement('div', {
    attributes: { role: 'textbox', contenteditable: 'true', 'data-slate-editor': 'true', 'data-placeholder': '向千问提问' },
  }));
  return { shell, composer };
}

check('Qwen finds and fills its slate contenteditable composer', () => {
  const { shell, composer } = qianwenComposer();
  const document = makeDocument(shell);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run(qwen, 'findComposer', document).result)), { found: true });
  assert.strictEqual(run(qwen, 'fillPrompt', document, '你好，千问').result, true);
  assert.strictEqual(composer.textContent, '你好，千问');
  assert.ok(composer.events.some((e) => e.type === 'input'), 'at least one input event should be dispatched');
});

check('Qwen clicks the enabled qianwen send control', () => {
  const { shell } = qianwenComposer();
  const send = shell.append(button({ attributes: { 'data-session-switch-target': 'send-query', 'aria-label': '发送消息' } }));
  const document = makeDocument(shell);
  assert.strictEqual(run(qwen, 'clickSend', document).result, true);
  assert.strictEqual(send.clicks, 1);
});

check('Qwen refuses to click a disabled send control', () => {
  const { shell } = qianwenComposer();
  const send = shell.append(button({ attributes: { 'data-session-switch-target': 'send-query', 'aria-label': '发送消息' }, disabled: true }));
  const document = makeDocument(shell);
  assert.strictEqual(run(qwen, 'clickSend', document).result, false);
  assert.strictEqual(send.clicks, 0);
});

check('Qwen never clicks a generic page Send button outside its composer', () => {
  const genericSend = button({ attributes: { 'aria-label': 'Send' } });
  const document = makeDocument(genericSend);
  assert.strictEqual(run(qwen, 'clickSend', document).result, false);
  assert.strictEqual(genericSend.clicks, 0);
});

check('Qwen detects its stop control while generating', () => {
  assert.strictEqual(run(qwen, 'detectGenerating', makeDocument(button({ attributes: { 'aria-label': '停止回答' } }))).result, true);
  assert.strictEqual(run(qwen, 'detectGenerating', makeDocument(button({ attributes: { 'aria-label': '发送消息' } }))).result, false);
});

check('Qwen switches its mode dropdown from 快速 to 思考研究', () => {
  let menu = null;
  const document = makeDocument();
  const fastItem = new FakeElement('div', {
    attributes: { role: 'menuitemcheckbox', 'aria-checked': 'true', 'data-state': 'checked' },
    text: '快速 适用于大多数情况',
  });
  const thinkItem = new FakeElement('div', {
    attributes: { role: 'menuitemcheckbox', 'aria-checked': 'false', 'data-state': 'unchecked' },
    text: '思考研究 深度搜索、深度研究',
    onClick: (element) => {
      element.setAttribute('aria-checked', 'true');
      element.setAttribute('data-state', 'checked');
      fastItem.setAttribute('aria-checked', 'false');
      fastItem.setAttribute('data-state', 'unchecked');
    },
  });
  const trigger = button({
    text: '快速',
    attributes: { 'aria-haspopup': 'menu', 'aria-label': '快速', 'aria-expanded': 'false' },
    onClick: () => {
      if (!menu) {
        menu = new FakeElement('div', { attributes: { 'data-radix-menu-content': '', role: 'menu' } });
        menu.append(fastItem);
        menu.append(thinkItem);
        document.body.append(menu);
      }
    },
  });
  document.body.append(trigger);
  const out = run(qwen, 'applyMode', document, { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(thinkItem.clicks, 1);
  assert.strictEqual(thinkItem.getAttribute('aria-checked'), 'true');
  assert.strictEqual(fastItem.getAttribute('aria-checked'), 'false');
});

check('Qwen keeps its mode untouched when it already matches', () => {
  const trigger = button({ text: '思考研究', attributes: { 'aria-haspopup': 'menu', 'aria-label': '思考研究' } });
  const out = run(qwen, 'applyMode', makeDocument(trigger), { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(trigger.clicks, 0);
});

check('Qwen ignores aria-hidden measure capsules when locating its mode trigger', () => {
  const wrap = new FakeElement('div', { attributes: { 'aria-hidden': 'true' } });
  wrap.append(button({ text: '快速', attributes: { 'aria-haspopup': 'menu', 'aria-label': '快速' } }));
  const out = run(qwen, 'applyMode', makeDocument(wrap), { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: false, kind: 'mode_unavailable', mode: 'thinking' });
});

check('Qwen explicitly rejects unavailable search rather than silently using another mode', () => {
  const out = run(qwen, 'applyMode', makeDocument(), { search: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: false, kind: 'mode_unavailable', mode: 'search' });
});

check('Qwen finds its mode trigger via aria-label even when inner text is empty', () => {
  let menu = null;
  const document = makeDocument();
  const fastItem = new FakeElement('div', {
    attributes: { role: 'menuitemcheckbox', 'aria-checked': 'true', 'data-state': 'checked' },
    text: '快速 适用于大多数情况',
  });
  const thinkItem = new FakeElement('div', {
    attributes: { role: 'menuitemcheckbox', 'aria-checked': 'false', 'data-state': 'unchecked' },
    text: '思考研究 深度搜索、深度研究',
    onClick: (element) => {
      element.setAttribute('aria-checked', 'true');
      element.setAttribute('data-state', 'checked');
      fastItem.setAttribute('aria-checked', 'false');
      fastItem.setAttribute('data-state', 'unchecked');
    },
  });
  const trigger = button({
    text: '',
    attributes: { 'aria-haspopup': 'menu', 'aria-label': '快速', 'aria-expanded': 'false' },
    onClick: () => {
      if (!menu) {
        menu = new FakeElement('div', { attributes: { 'data-radix-menu-content': '', role: 'menu' } });
        menu.append(fastItem);
        menu.append(thinkItem);
        document.body.append(menu);
      }
    },
  });
  document.body.append(trigger);
  const out = run(qwen, 'applyMode', document, { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(thinkItem.clicks, 1);
});

check('Qwen recognizes its mode via icon (qwpcicon-flash/expertMode) regardless of text content', () => {
  const flashIcon = new FakeElement('span', { attributes: { 'data-icon-type': 'qwpcicon-flash' }, text: '' });
  const triggerNoText = new FakeElement('button', {
    attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    text: '',
  });
  triggerNoText.append(flashIcon);
  let menu = null;
  const document = makeDocument(triggerNoText);
  const fastItemIcon = new FakeElement('span', { attributes: { 'data-icon-type': 'qwpcicon-flash' } });
  const fastItem = new FakeElement('div', {
    attributes: { role: 'menuitemcheckbox', 'aria-checked': 'true', 'data-state': 'checked' },
    text: '',
  });
  fastItem.append(fastItemIcon);
  const expertIcon = new FakeElement('span', { attributes: { 'data-icon-type': 'qwpcicon-expertMode' } });
  const thinkItem = new FakeElement('div', {
    attributes: { role: 'menuitemcheckbox', 'aria-checked': 'false', 'data-state': 'unchecked' },
    text: '',
    onClick: (element) => {
      element.setAttribute('aria-checked', 'true');
      element.setAttribute('data-state', 'checked');
      fastItem.setAttribute('aria-checked', 'false');
      fastItem.setAttribute('data-state', 'unchecked');
    },
  });
  thinkItem.append(expertIcon);
  triggerNoText.onClick = () => {
    if (!menu) {
      menu = new FakeElement('div', { attributes: { 'data-radix-menu-content': '', role: 'menu' } });
      menu.append(fastItem);
      menu.append(thinkItem);
      document.body.append(menu);
    }
  };
  const out = run(qwen, 'applyMode', document, { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(thinkItem.clicks, 1);
});

check('Qwen stays in thinking mode when trigger shows qwpcicon-expertMode icon even if text is missing', () => {
  const expertIcon = new FakeElement('span', { attributes: { 'data-icon-type': 'qwpcicon-expertMode' } });
  const trigger = new FakeElement('button', {
    attributes: { 'aria-haspopup': 'menu' },
    text: '',
  });
  trigger.append(expertIcon);
  const out = run(qwen, 'applyMode', makeDocument(trigger), { thinking: true }).result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.strictEqual(trigger.clicks, 0);
});

function qianwenModelDom(document, currentModel) {
  const items = [];
  let dialog = null;
  const applySelection = (selected) => {
    for (const other of items) {
      const isTarget = other === selected;
      other.className = 'group cursor-pointer rounded-8 ' + (isTarget ? 'bg-weaken' : 'bg-capsule');
      const check = other.querySelector('[data-icon-type="qwpcicon-check"]');
      if (check) check.className = isTarget ? 'size-4 text-theme' : 'size-4 text-theme invisible';
    }
  };
  const host = new FakeElement('div', {
    text: currentModel,
    attributes: { 'aria-haspopup': 'dialog', 'data-state': 'closed' },
    onClick: () => {
      if (dialog) return;
      dialog = new FakeElement('div', { attributes: { role: 'dialog' }, text: '模型' });
      for (const name of ['Qwen3.7-千问', 'Qwen3.8-Max', 'Qwen3.7-Max', 'Qwen3.6-Flash']) {
        const item = new FakeElement('div', {
          className: 'group cursor-pointer rounded-8 ' + (name === currentModel ? 'bg-weaken' : 'bg-capsule'),
          onClick: (element) => {
            applySelection(element);
            host.textContent = name;
            host.innerText = name;
          },
        });
        item.append(new FakeElement('div', { className: 'truncate', text: name }));
        item.append(new FakeElement('span', {
          attributes: { 'data-icon-type': 'qwpcicon-check' },
          className: name === currentModel ? 'size-4 text-theme' : 'size-4 text-theme invisible',
        }));
        items.push(item);
        dialog.append(item);
      }
      document.body.append(dialog);
    },
  });
  document.body.append(host);
  return { host, items };
}

check('Qwen selects the requested model through its qianwen model dialog', () => {
  const document = makeDocument();
  const { host } = qianwenModelDom(document, 'Qwen3.7-千问');
  const out = run(qwen, 'selectModel', document, 'Qwen3.8-Max').result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true, alreadySelected: false });
  assert.strictEqual(host.clicks, 1);
  assert.strictEqual(host.textContent, 'Qwen3.8-Max');
});

check('Qwen reports the current page model as already selected without opening the dialog', () => {
  const document = makeDocument();
  const { host } = qianwenModelDom(document, 'Qwen3.7-千问');
  const out = run(qwen, 'selectModel', document, 'Qwen3.7-千问').result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true, alreadySelected: true });
  assert.strictEqual(host.clicks, 0);
});

check('Qwen reports model_unavailable for a model missing from the page list', () => {
  const document = makeDocument();
  qianwenModelDom(document, 'Qwen3.7-千问');
  const out = run(qwen, 'selectModel', document, 'Qwen9-Turbo').result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: false, kind: 'model_unavailable', reason: 'model not found: Qwen9-Turbo' });
});

check('Qwen ignores non-dialog cursor-pointer decoys when opening its model dialog', () => {
  const document = makeDocument();
  const decoy = new FakeElement('div', { className: 'cursor-pointer rounded-8' });
  decoy.append(new FakeElement('div', { className: 'truncate', text: '历史会话 3' }));
  document.body.append(decoy);
  const { host } = qianwenModelDom(document, 'Qwen3.7-千问');
  const out = run(qwen, 'selectModel', document, 'Qwen3.8-Max').result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true, alreadySelected: false });
  assert.strictEqual(host.clicks, 1, 'must open the dialog instead of matching the decoy');
  assert.strictEqual(host.textContent, 'Qwen3.8-Max');
});

check('Qwen collects model items from a popper wrapper without role=dialog', () => {
  const document = makeDocument();
  const wrapper = new FakeElement('div', { attributes: { 'data-radix-popper-content-wrapper': '' }, text: '模型' });
  const item = new FakeElement('div', { className: 'group cursor-pointer rounded-8' });
  item.append(new FakeElement('div', { className: 'truncate', text: 'Qwen3.8-Max' }));
  item.append(new FakeElement('span', { attributes: { 'data-icon-type': 'qwpcicon-check' }, className: 'size-4 text-theme invisible' }));
  wrapper.append(item);
  const host = new FakeElement('div', {
    text: 'Qwen3.7-千问',
    attributes: { 'aria-haspopup': 'dialog', 'data-state': 'closed' },
    onClick: (element) => {
      document.body.append(wrapper);
      element.textContent = 'Qwen3.8-Max';
      element.innerText = 'Qwen3.8-Max';
    },
  });
  document.body.append(host);
  const out = run(qwen, 'selectModel', document, 'Qwen3.8-Max').result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true, alreadySelected: false });
  assert.strictEqual(host.clicks, 1);
  assert.strictEqual(item.clicks, 1);
});

check('Qwen falls back to exact .truncate matching when the dialog has no portal markers', () => {
  const document = makeDocument();
  const plain = new FakeElement('div', { text: '模型' });
  const item = new FakeElement('div', { className: 'group cursor-pointer rounded-8' });
  item.append(new FakeElement('div', { className: 'truncate', text: 'Qwen3.6-Flash' }));
  plain.append(item);
  const host = new FakeElement('div', {
    text: 'Qwen3.7-千问',
    attributes: { 'aria-haspopup': 'dialog', 'data-state': 'closed' },
    onClick: (element) => {
      document.body.append(plain);
      element.textContent = 'Qwen3.6-Flash';
      element.innerText = 'Qwen3.6-Flash';
    },
  });
  document.body.append(host);
  const out = run(qwen, 'selectModel', document, 'Qwen3.6-Flash').result;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true, alreadySelected: false });
  assert.strictEqual(host.clicks, 1);
  assert.strictEqual(item.clicks, 1);
});

check('Qwen ignores a hidden login control when deciding authenticated state', () => {
  const hiddenLogin = button({ text: '登录', hidden: true });
  assert.strictEqual(run(qwen, 'detectLogin', makeDocument(hiddenLogin)).result, false);
});

check('Qwen detects rate-limit copy', () => {
  const document = makeDocument(new FakeElement('div', { text: '请求过于频繁，请稍后再试' }));
  assert.strictEqual(run(qwen, 'detectLimit', document).result, 'rate_limited');
});

check('Qwen strips react-syntax-highlighter line numbers and produces clean tool_call JSON', () => {
  /* 构造用户提供的真实 HTML 片段的简化版：
   *  .chat-answers-card-wrap > .qw-md-code > header(.font-medium.mr-auto = "tool_call")
   *    > pre > code > [ [行号"1" "{\n"], ["2" "  \"name\":\"web_search\",\n"], ... ]
   * 重点：.qw-md-code 带语言标签 tool_call 时，即使内部用 <table> 包装的行号节点
   * 也要能剥离，并生成 fenced ```tool_call\nJSON\n```。 */
  const TOOL_JSON = [
    '{',
    '  "name": "web_search",',
    '  "args": {',
    '    "queries": [',
    '      "北京今天天气"',
    '    ]',
    '  }',
    '}',
  ];

  const makeCodeLine = (num, text) => {
    const tr = new FakeElement('tr');
    const tdNum = new FakeElement('td', {
      className: 'react-syntax-highlighter-line-number linenumber',
      text: String(num) + ' ',
      attributes: { 'data-line-number': String(num) },
    });
    const tdCode = new FakeElement('td');
    tdCode.append(new FakeElement('span', { text: text + '\n' }));
    tr.append(tdNum);
    tr.append(tdCode);
    return tr;
  };

  const tbody = new FakeElement('tbody');
  TOOL_JSON.forEach((line, i) => tbody.append(makeCodeLine(i + 1, line)));
  const table = new FakeElement('table');
  table.append(tbody);
  const pre = new FakeElement('pre', { className: 'sc-bRKDuR jCSJQZ' });
  pre.append(table);
  const code = new FakeElement('code', { className: 'language-json' });
  code.append(pre);  /* 让 codeEl.querySelector('code') 命中自身/子节点 */

  const hlWrap = new FakeElement('div', { className: 'codeHighlighterWrapper-_O3AS8' });
  hlWrap.append(code);

  /* header: <span class="font-medium mr-auto text-12 ...">tool_call</span> + copy icon */
  const langLabel = new FakeElement('span', {
    className: 'font-medium mr-auto text-12 overflow-ellipsis whitespace-nowrap overflow-hidden',
    text: 'tool_call',
  });
  const copyBtn = new FakeElement('button', {
    className: 'cursor-pointer h-6 px-1',
  });
  const copyIcon = new FakeElement('span', {
    className: 'text-primary',
    attributes: { 'data-icon-type': 'qwpcicon-copy' },
    text: '',
  });
  copyBtn.append(copyIcon);
  const headerRow = new FakeElement('div', { className: 'flex items-center h-[36px] px-3 text-12' });
  headerRow.append(langLabel);
  headerRow.append(copyBtn);
  const headerWrap = new FakeElement('div', { className: 'h-[36px] sticky top-0 z-10 bg-primary' });
  headerWrap.append(headerRow);

  const qwMdCode = new FakeElement('div', { className: 'contain-layout-style relative mb-4 flex min-h-[2em] flex-col rounded-12 bg-capsule qw-md-code' });
  qwMdCode.append(headerWrap);
  qwMdCode.append(hlWrap);

  const md = new FakeElement('div', { className: 'qk-markdown qk-markdown-react qk-markdown-complete' });
  md.append(qwMdCode);

  const answer = new FakeElement('div', { className: 'answer-common-card' });
  answer.append(md);

  const cardWrap = new FakeElement('div', {
    className: 'chat-answers-card-wrap',
    attributes: { 'data-chat-answers-wrap': 'd192Mzw9yevTPP4w2v-Dpj1SqDpOgMWm' },
  });
  cardWrap.append(answer);

  const document = makeDocument(cardWrap);
  const out = run(qwen, 'extractLatest', document).result;
  const text = String(out.text || '');

  /* 1. 行号前缀 "1 {" "2   " 绝对不能出现在 fence JSON 中 */
  assert.ok(!/\b1\s*\{/.test(text), 'text should NOT embed "1 {": ' + JSON.stringify(text.slice(0, 220)));
  assert.ok(!/\"2\s+\\\"name\\\"\"/.test(text.replace(/\s+/g,' ')), 'line 2 "name" line-number must be stripped');

  /* 2. 输出必须包含完整、合法的 tool_call JSON */
  const cleanMatches = text.match(/\{\s*\"name\"\s*:\s*\"web_search\"[\s\S]*?\"北京今天天气\"[\s\S]*?\}\s*\}/);
  assert.ok(!!cleanMatches, 'tool_call JSON must be present without line-number pollution');
  try {
    const parsed = JSON.parse(cleanMatches[0]);
    assert.strictEqual(parsed.name, 'web_search');
    assert.deepStrictEqual(parsed.args.queries, ['北京今天天气']);
  } catch (e) {
    assert.fail('tool_call JSON should be valid after strip: ' + e.message + '\nCaptured: ' + cleanMatches[0]);
  }

  /* 3. 必须有 fenced ```tool_call``` 块（parseToolCalls 优先匹配） */
  assert.ok(/```tool_call\s*\n/.test(text), 'fenced ```tool_call block must be present for parser');
  const fenceMatch = text.match(/```tool_call\s*\n([\s\S]*?)\n```/);
  assert.ok(!!fenceMatch, 'fenced tool_call block must be fully closed');
  const fenceJson = JSON.parse(fenceMatch[1].trim());
  assert.strictEqual(fenceJson.name, 'web_search');
  assert.deepStrictEqual(fenceJson.args.queries, ['北京今天天气']);
});

check('Qwen extractLatest handles fallback JSON code block even without explicit tool_call language tag', () => {
  /* 模拟：语言标签缺失 / 纯 pre code 代码块（不在 .qw-md-code 胶囊里），行号仍需被剥离。
   * 注意：.qw-md-code 内部若没有明确的 tool_call/json 语言标签，会被视为 markdown
   * 表格块，不再生成 fence；所以这里用独立 <pre> 不在 md-code 里。 */
  const rows = new FakeElement('code');
  const lines = ['{', '  "name": "python_eval",', '  "args": { "expr": "1+1" }', '}'];
  lines.forEach((ln, i) => {
    const row = new FakeElement('span');
    row.append(new FakeElement('span', { className: 'linenumber', text: String(i + 1) }));
    row.append(new FakeElement('span', { text: ln + '\n' }));
    rows.append(row);
  });
  const pre = new FakeElement('pre');
  pre.append(rows);
  const wrap = new FakeElement('div', { className: 'markdown body' });
  wrap.append(pre);
  const document = makeDocument(wrap);
  const text = String(run(qwen, 'extractLatest', document).result.text || '');
  assert.ok(!/^1\s*\{/m.test(text), 'no line-number "1 {" prefix after strip: ' + JSON.stringify(text.slice(0, 150)));
  /* 优先从 fence 中取（更干净）；否则从 prose 中取第一个完整对象 */
  const fenceMatch = text.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\n```/);
  const rawObj = fenceMatch ? fenceMatch[1] : text.match(/\{[\s\S]*?\}\s*\}/s)[0];
  const obj = JSON.parse(rawObj);
  assert.strictEqual(obj.name, 'python_eval');
  assert.deepStrictEqual(obj.args, { expr: '1+1' });
});

check('Qwen extractLatest does not duplicate a markdown weather answer with table-toolbar action buttons', () => {
  /* 复现用户提供的天气报告重复场景：
   * root(.chat-answers-card-wrap)
   *   ├ H3：🌤️ 南京当前天气
   *   ├ .qw-md-code  ── 无 tool_call 语言标签，渲染成 markdown 表格（项目 / 数据）
   *   │                 + 顶部按钮「下载为表格」「导出为图片」
   *   ├ H3：📅 今日全天概况
   *   ├ 列表 bullet
   *   ├ H3：🕐 今晚分时预报
   *   └ .qw-md-code  ── 同上，分时预报表格 + 操作按钮
   * 期望：每块内容只出现 **一次**，按钮文案不污染，不出现 3 次重复。 */

  const toolbar = () => {
    const bar = new FakeElement('div', { className: 'flex items-center gap-2 toolbar' });
    ['下载为表格', '导出为图片', '复制'].forEach((label) => {
      const b = new FakeElement('button', {
        className: 'cursor-pointer h-6 px-1 text-14',
        text: label,
      });
      bar.append(b);
    });
    return bar;
  };
  const tableHeader = (left, right) => {
    const tr = new FakeElement('tr');
    tr.append(new FakeElement('th', { text: left }));
    tr.append(new FakeElement('th', { text: right }));
    return tr;
  };
  const tableRow = (left, right) => {
    const tr = new FakeElement('tr');
    tr.append(new FakeElement('td', { text: left }));
    tr.append(new FakeElement('td', { text: right }));
    return tr;
  };

  const curTable = new FakeElement('table');
  const curThead = new FakeElement('thead');
  curThead.append(tableHeader('项目', '数据'));
  curTable.append(curThead);
  const curTbody = new FakeElement('tbody');
  curTbody.append(tableRow('天气', '晴'));
  curTbody.append(tableRow('气温', '31℃（体感 36℃）'));
  curTbody.append(tableRow('湿度', '68%'));
  curTable.append(curTbody);
  const curWrap = new FakeElement('div', { className: 'qw-md-code rounded-12 bg-capsule' });
  curWrap.append(toolbar());
  curWrap.append(curTable);

  const h3Now = new FakeElement('h3', { className: 'text-lg font-medium', text: '🌤️ 南京当前天气（8月26日 18:41）' });
  const h3Sum = new FakeElement('h3', { className: 'text-lg font-medium', text: '📅 今日全天概况' });
  const ulSum = (() => {
    const ul = new FakeElement('ul', { className: 'list-disc ml-6' });
    ['气温范围：24℃ ~ 34℃', '天气：多云', '日出/日落：05:37 / 18:37'].forEach((t) => {
      const li = new FakeElement('li');
      li.append(new FakeElement('span', { text: t }));
      ul.append(li);
    });
    return ul;
  })();
  const h3Hour = new FakeElement('h3', { className: 'text-lg font-medium', text: '🕐 今晚分时预报' });

  const hourTable = new FakeElement('table');
  const hourThead = new FakeElement('thead');
  const hr = new FakeElement('tr');
  ['时间', '气温', '天气', '风力'].forEach((t) => hr.append(new FakeElement('th', { text: t })));
  hourThead.append(hr);
  hourTable.append(hourThead);
  const hourBody = new FakeElement('tbody');
  [['19时', '30℃', '晴', '东风 3-4级'], ['20时', '29℃', '晴', '东风 <3级']].forEach((row) => {
    const tr = new FakeElement('tr');
    row.forEach((c) => tr.append(new FakeElement('td', { text: c })));
    hourBody.append(tr);
  });
  hourTable.append(hourBody);
  const hourWrap = new FakeElement('div', { className: 'qw-md-code rounded-12 bg-capsule' });
  hourWrap.append(toolbar());
  hourWrap.append(hourTable);

  const tipText = '💡 今晚南京天气晴好，气温从31℃缓慢降至28℃左右，但湿度较高（74%~84%），体感偏闷热。空气质量优秀，适合外出散步，不过注意防暑补水。';
  const tip = new FakeElement('blockquote', { text: tipText });

  const root = new FakeElement('div', { className: 'chat-answers-card-wrap' });
  [h3Now, curWrap, h3Sum, ulSum, h3Hour, hourWrap, tip].forEach((n) => root.append(n));

  const out = run(qwen, 'extractLatest', makeDocument(root)).result;
  const text = String(out.text || '');

  /* A. 关键语义行必须存在且只出现一次 */
  const mustOnce = [
    '🌤️ 南京当前天气（8月26日 18:41）',
    '📅 今日全天概况',
    '🕐 今晚分时预报',
    '气温范围：24℃ ~ 34℃',
    '空气质量优秀，适合外出散步',
    '19时30℃晴',
  ];
  for (const phrase of mustOnce) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = text.match(re) || [];
    assert.strictEqual(matches.length, 1, `expected exactly 1 occurrence of "${phrase}", got ${matches.length}.\nText=${JSON.stringify(text.slice(0, 1800))}`);
  }

  /* B. 表格操作按钮文案不能污染正文（"下载为表格 导出为图片" 不进入 prose） */
  ['下载为表格', '导出为图片'].forEach((label) => {
    assert.ok(
      !text.includes(label),
      `table toolbar phrase "${label}" should NOT leak into extracted text.\nText=${JSON.stringify(text.slice(0, 1800))}`,
    );
  });

  /* C. 粗略去重：天气/气温这些易重复的关键词出现次数不应 >2 倍单份预期 */
  const weatherCount = (text.match(/晴/g) || []).length;
  assert.ok(weatherCount <= 6, `count of "晴" should be <= 6, got ${weatherCount} (duplicate block detected). Text=${JSON.stringify(text.slice(0, 1800))}`);

  /* D. 天气 + 表格报告中并没有 tool_call 语言标签，不应产生 fence 块 */
  assert.ok(
    !/(```[\w_-]*\n[\s\S]*?\n```)/.test(text.replace(/```\w+/g, '')),
    'no markdown fences should be emitted for plain-table .qw-md-code without tool_call/json tag. Found: ' + JSON.stringify(text.slice(0, 1800)),
  );
});


check('Qwen extractLatest selects the latest assistant reply root and preserves DOM order for stream deltas', () => {
  /* 流式阶段回答根卡片内的 Markdown 子树会不断重渲染；若直接从全部 `.markdown`
   * 候选中取最后一个元素，会丢掉根卡片后续正文，且 prose/fence 分组会破坏前缀关系。
   * 提取结果必须是根卡片按 DOM 顺序的累计快照，才能让 driver 只发送 append delta。 */
  const root = new FakeElement('article', { className: 'chat-answers-card-wrap' });
  root.append(new FakeElement('p', { text: '第一段正文' }));
  const markdown = root.append(new FakeElement('div', { className: 'markdown body' }));
  const pre = markdown.append(new FakeElement('pre'));
  pre.append(new FakeElement('code', { text: 'const answer = 42;' }));
  root.append(new FakeElement('p', { text: '第二段正文' }));

  const text = String(run(qwen, 'extractLatest', makeDocument(root)).result.text || '');
  const first = text.indexOf('第一段正文');
  const code = text.indexOf('const answer = 42;');
  const second = text.indexOf('第二段正文');
  assert.ok(first >= 0 && code > first && second > code, 'expected root content in DOM order, got: ' + JSON.stringify(text));
});

check('DeepSeek adapter is compatibility metadata only', () => {
  assert.deepStrictEqual(
    { id: deepseek.id, label: deepseek.label, siteUrl: deepseek.siteUrl, defaultProfilePrefix: deepseek.defaultProfilePrefix },
    { id: 'deepseek', label: 'DeepSeek Web', siteUrl: 'https://chat.deepseek.com/', defaultProfilePrefix: 'deepseek' },
  );
  assert.deepStrictEqual(deepseek.expressions, {});
});

console.log('\nSummary: ' + pass + ' passed');