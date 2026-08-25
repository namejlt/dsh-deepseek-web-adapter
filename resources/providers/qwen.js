'use strict';

module.exports = {
  id: 'qwen',
  label: 'Qwen Web',
  siteUrl: 'https://chat.qwen.ai/',
  defaultProfilePrefix: 'qwen',
  expressions: {
    findComposer: `(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const findVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
      const composer = findVisible('.message-input-textarea')
        || findVisible('.qwen-chat-v2-input-textarea')
        || findVisible('textarea[placeholder*="输入"], textarea[placeholder*="问题"]')
        || findVisible('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder*="输入"]');
      return { found: !!composer };
    })()`,

    clickSend: `(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const enabled = (element) => !!element && !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
      const send = Array.from(document.querySelectorAll('.chat-prompt-send-button .send-button[aria-label="Send"], .chat-prompt-send-button .send-button[aria-label="发送"]')).find((button) => isVisible(button) && enabled(button))
        || Array.from(document.querySelectorAll('.chat-prompt-send-button button[aria-label="Send"], .chat-prompt-send-button button[aria-label="发送"]')).find((button) => isVisible(button) && enabled(button));
      if (!send) return false;
      send.click();
      return true;
    })()`,

    fillPrompt: `((text) => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const findVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
      const composer = findVisible('.message-input-textarea')
        || findVisible('.qwen-chat-v2-input-textarea')
        || findVisible('textarea[placeholder*="输入"], textarea[placeholder*="问题"]')
        || findVisible('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder*="输入"]');
      if (!composer) return false;
      const value = String(text);
      const contenteditable = composer.getAttribute('contenteditable') === 'true';
      if (contenteditable) {
        try {
          if (typeof composer.focus === 'function') composer.focus();
          if (document.execCommand) {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
          }
        } catch (e) { /* fall through to DOM text assignment */ }
        if (String(composer.innerText || composer.textContent || '') !== value) {
          composer.textContent = value;
          if ('innerText' in composer) composer.innerText = value;
        }
      } else {
        const descriptor = typeof HTMLTextAreaElement !== 'undefined' && Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(composer, value);
        else composer.value = value;
      }
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })`,

    extractLatest: `(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const candidates = Array.from(document.querySelectorAll('.qwen-markdown, .markdown, [class*="markdown"], [data-message-author-role="assistant"], .message-content'))
        .filter(isVisible)
        .filter((element) => String(element.getAttribute('data-message-author-role') || '').toLowerCase() !== 'user');
      const latest = candidates[candidates.length - 1];
      if (!latest) return { text: '', thinking: '' };
      const lines = [];
      const add = (value) => String(value || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
        if (!lines.includes(line)) lines.push(line);
      });
      add(latest.innerText || latest.textContent);
      Array.from(latest.querySelectorAll('pre code')).forEach((code) => add(code.innerText || code.textContent));
      return { text: lines.join('\\n'), thinking: '' };
    })()`,

    detectLogin: `(() => {
      const path = String(location.pathname || '').toLowerCase();
      if (/(login|sign-in|signin|auth|account)/.test(path)) return true;
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      return Array.from(document.querySelectorAll('button, a, [role="button"]')).some((element) => isVisible(element) && /sign\\s*in|log\\s*in|登录/.test(String(element.innerText || element.textContent || element.getAttribute('aria-label') || '').toLowerCase()));
    })()`,

    detectChallenge: `(() => {
      const path = String(location.pathname || '').toLowerCase();
      if (/(challenge|turnstile|security-check|verify)/.test(path)) return true;
      if (document.querySelector('[data-testid*="challenge"], [data-testid*="turnstile"], iframe[src*="turnstile"]')) return true;
      return Array.from(document.querySelectorAll('body, main, article, div, p, span')).some((element) => /turnstile|security verification|verify you are human|captcha|安全验证/.test(String(element.innerText || element.textContent || '').toLowerCase()));
    })()`,

    detectLimit: `(() => {
      const text = Array.from(document.querySelectorAll('body, main, article, div, p, span')).map((element) => String(element.innerText || element.textContent || '')).join(' ').toLowerCase();
      return /rate limit|too many requests|try again later|usage limit|请求过于频繁|访问频繁|稍后再试/.test(text) ? 'rate_limited' : null;
    })()`,

    detectGenerating: `(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const exact = Array.from(document.querySelectorAll('.chat-prompt-send-button .stop-button[aria-label="Stop"]')).find(isVisible);
      if (exact) return true;
      return Array.from(document.querySelectorAll('button, [role="button"]')).some((element) => isVisible(element) && /stop|停止|取消/.test(String(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').toLowerCase()));
    })()`,

    openNewChat: `(() => { location.href = 'https://chat.qwen.ai/'; return true; })()`,

    // A requested mode may succeed only after its visible control reports the requested state; never silently use another Qwen mode.
    applyMode: `((options) => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const enabled = (element) => !!element && !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
      const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="checkbox"], input[type="switch"]')).filter((element) => isVisible(element) && enabled(element));
      const label = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').toLowerCase();
      const state = (element) => {
        if (typeof element.checked === 'boolean') return element.checked;
        const raw = String(element.getAttribute('aria-pressed') || element.getAttribute('aria-selected') || element.getAttribute('data-state') || '').toLowerCase();
        if (/^(true|on|active|selected|checked)$/.test(raw)) return true;
        if (/^(false|off|inactive|unselected|unchecked)$/.test(raw)) return false;
        return null;
      };
      const requested = [];
      if (options && Object.prototype.hasOwnProperty.call(options, 'thinking')) requested.push({ mode: 'thinking', desired: !!options.thinking, match: /thinking|think|reasoning|深度思考|推理/ });
      if (options && Object.prototype.hasOwnProperty.call(options, 'search')) requested.push({ mode: 'search', desired: !!options.search, match: /search|联网|搜索/ });
      const targets = requested.map((request) => Object.assign({}, request, { control: controls.find((element) => request.match.test(label(element))) || null }));
      const missing = targets.find((target) => !target.control);
      if (missing) return { ok: false, kind: 'mode_unavailable', mode: missing.mode };
      for (const target of targets) {
        if (state(target.control) !== target.desired) target.control.click();
        if (state(target.control) !== target.desired) return { ok: false, kind: 'mode_unavailable', mode: target.mode };
      }
      return { ok: true };
    })`,
  },
};
