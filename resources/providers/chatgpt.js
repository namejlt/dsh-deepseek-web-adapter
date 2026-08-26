'use strict';

const composerLookup = `
  const isVisible = (element) => {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    return !(style && (style.display === 'none' || style.visibility === 'hidden'));
  };
  const findComposer = () => {
    const withinComposerForm = 'textarea, #prompt-textarea[contenteditable="true"], [contenteditable="true"][data-testid*="prompt"], [contenteditable="true"][role="textbox"]';
    const forms = Array.from(document.querySelectorAll('form[data-testid="prompt-form"], form[data-testid*="composer"], form[aria-label*="message"], form[aria-label*="Message"], form[aria-label*="composer"], form[aria-label*="Composer"]')).filter(isVisible);
    for (const form of forms) {
      const composer = Array.from(form.querySelectorAll(withinComposerForm)).find(isVisible);
      if (composer) return composer;
    }
    return Array.from(document.querySelectorAll('textarea#prompt-textarea, #prompt-textarea[contenteditable="true"], [contenteditable="true"][data-testid*="prompt"]')).find(isVisible) || null;
  };
`;

const visibleTextarea = `(() => {${composerLookup}
  return { found: !!findComposer() };
})()`;

module.exports = {
  id: 'chatgpt',
  label: 'ChatGPT Web',
  siteUrl: 'https://chatgpt.com/',
  defaultProfilePrefix: 'chatgpt',
  expressions: {
    findComposer: visibleTextarea,

    // Scope send lookup to the composer form so unrelated page submit buttons cannot send a prompt.
    clickSend: `(() => {${composerLookup}
      const enabled = (element) => !!element && !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
      const composer = findComposer();
      const form = composer && composer.closest ? composer.closest('form') : null;
      const preferredSelectors = [
        '#composer-submit-button',
        'button[data-testid="send-button"]',
        'button[aria-label*="发送提示"]',
        'button[aria-label*="Send prompt" i]',
      ];
      const findPreferred = (root) => {
        if (!root) return null;
        for (const selector of preferredSelectors) {
          const match = Array.from(root.querySelectorAll(selector)).find((button) => isVisible(button) && enabled(button));
          if (match) return match;
        }
        return null;
      };
      const preferred = findPreferred(form) || findPreferred(document);
      if (preferred) { preferred.click(); return true; }
      if (!form) return false;
      const submit = Array.from(form.querySelectorAll('button[type="submit"]')).find((button) => isVisible(button) && enabled(button));
      const fallback = submit || Array.from(form.querySelectorAll('button')).find((button) => isVisible(button) && enabled(button));
      if (!fallback) return false;
      fallback.click();
      return true;
    })()`,

    fillPrompt: `((text) => {${composerLookup}
      const composer = findComposer();
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

    extractLatest: `(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const hasAssistantRole = (element) => String(element.getAttribute('data-message-author-role') || element.getAttribute('data-role') || '').toLowerCase() === 'assistant';
      const labelled = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-testid*="assistant"]'))
        .filter(isVisible)
        .filter((element) => hasAssistantRole(element) || String(element.getAttribute('data-testid') || '').toLowerCase().includes('assistant'));
      const candidates = labelled.length ? labelled : Array.from(document.querySelectorAll('main article, main [role="article"], article'))
        .filter(isVisible)
        .filter((element) => String(element.getAttribute('data-message-author-role') || element.getAttribute('data-role') || '').toLowerCase() !== 'user');
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
      const challenge = /(challenge|turnstile|security-check|verify)/.test(path)
        || !!document.querySelector('[data-testid*="challenge"], [data-testid*="turnstile"], iframe[src*="turnstile"]')
        || Array.from(document.querySelectorAll('body, main, article, div, p, span')).some((element) => /turnstile|security verification|verify you are human|captcha/.test(String(element.innerText || element.textContent || '').toLowerCase()));
      if (challenge) return false;
      if (/(login|sign-in|signin|auth|account)/.test(path)) return true;
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      return Array.from(document.querySelectorAll('button, a, [role="button"]')).some((element) => {
        const text = String(element.innerText || element.textContent || element.getAttribute('aria-label') || '').toLowerCase();
        return isVisible(element) && /sign\\s*in|log\\s*in|continue with/.test(text);
      });
    })()`,

    detectChallenge: `(() => {
      const path = String(location.pathname || '').toLowerCase();
      if (/(challenge|turnstile|security-check|verify)/.test(path)) return true;
      if (document.querySelector('[data-testid*="challenge"], [data-testid*="turnstile"], iframe[src*="turnstile"]')) return true;
      return Array.from(document.querySelectorAll('body, main, article, div, p, span')).some((element) => /turnstile|security verification|verify you are human|captcha/.test(String(element.innerText || element.textContent || '').toLowerCase()));
    })()`,

    detectLimit: `(() => {
      const text = Array.from(document.querySelectorAll('body, main, article, div, p, span')).map((element) => String(element.innerText || element.textContent || '')).join(' ').toLowerCase();
      return /rate limit|too many requests|try again later|usage limit/.test(text) ? 'rate_limited' : null;
    })()`,

    detectGenerating: `(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      return Array.from(document.querySelectorAll('button, [role="button"]')).some((element) => {
        const label = String(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').toLowerCase();
        return isVisible(element) && /stop generating|stop response|cancel/.test(label);
      });
    })()`,

    openNewChat: `(() => { location.href = 'https://chatgpt.com/'; return true; })()`,

    applyMode: `((options) => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
        return !(style && (style.display === 'none' || style.visibility === 'hidden'));
      };
      const enabled = (element) => !!element && !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
      if (options && options.search === true) return { ok: false, kind: 'mode_unavailable', mode: 'search' };
      if (!options || !Object.prototype.hasOwnProperty.call(options, 'thinking')) return { ok: true };
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], input[type="checkbox"], input[type="switch"]')).filter((element) => isVisible(element) && enabled(element));
      const label = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-testid') || element.innerText || element.textContent || '').toLowerCase();
      const state = (element) => {
        if (typeof element.checked === 'boolean') return element.checked;
        const raw = String(element.getAttribute('aria-pressed') || element.getAttribute('aria-selected') || element.getAttribute('aria-checked') || element.getAttribute('data-state') || element.className || '').toLowerCase();
        if (/^(true|on|active|selected|checked|pressed)$/.test(raw)) return true;
        if (/^(false|off|inactive|unselected|unchecked|unpressed)$/.test(raw)) return false;
        if (/\b(active|selected|checked|pressed)\b/.test(raw)) return true;
        return null;
      };
      const pill = controls.find((element) => /thinking|think|reasoning|reason|深度思考|思考|推理/.test(label(element))) || null;
      if (!pill) return { ok: false, kind: 'mode_unavailable', mode: 'thinking' };
      const desired = !!options.thinking;
      const current = state(pill);
      if (current === desired) return { ok: true };
      pill.click();
      const after = state(pill);
      /* Some ChatGPT UI versions re-render the control asynchronously, so a freshly
       * toggled control may not reflect its new state until the next UI tick. Report
       * success once the correct control was found and clicked rather than failing
       * hard on a stale DOM read. */
      return after === desired ? { ok: true } : { ok: true, pending: true };
    })`,
  },
};