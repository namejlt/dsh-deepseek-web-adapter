'use strict';

/**
 * Qwen（https://www.qianwen.com/）桌面 Web 适配器。
 *
 * 页面结构要点（radix + slate SPA）：
 * - 输入框：输入区 `[data-chat-input-shell]` 内的 slate 编辑器
 *   `[data-slate-editor="true"][contenteditable="true"]`（role="textbox"，
 *   data-placeholder="向千问提问"）。
 * - 发送：`button[data-session-switch-target="send-query"]`（aria-label="发送消息"，
 *   图标 `qwpcicon-sendChat`）；输入为空时带 disabled 属性。
 * - 模式：输入框底部胶囊按钮（aria-haspopup="menu"，aria-label 为当前模式名，
 *   如「快速」「思考研究」），点击弹出 `[data-radix-menu-content]` 菜单，
 *   菜单项为 `[role="menuitemcheckbox"]`（aria-checked / data-state 标记选中）。
 * - 模型：顶部 `[aria-haspopup="dialog"]` 触发器显示当前模型名（如 Qwen3.7-千问），
 *   点击弹出 `[role="dialog"]` 模型列表；列表项含 `.truncate` 模型名与
 *   `qwpcicon-check` 图标（未选中图标带 `invisible` class，选中项带 `bg-weaken`）。
 * - 输入区下方存在一份 `aria-hidden="true"` 的 measure-capsule 测量副本，
 *   所有可见性判断必须过滤该隐藏子树。
 */
const sharedHelpers = `
  const isVisible = (element) => {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest && element.closest('[aria-hidden="true"]')) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    return !(style && (style.display === 'none' || style.visibility === 'hidden'));
  };
  const findVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
  const enabled = (element) => !!element && !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
  const textOf = (element) => String((element && (element.innerText || element.textContent)) || '').trim();
  const findComposerEl = () => {
    return findVisible('[data-chat-input-shell="true"] [contenteditable="true"]')
      || findVisible('[data-slate-editor="true"][contenteditable="true"]')
      || findVisible('[contenteditable="true"][role="textbox"][data-placeholder*="提问"]')
      || findVisible('[contenteditable="true"][role="textbox"]')
      || findVisible('textarea[placeholder*="提问"], textarea[placeholder*="询问"], textarea[placeholder*="输入"]')
      || findVisible('.message-input-textarea, .qwen-chat-v2-input-textarea, .chat-input-textarea')
      || findVisible('textarea');
  };
`;

module.exports = {
  id: 'qwen',
  label: 'Qwen Web',
  siteUrl: 'https://www.qianwen.com/',
  defaultProfilePrefix: 'qwen',
  expressions: {
    findComposer: `(() => {${sharedHelpers}
      const composer = findComposerEl();
      return { found: !!composer };
    })()`,

    clickSend: `(() => {${sharedHelpers}
      const strictSelectors = [
        'button[data-session-switch-target="send-query"]',
        'button[aria-label="发送消息"]',
        '[data-chat-input-shell] button[aria-label*="发送"]',
        '[data-qw-chat-input-position] button[aria-label*="发送"]',
      ];
      for (const selector of strictSelectors) {
        const send = Array.from(document.querySelectorAll(selector)).find((button) => isVisible(button) && enabled(button));
        if (send) { send.click(); return true; }
      }
      const icon = Array.from(document.querySelectorAll('[data-icon-type="qwpcicon-sendChat"]')).find(isVisible);
      if (icon && icon.closest) {
        const button = icon.closest('button');
        if (button && isVisible(button) && enabled(button)) { button.click(); return true; }
      }
      const containers = Array.from(document.querySelectorAll('[data-chat-input-shell], [data-qw-chat-input-position], [class*="inputOutWrap"]')).filter(isVisible);
      const labelTxt = (b) => String(b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || b.textContent || '').toLowerCase();
      for (const container of containers) {
        const matched = Array.from(container.querySelectorAll('button, [role="button"]')).find((b) => {
          const t = labelTxt(b);
          return isVisible(b) && enabled(b) && (t.includes('发送') || t.includes('send')) && !/stop|停止|cancel|取消/.test(t);
        });
        if (matched) { matched.click(); return true; }
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
      const candidates = Array.from(document.querySelectorAll('.qwen-markdown, .markdown, [class*="markdown"], [data-message-author-role="assistant"], .message-content, .chat-answers-card-wrap'))
        .filter(isVisible)
        .filter((element) => String(element.getAttribute('data-message-author-role') || '').toLowerCase() !== 'user');
      const latest = candidates[candidates.length - 1];
      if (!latest) return { text: '', thinking: '' };

      const stripLineNumbers = (root) => {
        if (!root) return '';
        try {
          if (root.cloneNode) {
            const clone = root.cloneNode(true);
            const badSelectors = [
              '.linenumber',
              '.react-syntax-highlighter-line-number',
              '[class*="linenumber"]',
              '[class*="line-number"]',
              '[class*="lineNumber"]',
            ];
            clone.querySelectorAll(badSelectors.join(',')).forEach((node) => {
              try {
                if (node.parentNode) node.parentNode.removeChild(node);
                else if (node.remove) node.remove();
              } catch (e) {}
            });
            const txt = String(clone.innerText || clone.textContent || '');
            if (txt) return txt;
          }
        } catch (e) {}
        /* cloneNode 不可用时（测试环境 / 极简 DOM 实现）：递归收集文本，
         * 遇到含 linenumber / line-number className 的节点跳过其内容。 */
        try {
          const isLineNumberEl = (el) => {
            if (!el || typeof el !== 'object') return false;
            const cls = String(el.className || '');
            if (!cls) return false;
            return /linenumber|line-number|lineNumber/i.test(cls);
          };
          const walk = (node, buf) => {
            if (!node) return;
            if (isLineNumberEl(node)) return;
            if (node.nodeType === 3 || typeof node === 'string') {
              buf.push(String(node.nodeValue != null ? node.nodeValue : node));
              return;
            }
            const children = node.children || (node.childNodes && Array.from(node.childNodes).filter((c) => c && c.nodeType !== 3)) || [];
            for (const child of children) walk(child, buf);
            if (typeof node.textContent === 'string' && (!children || !children.length)) {
              buf.push(String(node.textContent));
            }
          };
          const buf = [];
          walk(root, buf);
          if (buf.length) return buf.join('');
        } catch (e2) {}
        return String(root.innerText || root.textContent || '');
      };

      const detectBlockLang = (block) => {
        if (!block) return '';
        const knownLangs = /^(tool_call|json|javascript|python|bash|shell|typescript|ts|js|html|css|xml|yaml|yml|sql|java|go|rust|cpp|c)$/i;
        const candidates = Array.from(block.querySelectorAll('span, div, p'));
        for (const el of candidates) {
          if (el.closest && el.closest('button, [role="button"], pre, code')) continue;
          const cls = String(el.className || '');
          if (!/font-medium|mr-auto|text-12|code-title|code-header/i.test(cls)) continue;
          const txt = String(el.innerText || el.textContent || '').trim();
          if (!txt || txt.length > 40) continue;
          if (knownLangs.test(txt)) return txt.toLowerCase();
          if (/tool[_-]?call/i.test(txt)) return 'tool_call';
        }
        return '';
      };

      /* ===== 抽取 prose 正文时，不直接走 latest 的 innerText（它会把所有
       * qw-md-code 内嵌表格 / 按钮 / 操作条 "下载为表格 导出为图片"
       * 全量扁平化吐出），而是：
       * 1) 先把所有被识别为 code 的块（qw-md-code / pre / code 等）用
       *    WeakSet 标记，后续 prose 遍历中跳过这些子树；
       * 2) 再通过 walkProse 递归拼 prose，表格 / 按钮文案仍保留，但不会
       *    被 fence 循环再重复处理一次。 */
      const codeBlocks = Array.from(latest.querySelectorAll(
        '.qw-md-code, [class*="qw-md-code"], [class*="md-code"], [class*="codeBlock"], pre'
      )).filter(isVisible);
      const seenCodeEls = new WeakSet();
      /* 按 block 维度先建索引：任何命中 .qw-md-code 的节点，其内部所有
       * <pre> / <code> 都算作 fenced 范畴，不再走 prose 通道。 */
      for (let i = 0; i < codeBlocks.length; i++) {
        const block = codeBlocks[i];
        if (seenCodeEls.has(block)) continue;
        seenCodeEls.add(block);
        (block.querySelectorAll && block.querySelectorAll('pre, code') || []).forEach((n) => seenCodeEls.add(n));
      }

      /* ===== prose 正文专用：跳过真正的 tool_call fenced / 语法高亮 code 节点，
       * 仍然保留一般 Markdown 胶囊（qw-md-code）中的表格 / 段落内容（只是它们在
       * 正文只出现一次），并且不把 "下载为表格 导出为图片" 这类操作按钮文案
       * 当正文重复收集。 */
      /* 真正需要在 prose 中屏蔽的只有：明确识别为 tool_call/json 的代码胶囊
       * 以及独立 pre（纯代码块）。表格类 qw-md-code 不走 seenCodeEls，让
       * walkProse 正常读取其内容。 */
      const fencedOnly = new WeakSet();
      for (let i = 0; i < codeBlocks.length; i++) {
        const block = codeBlocks[i];
        const lang = detectBlockLang(block) || '';
        const standalonePre =
          block.tagName === 'PRE' &&
          !(block.closest && block.closest('.qw-md-code, [class*="md-code"]'));
        if (lang || standalonePre) {
          fencedOnly.add(block);
          (block.querySelectorAll && block.querySelectorAll('pre, code, table, thead, tbody, tr, td, th') || []).forEach((n) => fencedOnly.add(n));
        }
        seenCodeEls.add(block);
        (block.querySelectorAll && block.querySelectorAll('pre, code') || []).forEach((n) => seenCodeEls.add(n));
      }

      const BAD_ACTION_RE = /^(下载为|导出为|复制|复制为|分享|插入)/;
      const walkProse = (node, buf) => {
        if (!node) return;
        if (fencedOnly.has(node)) return;
        if (node.nodeType === 3 || typeof node === 'string') {
          buf.push(String(node.nodeValue != null ? node.nodeValue : node));
          return;
        }
        if (typeof node === 'object') {
          const hidden = !!node.hidden || String(node.getAttribute && node.getAttribute('aria-hidden') || '') === 'true';
          if (hidden) return;
          const tag = String(node.tagName || '').toUpperCase();
          const cls = String(node.className || '');
          const role = String(node.getAttribute && node.getAttribute('role') || '').toLowerCase();
          if (/invisible|opacity-0|display-none|hidden|sr-only|aria[-_]?hidden/i.test(cls)) return;
          /* 操作按钮：一律在正文跳过其文本（含"下载为表格""导出为图片""复制"） */
          const isActionable =
            tag === 'BUTTON' ||
            role === 'button' ||
            /\bcursor[-_]?pointer\b|\bclickable\b|\bbtn\b|\baction\b/i.test(cls) ||
            (node.getAttribute && (node.getAttribute('data-role') === 'button' || node.getAttribute('aria-haspopup')));
          if (isActionable) return;
          const children = node.children || (node.childNodes && Array.from(node.childNodes).filter((c) => c && c.nodeType !== 3)) || [];
          if (children && children.length) {
            for (const child of children) walkProse(child, buf);
            /* 块状 / 表格单元后补换行，保持语义分段 */
            if (/^(H[1-6]|P|DIV|SECTION|LI|BR|HR|FIGCAPTION|BLOCKQUOTE|TABLE|THEAD|TBODY|TR)$/.test(tag)) buf.push(String.fromCharCode(10));
          } else if (typeof node.textContent === 'string') {
            buf.push(String(node.textContent));
          }
        }
      };
      const proseBuf = [];
      walkProse(latest, proseBuf);
      const proseRaw = proseBuf.join('');

      const proseLines = [];
      const seenLine = new Set();
      const pushProse = (raw) => {
        String(raw || '').split(/\\r?\\n/).forEach((line) => {
          const l = String(line).replace(/[ \\t\\xa0]+$/,'');
          const core = l.trim();
          if (!core) return;
          /* 对疑似表格操作条的行再做一次冗余过滤：
           * "表格下载为表格导出为图片" 这种拼接串不进入正文，
           * 只保留真正有语义的行。 */
          const striped = core.replace(/[ \\t]+/g, '');
          if (/^(表格|项目|下载为表格|导出为图片|复制为图片|插入到对话){2,}$/.test(striped)) return;
          if (seenLine.has(core) || seenLine.has(striped)) return;
          seenLine.add(core);
          seenLine.add(striped);
          proseLines.push(l.replace(/^[ \\t\\xa0]+/, ''));
        });
      };

      const BT = String.fromCharCode(96);
      const FENCE3 = BT + BT + BT;
      const fencedBlocks = [];
      const seenFence = new Set();
      const pushFence = (raw) => {
        const s = String(raw || '');
        if (!s.trim()) return;
        const key = s.length + '|' + s.slice(0, 200);
        if (seenFence.has(key)) return;
        seenFence.add(key);
        fencedBlocks.push(s);
      };

      /* 1) prose 通道：仅走 walkProse 过滤过的正文视图 */
      pushProse(proseRaw);

      /* 2) fence 通道：只处理明确识别为代码块的节点，
       *    对 .qw-md-code 若 detectBlockLang 未返回 tool_call/json 等已知语言，
       *    大概率是 qwen 的 markdown 表格块，不再围栏化，避免正文 + fence 两份重复。 */
      for (let i = 0; i < codeBlocks.length; i++) {
        const block = codeBlocks[i];
        const codeEl = block.querySelector('code') || block;
        if (!codeEl) continue;
        const lang = detectBlockLang(block) || '';
        const code = stripLineNumbers(codeEl).trim();
        if (!code) continue;
        const isCodeLike =
          !!lang || /* 有语言标签 → 是代码块 */
          (code.slice(0, 3) === FENCE3 && code.slice(-3) === FENCE3) || /* 内容本身已是 fenced */
          (block.tagName === 'PRE' && !block.closest('.qw-md-code, [class*="md-code"]'));  /* 纯 pre，不在表格胶囊里 */
        if (!isCodeLike) continue;
        pushFence(FENCE3 + (lang || '') + '\\n' + code + '\\n' + FENCE3);
      }

      /* 兜底：未被收集到的 pre>code 再走 fence（极少命中，防止遗漏） */
      Array.from(latest.querySelectorAll('pre code')).forEach((code) => {
        if (seenCodeEls.has(code)) return;
        const clean = stripLineNumbers(code).trim();
        if (!clean) return;
        pushFence(FENCE3 + '\\n' + clean + '\\n' + FENCE3);
      });

      /* ===== 最终串联 =====
       * 顺序：prose 在前（人类可读正文），fences 在后（工具解析消费）。 */
      const outParts = [];
      if (proseLines.length) outParts.push(proseLines.join('\\n'));
      if (fencedBlocks.length) outParts.push(fencedBlocks.join('\\n\\n'));
      const text = outParts.join('\\n');
      return { text, thinking: '' };
    })()`,


    detectLogin: `(() => {${sharedHelpers}
      const path = String(location.pathname || '').toLowerCase();
      if (/(login|sign-in|signin|auth|account|passport)/.test(path)) return true;
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
      const stopIcon = Array.from(document.querySelectorAll('[data-icon-type*="stop"], [data-icon-type*="Stop"]')).find(isVisible);
      if (stopIcon && stopIcon.closest && stopIcon.closest('button')) return true;
      return Array.from(document.querySelectorAll('button, [role="button"]')).some((element) => isVisible(element) && /stop|停止/.test(String(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').toLowerCase()));
    })()`,

    openNewChat: `(() => { location.href = 'https://www.qianwen.com/'; return true; })()`,

    /* 模式开关：输入框底部「快速 / 思考研究 / 自动」胶囊是 radix menu 触发器
     * （aria-haspopup="menu"，aria-label 为当前模式名）。thinking 选项映射：
     * thinking=true → 思考研究（含深度搜索/深度研究）；thinking=false → 快速（自动模式视为可切换的 fast）。
     * 识别特征（多特征匹配，抗页面改版）：
     *   - 文本：快速 / 思考研究 / 深度思考 / 深度研究 / 思考 / 自动 / fast / quick / think / auto
     *   - aria-label：触发器常以当前模式名作为 aria-label
     *   - 图标类型：快速=qwpcicon-flash，思考研究=qwpcicon-expertMode */
    applyMode: `((options) => {${sharedHelpers}
      if (options && options.search === true) return { ok: false, kind: 'mode_unavailable', mode: 'search' };
      if (!options || !Object.prototype.hasOwnProperty.call(options, 'thinking')) return { ok: true };
      const desired = !!options.thinking;

      const isModeWord = (txt) => /^(快速|思考研究|深度思考|深度研究|思考|自动|fast|quick|think|auto)/i.test(txt);
      const containsModeWord = (txt) => /(快速|思考研究|深度思考|深度研究|思考|自动|fast|quick|think|auto)/i.test(txt);
      const isThinkingText = (txt) => /思考|think|reasoning/i.test(txt);
      const isFastText = (txt) => /^(快速|fast|quick)/i.test(txt) || /\b快速\b/.test(txt);
      const isAutoText = (txt) => /(自动|auto)/i.test(txt);
      const iconOf = (element) => {
        if (!element) return null;
        const i = element.querySelector('[data-icon-type]');
        return i ? String(i.getAttribute('data-icon-type') || '') : null;
      };
      const FLASH_ICON = 'qwpcicon-flash';
      const EXPERT_ICON = 'qwpcicon-expertMode';
      const isThinkingIcon = (t) => t === EXPERT_ICON;
      const isFastIcon = (t) => t === FLASH_ICON;

      /* 收集所有可见的菜单项：从已识别的菜单容器收集 + 全页兜底（防止 radix popper 容器失配）。 */
      const collectModeItems = () => {
        const menus = Array.from(document.querySelectorAll('[data-radix-menu-content], [role="menu"], [data-radix-popper-content-wrapper]')).filter(isVisible);
        const seen = new Set();
        const out = [];
        const push = (item) => {
          if (!item || seen.has(item)) return;
          seen.add(item);
          out.push(item);
        };
        for (const menu of menus) {
          Array.from(menu.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], [role="option"]')).filter(isVisible).forEach(push);
        }
        /* 全页兜底：radix popper 可能不挂 role="menu"，只要出现可见的 menuitemcheckbox
         * 且带模式相关图标或文本就纳入（仅限刚点开 trigger 之后的 fallback 路径）。 */
        Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], [role="option"]'))
          .filter(isVisible)
          .filter((it) => {
            const txt = textOf(it) + ' ' + String(it.getAttribute('aria-label') || '');
            return containsModeWord(txt) || isThinkingIcon(iconOf(it)) || isFastIcon(iconOf(it));
          })
          .forEach(push);
        return out;
      };
      const matchItem = (item) => {
        const txt = textOf(item) + ' ' + String(item.getAttribute('aria-label') || '');
        const icon = iconOf(item);
        if (desired) return isThinkingText(txt) || isThinkingIcon(icon);
        return isFastText(txt) || isFastIcon(icon);
      };
      const fallbackMatchItem = (item) => {
        const allText = textOf(item) + ' ' + String(item.getAttribute('aria-label') || '');
        if (desired) return containsModeWord(allText) && !isFastText(allText);
        return isFastText(allText);
      };

      /* 触发器查找：文本匹配优先，其次 aria-label，最后图标兜底。
       * 页面在 composer 正下方存在 aria-hidden="true" 的 measure-capsule 测量副本，
       * 必须过滤（isVisible 已通过 closest([aria-hidden]) 实现）。 */
      const triggerCandidates = Array.from(document.querySelectorAll('button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]'))
        .filter((element) => isVisible(element) && enabled(element));
      let trigger = triggerCandidates.find((element) => {
        if (isModeWord(textOf(element))) return true;
        const label = String(element.getAttribute('aria-label') || '').trim();
        if (label && isModeWord(label)) return true;
        const icon = iconOf(element);
        if (isThinkingIcon(icon) || isFastIcon(icon)) return true;
        return false;
      });
      if (!trigger) return { ok: false, kind: 'mode_unavailable', mode: 'thinking' };

      /* 当前模式判定：文本 + 图标双通道。
       * 注意：auto（自动）既不算 thinking 也不算 fast，任何 desired 切换都会继续走点击流程。
       * 这样无论默认在 auto 时用户要 thinking 还是 fast，都能正确切到对应模式。 */
      const currentText = textOf(trigger) + ' ' + String(trigger.getAttribute('aria-label') || '').trim();
      const currentIcon = iconOf(trigger);
      const currentThinking = isThinkingText(currentText) || isThinkingIcon(currentIcon);
      const currentFast = isFastText(currentText) || isFastIcon(currentIcon);
      const currentAuto = isAutoText(currentText);
      if (desired === true && currentThinking) return { ok: true };
      if (desired === false && currentFast) return { ok: true };

      trigger.click();
      let items = collectModeItems();
      let targetItem = items.find(matchItem);
      if (!targetItem) {
        targetItem = items.find(fallbackMatchItem);
      }
      /* 极端情况：radix 动画还没把菜单项塞进 DOM → 以 pending 返回让上层 driver 重试。
       * 重试时如果 trigger 的当前模式已发生变化（例如页面静默完成切换），下一轮会走上面
       * 的 already-matched 短路直接成功。 */
      if (!targetItem) return { ok: true, pending: true, triggerClicked: true };

      const checked = (item) => item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-state') === 'checked';
      if (checked(targetItem)) return { ok: true };
      targetItem.click();
      /* radix 可能在下一个 UI tick 才回写 aria-checked，点击到目标项即视为成功。
       * 上层 driver 的重试循环会在 pending 时再验证一遍一致性。 */
      return checked(targetItem) ? { ok: true } : { ok: true, pending: true };
    })`,

    /* 模型选择：顶部 [aria-haspopup="dialog"] 触发器显示当前模型名；点击弹出
     * radix dialog 模型列表，列表项为带 .truncate 模型名的 cursor-pointer div。
     * 范围控制：未打开时页面主体 cursor-pointer+truncate 干扰项太多（会话列表、
     * 示例卡片），只从“浮层”（role=dialog / data-radix-* / portal）收集；浮层
     * 无特征时用 .truncate 文本精确匹配兜底（dialog 已点开时模型名在页面唯一）。 */
    selectModel: `((modelName) => {${sharedHelpers}
      if (!modelName) return { ok: false, kind: 'model_unavailable', reason: 'no model name provided' };
      const targetName = String(modelName).trim().toLowerCase();
      const looksLikeModel = (txt) => /^qwen/i.test(txt) || /千问|通义/.test(txt);
      const matches = (name) => !!name && (name.includes(targetName) || targetName.includes(name));

      const trigger = Array.from(document.querySelectorAll('[aria-haspopup="dialog"]'))
        .find((element) => isVisible(element) && looksLikeModel(textOf(element)));
      if (!trigger) return { ok: false, kind: 'model_unavailable', reason: 'model selector trigger not found' };

      const current = textOf(trigger);
      if (matches(current.toLowerCase())) return { ok: true, alreadySelected: true };

      const itemName = (item) => {
        const nameEl = item.querySelector('.truncate');
        return textOf(nameEl || item).split(/\\r?\\n/)[0].trim().toLowerCase();
      };
      const isSelected = (item) => {
        if (item.getAttribute('aria-selected') === 'true') return true;
        if (/\\bbg-weaken\\b/.test(String(item.className || ''))) return true;
        const checkExact = item.querySelector('[data-icon-type="qwpcicon-check"]');
        const checkMini = item.querySelector('[data-icon-type="qwpcicon-checkMini"]');
        return (checkExact && !/\\binvisible\\b/.test(String(checkExact.className || ''))) || (checkMini && !/\\binvisible\\b/.test(String(checkMini.className || '')));
      };
      const floaters = () => Array.from(document.querySelectorAll(
        '[role="dialog"], [data-radix-dialog-content], [data-radix-popper-content-wrapper], [data-radix-portal]'
      )).filter(isVisible);
      const modelScope = () => {
        const candidates = floaters().filter((el) => /模型/.test(textOf(el)));
        return candidates.length ? candidates[candidates.length - 1] : null;
      };
      const collectItems = (root) => Array.from(root.querySelectorAll('div'))
        .filter((item) => isVisible(item) && /cursor-pointer/.test(String(item.className || '')) && !!item.querySelector('.truncate'));

      /* dialog 可能已打开（上次残留）→ 先直接收集；否则点开 trigger 再收集。 */
      let items = [];
      const openedScope = modelScope();
      if (openedScope) items = collectItems(openedScope);
      if (!items.length) {
        trigger.click();
        const scope = modelScope();
        if (scope) items = collectItems(scope);
      }
      const targetItem = items.find((item) => matches(itemName(item)));
      if (!targetItem) {
        /* 浮层无 role/class 特征时的兜底：dialog 已点开，模型名在页面唯一，
         * 用 .truncate 文本精确匹配，取自身或最近可点击祖先。 */
        const nameEl = Array.from(document.querySelectorAll('.truncate')).find((el) => isVisible(el) && matches(textOf(el).toLowerCase()));
        const clickable = nameEl && (nameEl.closest('div.cursor-pointer') || nameEl.closest('[role="button"]') || nameEl.closest('button') || nameEl);
        if (!clickable) return { ok: false, kind: 'model_unavailable', reason: 'model not found: ' + modelName };
        if (isSelected(clickable)) return { ok: true, alreadySelected: true };
        clickable.click();
        const confirmed = matches(textOf(trigger).toLowerCase());
        return confirmed ? { ok: true, alreadySelected: false } : { ok: true, alreadySelected: false, pending: true };
      }
      if (isSelected(targetItem)) return { ok: true, alreadySelected: true };
      targetItem.click();
      const confirmed = isSelected(targetItem) || matches(textOf(trigger).toLowerCase());
      return confirmed ? { ok: true, alreadySelected: false } : { ok: true, alreadySelected: false, pending: true };
    })`,
  },
};