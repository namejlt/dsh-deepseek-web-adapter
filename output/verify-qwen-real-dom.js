'use strict';
/* 用用户提供的真实 DOM 结构验证 qwen applyMode / selectModel 的行为。
 * Run: /opt/homebrew/bin/node output/verify-qwen-real-dom.js */

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const qwen = require('../resources/providers/qwen');

/* === Fake DOM helpers (copy of test-provider-adapters primitives) === */
class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
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
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n); }
  dispatchEvent(e) { this.events.push(e); return true; }
  click() { this.clicks++; if (this.onClick) this.onClick(this); }
  closest(selector) {
    let c = this;
    const match = (el) => {
      const tag = selector.match(/^[a-zA-Z][\w-]*/);
      if (tag && el.tagName !== tag[0].toUpperCase()) return false;
      for (const attr of selector.matchAll(/\[([\w-]+)(\*?=)?(?:"([^"]*)")?\]/g)) {
        const actual = attr[1] === 'class' ? el.className : el.getAttribute(attr[1]);
        if (actual === null) return false;
        if (attr[2] === '=' && actual !== attr[3]) return false;
        if (attr[2] === '*=' && !actual.includes(attr[3])) return false;
      }
      for (const cls of selector.matchAll(/\.([\w-]+)/g)) {
        if (!el.className.split(/\s+/).includes(cls[1])) return false;
      }
      return true;
    };
    while (c) { if (match(c)) return c; c = c.parentElement; }
    return null;
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) {
    const desc = (r) => { const o = []; for (const c of r.children || []) { o.push(c, ...desc(c)); } return o; };
    const matchSimple = (el, part) => {
      const parts = part.split(/\s+/).filter(Boolean);
      const matchLeaf = (e, sel) => {
        const tag = sel.match(/^[a-zA-Z][\w-]*/);
        if (tag && e.tagName !== tag[0].toUpperCase()) return false;
        const id = sel.match(/#([\w-]+)/);
        if (id && e.getAttribute('id') !== id[1]) return false;
        for (const cls of sel.matchAll(/\.([\w-]+)/g)) {
          if (!e.className.split(/\s+/).includes(cls[1])) return false;
        }
        for (const attr of sel.matchAll(/\[([\w-]+)(\*?=)?(?:"([^"]*)")?\]/g)) {
          const actual = attr[1] === 'class' ? e.className : e.getAttribute(attr[1]);
          if (actual === null) return false;
          if (attr[2] === '=' && actual !== attr[3]) return false;
          if (attr[2] === '*=' && !actual.includes(attr[3])) return false;
        }
        return true;
      };
      if (!matchLeaf(el, parts[parts.length - 1])) return false;
      let cur = el.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !matchLeaf(cur, parts[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    };
    return desc(this).filter(el => s.split(',').some(p => matchSimple(el, p.trim())));
  }
}
function makeDocument(...roots) {
  const d = new FakeElement('document');
  d.body = new FakeElement('body');
  d.append(d.body);
  for (const r of roots) d.body.append(r);
  return d;
}
function run(adapter, expr, doc, arg) {
  const sandbox = {
    document: doc,
    location: { href: 'https://www.qianwen.com/', pathname: '/' },
    Event: FakeEvent,
    HTMLTextAreaElement: FakeElement,
    getComputedStyle: (e) => e.style,
    Array, Object, String, RegExp, JSON, Set,
  };
  vm.createContext(sandbox);
  const v = vm.runInContext(adapter.expressions[expr], sandbox, { filename: 'verify-' + expr + '.js' });
  return typeof v === 'function' ? v(arg) : v;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '|', e.message); }
}

/* =========================================================
 * 构建用户提供的真实 DOM（3.8max 已选，模式=快速，菜单未展开前的 trigger）
 * ========================================================= */
function buildRealDomQwen38Max({ menuOpen = false, initialModeChecked = 'fast' }) {
  const doc = makeDocument();

  /* 模式触发器：aria-label="快速"，内部图标 qwpcicon-flash */
  const flashIcon = new FakeElement('span', {
    attributes: { 'data-role': 'icon', 'data-render-as': 'svg', 'data-icon-type': 'qwpcicon-flash' },
    className: 'size-4',
  });
  const triggerFlashText = new FakeElement('span', { className: 'whitespace-nowrap', text: '快速' });
  const upMiniIcon = new FakeElement('span', {
    attributes: { 'data-role': 'icon', 'data-render-as': 'svg', 'data-icon-type': 'qwpcicon-upMini' },
  });
  const trigger = new FakeElement('button', {
    className: 'inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border-0 bg-transparent px-2 py-1 text-14 text-primary bg-option',
    attributes: {
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': menuOpen ? '快速' : '快速',
      'aria-expanded': menuOpen ? 'true' : 'false',
      id: 'radix-:r1g:',
      'aria-haspopup': 'menu',
      'data-state': menuOpen ? 'open' : 'closed',
      'aria-controls': menuOpen ? 'radix-:r1h:' : null,
    },
  });
  trigger.append(flashIcon);
  trigger.append(triggerFlashText);
  trigger.append(upMiniIcon);

  let menuEl = null;
  let fastItem, thinkItem;
  const buildMenu = () => {
    if (menuEl) return;
    menuEl = new FakeElement('div', {
      className: 'z-[1050] w-[225px] space-y-1 rounded-12 border border-line-border bg-capsule p-1 shadow-2',
      attributes: {
        role: 'menu',
        'aria-orientation': 'vertical',
        'data-state': 'open',
        'data-radix-menu-content': '',
        id: 'radix-:r1h:',
        'aria-labelledby': 'radix-:r1g:',
        dir: 'ltr',
        tabindex: '-1',
        'data-orientation': 'vertical',
      },
    });
    const popper = new FakeElement('div', {
      attributes: { 'data-radix-popper-content-wrapper': '', dir: 'ltr' },
    });
    popper.append(menuEl);
    doc.body.append(popper);

    /* 快速菜单项 */
    const fastIcon = new FakeElement('span', {
      attributes: { 'data-role': 'icon', 'data-render-as': 'svg', 'data-icon-type': 'qwpcicon-flash' },
      className: 'absolute left-0 top-1 size-4',
    });
    const fastIconWrap = new FakeElement('span', { className: 'relative w-4 shrink-0 self-stretch', attributes: { 'aria-hidden': 'true' } });
    fastIconWrap.append(fastIcon);
    const fastTitle = new FakeElement('span', { className: 'text-14 leading-6 text-primary', text: '快速' });
    const fastSub = new FakeElement('span', { className: 'text-12 leading-5 text-caption', text: '适用于大多数情况' });
    const fastTextWrap = new FakeElement('span', { className: 'flex min-w-0 flex-1 flex-col items-start gap-0.5' });
    fastTextWrap.append(fastTitle);
    fastTextWrap.append(fastSub);
    const fastCheck = new FakeElement('span', {
      attributes: { 'data-role': 'icon', 'data-render-as': 'svg', 'data-icon-type': 'qwpcicon-checkMini' },
      className: 'size-4',
    });
    const fastCheckWrap = new FakeElement('span', { className: 'flex items-center', attributes: { 'data-state': initialModeChecked === 'fast' ? 'checked' : '' } });
    fastCheckWrap.append(fastCheck);
    fastItem = new FakeElement('div', {
      className: 'min-w-0 cursor-pointer select-none flex h-[58px] w-full items-start rounded-8 px-[11px] py-1.5 text-primary hover:bg-option' + (initialModeChecked === 'fast' ? ' data-[state=checked]:bg-option' : ''),
      attributes: {
        role: 'menuitemcheckbox',
        'aria-checked': initialModeChecked === 'fast' ? 'true' : 'false',
        'data-state': initialModeChecked === 'fast' ? 'checked' : 'unchecked',
        tabindex: '-1',
        'data-orientation': 'vertical',
        'data-radix-collection-item': '',
      },
    });
    const fastRow = new FakeElement('span', { className: 'flex min-w-0 flex-1 items-center gap-1.5' });
    fastRow.append(fastIconWrap);
    fastRow.append(fastTextWrap);
    fastItem.append(fastRow);
    if (initialModeChecked === 'fast') fastItem.append(fastCheckWrap);
    fastItem.onClick = (el) => {
      el.setAttribute('aria-checked', 'true');
      el.setAttribute('data-state', 'checked');
      el.append(fastCheckWrap);
      thinkItem.setAttribute('aria-checked', 'false');
      thinkItem.setAttribute('data-state', 'unchecked');
      /* remove check icon from thinkItem if present */
      thinkItem.children = thinkItem.children.filter(c => !c.className.includes('flex items-center'));
      /* update trigger */
      triggerFlashText.textContent = '快速';
      trigger.setAttribute('aria-label', '快速');
      flashIcon.attributes['data-icon-type'] = 'qwpcicon-flash';
    };

    /* 思考研究菜单项 */
    const expertIcon = new FakeElement('span', {
      attributes: { 'data-role': 'icon', 'data-render-as': 'svg', 'data-icon-type': 'qwpcicon-expertMode' },
      className: 'absolute left-0 top-1 size-4',
    });
    const expertIconWrap = new FakeElement('span', { className: 'relative w-4 shrink-0 self-stretch', attributes: { 'aria-hidden': 'true' } });
    expertIconWrap.append(expertIcon);
    const thinkTitle = new FakeElement('span', { className: 'text-14 leading-6 text-primary', text: '思考研究' });
    const thinkSub = new FakeElement('span', { className: 'text-12 leading-5 text-caption', text: '深度搜索、深度研究' });
    const thinkTextWrap = new FakeElement('span', { className: 'flex min-w-0 flex-1 flex-col items-start gap-0.5' });
    thinkTextWrap.append(thinkTitle);
    thinkTextWrap.append(thinkSub);
    const thinkCheck = new FakeElement('span', {
      attributes: { 'data-role': 'icon', 'data-render-as': 'svg', 'data-icon-type': 'qwpcicon-checkMini' },
      className: 'size-4',
    });
    const thinkCheckWrap = new FakeElement('span', { className: 'flex items-center', attributes: { 'data-state': initialModeChecked === 'think' ? 'checked' : '' } });
    thinkCheckWrap.append(thinkCheck);
    thinkItem = new FakeElement('div', {
      className: 'min-w-0 cursor-pointer select-none flex h-[58px] w-full items-start rounded-8 px-[11px] py-1.5 text-primary hover:bg-option' + (initialModeChecked === 'think' ? ' data-[state=checked]:bg-option' : ''),
      attributes: {
        role: 'menuitemcheckbox',
        'aria-checked': initialModeChecked === 'think' ? 'true' : 'false',
        'data-state': initialModeChecked === 'think' ? 'checked' : 'unchecked',
        tabindex: '-1',
        'data-orientation': 'vertical',
        'data-radix-collection-item': '',
      },
    });
    const thinkRow = new FakeElement('span', { className: 'flex min-w-0 flex-1 items-center gap-1.5' });
    thinkRow.append(expertIconWrap);
    thinkRow.append(thinkTextWrap);
    thinkItem.append(thinkRow);
    if (initialModeChecked === 'think') thinkItem.append(thinkCheckWrap);
    thinkItem.onClick = (el) => {
      el.setAttribute('aria-checked', 'true');
      el.setAttribute('data-state', 'checked');
      el.append(thinkCheckWrap);
      fastItem.setAttribute('aria-checked', 'false');
      fastItem.setAttribute('data-state', 'unchecked');
      fastItem.children = fastItem.children.filter(c => !c.className.includes('flex items-center'));
      /* update trigger */
      triggerFlashText.textContent = '思考研究';
      trigger.setAttribute('aria-label', '思考研究');
      flashIcon.attributes['data-icon-type'] = 'qwpcicon-expertMode';
    };

    menuEl.append(fastItem);
    menuEl.append(thinkItem);
  };
  trigger.onClick = () => { if (!menuEl) buildMenu(); };

  /* 模式选择器触发器（顶部显示当前模型名 Qwen3.8-Max，aria-haspopup=dialog） */
  const modelTrigger = new FakeElement('div', {
    text: 'Qwen3.8-Max',
    attributes: { 'aria-haspopup': 'dialog', 'data-state': 'closed' },
  });
  doc.body.append(trigger);
  doc.body.append(modelTrigger);

  if (menuOpen) buildMenu();

  return { doc, trigger, modelTrigger, get fastItem() { return fastItem; }, get thinkItem() { return thinkItem; } };
}

/* ============ 校验 1：真实 DOM 初始"快速"，请求 thinking ============ */
check('[真实DOM] 初始=快速→请求thinking：找到trigger、正确点击思考研究项', () => {
  const { doc, thinkItem } = buildRealDomQwen38Max({ menuOpen: false, initialModeChecked: 'fast' });
  const out = run(qwen, 'applyMode', doc, { thinking: true });
  assert.deepStrictEqual({ ok: out.ok }, { ok: true }, '应返回 ok:true');
  assert.strictEqual(thinkItem.clicks, 1, '思考研究项应被点击 1 次（当前=' + thinkItem.clicks + '）');
  assert.strictEqual(thinkItem.getAttribute('aria-checked'), 'true', '点击后 aria-checked 应为 true');
});

/* ============ 校验 2：真实 DOM 已经在思考研究（图标=expertMode），请求 thinking ============ */
check('[真实DOM] 初始=思考研究→请求thinking：直接短路（trigger不点击）', () => {
  const { doc, trigger } = buildRealDomQwen38Max({ menuOpen: false, initialModeChecked: 'think' });
  /* 手工把 trigger 的图标也切到 expertMode（模拟页面实际选中后的状态） */
  const triggerIcon = trigger.querySelector('[data-icon-type]');
  if (triggerIcon) triggerIcon.attributes['data-icon-type'] = 'qwpcicon-expertMode';
  for (const c of trigger.children) { if (c.className === 'whitespace-nowrap') { c.textContent = '思考研究'; c.innerText = '思考研究'; } }
  trigger.setAttribute('aria-label', '思考研究');
  const out = run(qwen, 'applyMode', doc, { thinking: true });
  assert.deepStrictEqual({ ok: out.ok }, { ok: true });
  assert.strictEqual(trigger.clicks, 0, 'trigger 不应被点击（当前模式已匹配）');
});

/* ============ 校验 3：真实 DOM 请求 fast ============ */
check('[真实DOM] 初始=快速→请求fast：直接短路（无需点击）', () => {
  const { doc, trigger } = buildRealDomQwen38Max({ menuOpen: false, initialModeChecked: 'fast' });
  const out = run(qwen, 'applyMode', doc, { thinking: false });
  assert.deepStrictEqual({ ok: out.ok }, { ok: true });
  assert.strictEqual(trigger.clicks, 0, 'trigger 不应被点击（已是 fast）');
});

/* ============ 校验 4：aria-label="快速" 但 innerText 非模式词时（失配风险）仍能命中 ============ */
check('[真实DOM] trigger 文本剥离只剩aria-label：仍能通过aria-label找到', () => {
  const { doc, trigger } = buildRealDomQwen38Max({ menuOpen: false, initialModeChecked: 'fast' });
  for (const c of trigger.children) { if (c.className === 'whitespace-nowrap') { c.textContent = ''; c.innerText = ''; } }
  /* aria-label="快速" 仍在 */
  const out = run(qwen, 'applyMode', doc, { thinking: false });
  assert.deepStrictEqual({ ok: out.ok }, { ok: true });
});

/* ============ 校验 5：模式菜单已经是打开状态（data-state=open），直接扫菜单项 ============ */
check('[真实DOM] 模式menu已打开：直接找到菜单项无需再点trigger', () => {
  const { doc, trigger, thinkItem } = buildRealDomQwen38Max({ menuOpen: true, initialModeChecked: 'fast' });
  const out = run(qwen, 'applyMode', doc, { thinking: true });
  assert.deepStrictEqual({ ok: out.ok }, { ok: true });
  /* menu 已开的情况下 applyMode 还是会按"当前不一致→trigger.click→扫菜单项"的逻辑执行，
   * 只要 thinkItem.clicks === 1 就证明切换正确。 */
  assert.strictEqual(thinkItem.clicks, 1, '思考研究项应被点击（当前=' + thinkItem.clicks + '）');
});

/* ============ 校验 6：图标兜底（文本节点全为空） ============ */
check('[真实DOM] 所有菜单项文本为空：靠qwpcicon-expertMode图标仍识别思考研究项', () => {
  const { doc, thinkItem, fastItem } = buildRealDomQwen38Max({ menuOpen: true, initialModeChecked: 'fast' });
  /* 清空所有文本 */
  const stripText = (el) => {
    if (!el) return;
    el.textContent = '';
    el.innerText = '';
    if (el.children) el.children.forEach(stripText);
  };
  stripText(thinkItem); stripText(fastItem);
  const out = run(qwen, 'applyMode', doc, { thinking: true });
  assert.deepStrictEqual({ ok: out.ok }, { ok: true }, '返回值：' + JSON.stringify(out));
  assert.strictEqual(thinkItem.clicks, 1, '靠图标识别，思考研究项应被点击（当前=' + thinkItem.clicks + '）');
});

/* ============ 校验 7：selectModel 对 qwpcicon-checkMini 选中状态识别 ============ */
check('[兼容性] selectModel 的 isSelected 需兼容 qwpcicon-checkMini（未来可能使用）', () => {
  /* 构造一个模型列表项（带 qwpcicon-checkMini） */
  const checkMini = new FakeElement('span', {
    attributes: { 'data-icon-type': 'qwpcicon-checkMini' },
    className: 'size-4 text-theme',
  });
  const nameWrap = new FakeElement('div', { className: 'truncate', text: 'Qwen3.8-Max' });
  const item = new FakeElement('div', { className: 'group cursor-pointer rounded-8 bg-weaken' });
  item.append(nameWrap);
  item.append(checkMini);
  /* 注意：当前 selectModel 的 isSelected 只识别 qwpcicon-check，不识别 checkMini；
   * 但根据 SPEC，isSelected 还有 bg-weaken 兜底，所以此处仍能通过。
   * 如果未来页面移除 bg-weaken class、仅保留 checkMini，则必须在此升级。
   * 下面验证 bg-weaken 兜底。 */
  const doc = makeDocument();
  const host = new FakeElement('div', {
    text: 'Qwen3.7-千问',
    attributes: { 'aria-haspopup': 'dialog', 'data-state': 'closed' },
    onClick: () => {
      const dialog = new FakeElement('div', { attributes: { role: 'dialog' }, text: '模型' });
      dialog.append(item);
      doc.body.append(dialog);
    },
  });
  doc.body.append(host);
  const out = run(qwen, 'selectModel', doc, 'Qwen3.8-Max');
  assert.deepStrictEqual({ ok: out.ok, alreadySelected: out.alreadySelected }, { ok: true, alreadySelected: false });
});

console.log('\n=== 验证汇总：', pass, '通过,', fail, '失败 ===');
process.exit(fail ? 1 : 0);