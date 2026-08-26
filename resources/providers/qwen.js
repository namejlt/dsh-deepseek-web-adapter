'use strict';

const sharedHelpers = `
  const isVisible = (element) => {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    return !(style && (style.display === 'none' || style.visibility === 'hidden'));
  };
  const findVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
  const enabled = (element) => !!element && !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
  const findComposerEl = () => {
    return findVisible('.message-input-textarea')
      || findVisible('.qwen-chat-v2-input-textarea')
      || findVisible('.chat-input-textarea')
      || findVisible('textarea[placeholder*="询问"], textarea[placeholder*="输入"], textarea[placeholder*="问题"], textarea[placeholder*="Ask"], textarea[placeholder*="Type"]')
      || findVisible('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder*="输入"], [contenteditable="true"][data-placeholder*="Ask"]')
      || findVisible('textarea[data-testid*="input"], textarea[data-testid*="composer"]')
      || findVisible('[data-testid*="prompt"] textarea, [data-testid*="composer"] textarea')
      || findVisible('[data-testid*="prompt"][contenteditable="true"], [data-testid*="composer"][contenteditable="true"]')
      || findVisible('form textarea')
      || findVisible('textarea');
  };
`;

module.exports = {
  id: 'qwen',
  label: 'Qwen Web',
  siteUrl: 'https://chat.qwen.ai/',
  defaultProfilePrefix: 'qwen',
  expressions: {
    findComposer: `(() => {${sharedHelpers}
      const composer = findComposerEl();
      return { found: !!composer };
    })()`,

    clickSend: `(() => {${sharedHelpers}
      const strictSelectors = [
        '.chat-prompt-send-button .send-button[aria-label="发送"]',
        '.chat-prompt-send-button .send-button[aria-label="Send"]',
        '.message-input-right-button-send .send-button[aria-label="发送"]',
        '.message-input-right-button-send .send-button[aria-label="Send"]',
        '.message-input-right-button-send .send-button',
        '.chat-prompt-send-button button[aria-label="发送"]',
        '.chat-prompt-send-button button[aria-label="Send"]',
        '.chat-prompt-send-button button.send-button',
        '.message-input-right-button-send button[aria-label="发送"]',
        '.message-input-right-button-send button[aria-label="Send"]',
        '.message-input-right-button-send .chat-prompt-send-button button[aria-label="发送"]',
        '.message-input-right-button-send .chat-prompt-send-button button[aria-label="Send"]',
      ];
      for (const selector of strictSelectors) {
        const send = Array.from(document.querySelectorAll(selector)).find((button) => isVisible(button) && enabled(button));
        if (send) { send.click(); return true; }
      }
      const qwenContainers = Array.from(document.querySelectorAll('.chat-prompt-send-button, .message-input-right-button-send, [class*="message-input-right"], [class*="chat-prompt"]')).filter(isVisible);
      for (const container of qwenContainers) {
        const iconSend = Array.from(container.querySelectorAll('.icon-send, [class*="icon-send"], svg[class*="send"], [data-testid*="send-icon"]')).find((el) => el && !el.hidden);
        if (iconSend) {
          const button = iconSend.closest('button, [role="button"]');
          if (button && isVisible(button) && enabled(button)) { button.click(); return true; }
        }
        const btn = Array.from(container.querySelectorAll('button, [role="button"]')).find((b) => isVisible(b) && enabled(b));
        if (btn) { btn.click(); return true; }
      }
      const composer = findComposerEl();
      if (composer) {
        const form = composer.closest('form');
        const scope = form || composer.parentElement || document;
        const scopeSelectors = [
          'button[data-testid="send-button"]',
          '[data-testid*="send"] button',
          'button[aria-label*="发送" i]',
          'button[aria-label*="Send" i]',
          'button[aria-label*="submit" i]',
          'button[class*="send-btn" i]',
          'button[class*="sendButton" i]',
          'button[class*="send-button" i]',
          'button[type="submit"]',
        ];
        for (const selector of scopeSelectors) {
          const send = Array.from(scope.querySelectorAll(selector)).find((button) => isVisible(button) && enabled(button));
          if (send) { send.click(); return true; }
        }
        const iconSend = Array.from(scope.querySelectorAll('.icon-send, [class*="icon-send"], svg[class*="send"], [data-testid*="send-icon"]')).find((el) => el && !el.hidden);
        if (iconSend) {
          const button = iconSend.closest('button, [role="button"]');
          if (button && isVisible(button) && enabled(button)) { button.click(); return true; }
        }
        const sendButtons = Array.from(scope.querySelectorAll('button, [role="button"]')).filter((b) => isVisible(b) && enabled(b));
        const labelTxt = (b) => String(b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || b.textContent || '').toLowerCase();
        const matchedSend = sendButtons.find((b) => {
          const t = labelTxt(b);
          return (t.includes('发送') || t.includes('send') || t.includes('submit')) && !t.includes('stop') && !t.includes('停止') && !t.includes('cancel') && !t.includes('取消');
        });
        if (matchedSend) { matchedSend.click(); return true; }
        if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
        if (form) {
          const submitBtn = Array.from(form.querySelectorAll('button, input[type="submit"]')).find((b) => isVisible(b) && enabled(b));
          if (submitBtn) { submitBtn.click(); return true; }
        }
      }
      return false;
    })()`,

    fillPrompt: `((text) => {${sharedHelpers}
      const composer = findComposerEl();
      if (!composer) return false;
      const value = String(text);
      const contenteditable = composer.getAttribute('contenteditable') === 'true';
      if (contenteditable) {
        try {
          if (typeof composer.focus === 'function') composer.focus();
          if (document.execCommand) {
            document.execCommand('selectAll', false, null);
            try { document.execCommand('delete', false, null); } catch (e2) {}
            document.execCommand('insertText', false, value);
          }
        } catch (e) { /* fall through to DOM text assignment */ }
        if (String(composer.innerText || composer.textContent || '').trim() !== value.trim()) {
          composer.textContent = value;
          if ('innerText' in composer) composer.innerText = value;
        }
        try {
          if (typeof InputEvent !== 'undefined') {
            composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
            composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
          } else {
            composer.dispatchEvent(new Event('beforeinput', { bubbles: true }));
            composer.dispatchEvent(new Event('input', { bubbles: true }));
          }
          composer.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {}
      } else {
        let setOk = false;
        try {
          const descriptor = typeof HTMLTextAreaElement !== 'undefined' && Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
          if (descriptor && typeof descriptor.set === 'function') {
            descriptor.set.call(composer, value);
            setOk = true;
          }
        } catch (e) {}
        if (!setOk) { composer.value = value; }
        try {
          if (typeof InputEvent !== 'undefined') {
            composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
          } else {
            composer.dispatchEvent(new Event('input', { bubbles: true }));
          }
          composer.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {}
      }
      return true;
    })`,

    extractLatest: `(() => {${sharedHelpers}
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

    detectLogin: `(() => {${sharedHelpers}
      const path = String(location.pathname || '').toLowerCase();
      if (/(login|sign-in|signin|auth|account)/.test(path)) return true;
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

    detectGenerating: `(() => {${sharedHelpers}
      const exact = Array.from(document.querySelectorAll('.chat-prompt-send-button .stop-button[aria-label="Stop"]')).find(isVisible);
      if (exact) return true;
      return Array.from(document.querySelectorAll('button, [role="button"]')).some((element) => isVisible(element) && /stop|停止|取消/.test(String(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').toLowerCase()));
    })()`,

    openNewChat: `(() => { location.href = 'https://chat.qwen.ai/'; return true; })()`,

    applyMode: `((options) => {${sharedHelpers}
      const label = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').toLowerCase();
      const state = (element) => {
        if (typeof element.checked === 'boolean') return element.checked;
        const raw = String(element.getAttribute('aria-pressed') || element.getAttribute('aria-selected') || element.getAttribute('aria-checked') || element.getAttribute('data-state') || element.className || '').toLowerCase();
        if (/^(true|on|active|selected|checked|pressed)$/.test(raw)) return true;
        if (/^(false|off|inactive|unselected|unchecked|unpressed)$/.test(raw)) return false;
        if (/\\b(active|selected|checked|pressed)\\b/.test(raw)) return true;
        if (/\\bqwen-chat-v2-dropdown-menu-item-selected\\b/.test(raw)) return true;
        return null;
      };

      const requested = [];

      if (options && Object.prototype.hasOwnProperty.call(options, 'thinking')) {
        const desired = !!options.thinking;
        // Try the old toggle button pattern first (backward compatibility)
        const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="checkbox"], input[type="switch"], [role="menuitem"], [role="option"]')).filter((element) => isVisible(element) && enabled(element));
        const oldToggle = controls.find((element) => /thinking|think|reasoning|深度思考|推理/.test(label(element)));
        if (oldToggle) {
          requested.push({ mode: 'thinking', desired, control: oldToggle });
        } else {
          // Try the new dropdown menu pattern
          // The dropdown trigger shows the current mode: "自动", "思考", "快速"
          const triggerSelectors = [
            '.qwen-chat-v2-dropdown-trigger',
            '[aria-label*="思考"], [aria-label*="think"]',
            '[class*="thinking-mode"], [class*="think-mode"]',
          ];
          let trigger = null;
          for (const sel of triggerSelectors) {
            trigger = Array.from(document.querySelectorAll(sel)).find((element) => isVisible(element) && enabled(element));
            if (trigger) break;
          }
          // Fallback: find the trigger by looking for elements containing "自动" or "思考" or "快速" near the input area
          if (!trigger) {
            const modeTexts = ['自动', '思考', '快速', 'think', 'auto', 'fast'];
            trigger = Array.from(document.querySelectorAll('button, [role="button"], div[class*="dropdown"], span[class*="dropdown"]')).find((element) => {
              const txt = String(element.innerText || element.textContent || '').trim();
              return isVisible(element) && enabled(element) && modeTexts.some((m) => txt === m || txt.startsWith(m));
            });
          }
          if (trigger) {
            const currentText = String(trigger.innerText || trigger.textContent || '').trim();
            const isThinking = /思考|think|reasoning/.test(currentText.toLowerCase());
            if (isThinking !== desired) {
              trigger.click();
              // Look for the dropdown menu items
              const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]')).filter((element) => isVisible(element) && enabled(element));
              const targetLabel = desired ? /思考|think|reasoning/ : /快速|fast|quick/;
              const targetItem = menuItems.find((element) => targetLabel.test(label(element)));
              if (targetItem) {
                targetItem.click();
              } else {
                // If no specific item found, try to find the auto item
                const autoItem = menuItems.find((element) => /自动|auto/.test(label(element)));
                if (autoItem && !desired) autoItem.click();
              }
            }
            requested.push({ mode: 'thinking', desired, control: trigger, handled: true });
          } else {
            return { ok: false, kind: 'mode_unavailable', mode: 'thinking' };
          }
        }
      }

      if (options && options.search === true) {
        const allControls = Array.from(document.querySelectorAll('button, [role="button"], input[type="checkbox"], input[type="switch"], [role="menuitem"], [role="option"]')).filter((element) => isVisible(element) && enabled(element));
        const searchControl = allControls.find((element) => /search|联网|搜索/.test(label(element)));
        if (!searchControl) return { ok: false, kind: 'mode_unavailable', mode: 'search' };
        requested.push({ mode: 'search', desired: true, control: searchControl });
      }

      const missing = requested.find((target) => !target.control);
      if (missing) return { ok: false, kind: 'mode_unavailable', mode: missing.mode };

      for (const target of requested) {
        if (target.handled) continue;
        if (state(target.control) !== target.desired) target.control.click();
        if (state(target.control) !== target.desired) return { ok: false, kind: 'mode_unavailable', mode: target.mode };
      }
      return { ok: true };
    })`,

    selectModel: `((modelName) => {${sharedHelpers}
      if (!modelName) return { ok: false, kind: 'model_unavailable', reason: 'no model name provided' };
      const targetName = String(modelName).trim().toLowerCase();

      // Find the model selector trigger
      const triggerSelectors = [
        '.wms-intro__text',
        '[class*="model-selector"]',
        '[class*="model-picker"]',
        '[aria-label*="模型"]',
        '[aria-label*="model"]',
      ];
      let trigger = null;
      for (const sel of triggerSelectors) {
        trigger = Array.from(document.querySelectorAll(sel)).find((element) => isVisible(element));
        if (trigger) break;
      }
      // Fallback: look for elements containing "模型" text
      if (!trigger) {
        trigger = Array.from(document.querySelectorAll('div, span, button')).find((element) => {
          const txt = String(element.innerText || element.textContent || '').trim();
          return isVisible(element) && txt === '模型';
        });
      }
      if (!trigger) return { ok: false, kind: 'model_unavailable', reason: 'model selector trigger not found' };

      // Look for already open model list
      let modelList = findVisible('.wms-list');
      if (!modelList) {
        // Click the trigger to open
        const clickTarget = trigger.closest('button') || trigger.closest('[role="button"]') || trigger;
        clickTarget.click();
        // Look again for the model list
        modelList = findVisible('.wms-list');
      }
      if (!modelList) return { ok: false, kind: 'model_unavailable', reason: 'model list not found' };

      // Find the desired model
      const items = Array.from(modelList.querySelectorAll('.wms-list__item, [role="option"]')).filter(isVisible);
      let targetItem = items.find((item) => {
        const nameEl = item.querySelector('.wms-list__name-text') || item;
        const name = String(nameEl.innerText || nameEl.textContent || '').trim().toLowerCase();
        return name.includes(targetName) || targetName.includes(name);
      });
      if (!targetItem) {
        // Try expanding more models
        const expandEntry = findVisible('.wms-more-entry, .wms-more-entry__content');
        if (expandEntry) {
          const expandClick = expandEntry.closest('button') || expandEntry.closest('[role="button"]') || expandEntry;
          expandClick.click();
          // Re-query items
          const expandedItems = Array.from(document.querySelectorAll('.wms-list__item, [role="option"]')).filter(isVisible);
          targetItem = expandedItems.find((item) => {
            const nameEl = item.querySelector('.wms-list__name-text') || item;
            const name = String(nameEl.innerText || nameEl.textContent || '').trim().toLowerCase();
            return name.includes(targetName) || targetName.includes(name);
          });
        }
      }
      if (!targetItem) return { ok: false, kind: 'model_unavailable', reason: 'model not found: ' + modelName };

      // Check if already selected
      if (targetItem.classList.contains('wms-list__item--selected') || targetItem.getAttribute('aria-selected') === 'true') {
        return { ok: true, alreadySelected: true };
      }

      targetItem.click();
      // Verify selection
      const selectedAfter = targetItem.classList.contains('wms-list__item--selected') || targetItem.getAttribute('aria-selected') === 'true';
      return { ok: selectedAfter, alreadySelected: false };
    })`,
  },
};