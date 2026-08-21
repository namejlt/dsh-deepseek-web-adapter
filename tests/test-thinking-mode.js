/* 单元测试：思考模式（DeepThink）内容提取完整性
 * 背景 bug：专家模式（深度思考）下 DSH 获取内容不全，三个交互缺陷：
 *   1. extractLast 兜底选择器捕获思考流文本 → 思考文本被当作回答
 *   2. 思考折叠（"已深度思考"）→ 正文开始之间有数秒间隙，
 *      5 秒未变兜底触发 → 轮询提前退出 → finalText = 思考片段/正文开头
 *   3. 完成判定 lastChange=0 时 Date.now()-0≥800 恒真 + genSeen 分支
 *      → 可能把上一轮旧回答当本轮结果返回
 * 修复：extractLast 的 walk 排除思考容器 + EXPR.thinking 思考中检测 +
 *       轮询完成判定统一要求 lastChange>0 && !gen && !thinking。
 * 测试方法：从 driver.js 源码提取 EXPR 模板字符串，vm 沙箱 + fake DOM 执行。
 * 运行：node tests/test-thinking-mode.js （纯离线） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'resources', 'driver.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

/* ---------- 从源码提取 EXPR 模板字符串（手写扫描：区分转义反引号） ---------- */
function grabExpr(src, name) {
  const start = src.indexOf('  ' + name + ': `');
  if (start < 0) throw new Error('EXPR.' + name + ' not found');
  let i = src.indexOf('`', start) + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
    if (c === '`') return out;
    out += c; i++;
  }
  throw new Error('EXPR.' + name + ' unterminated');
}
const extractLastSrc = grabExpr(SRC, 'extractLast');
const thinkingSrc = grabExpr(SRC, 'thinking');
const extractThinkingSrc = grabExpr(SRC, 'extractThinking');
const extractLastExpr = eval('`' + extractLastSrc + '`'); /* 求值模板字面量（\\S → \S 等） */
const thinkingExpr = eval('`' + thinkingSrc + '`');
const extractThinkingExpr = eval('`' + extractThinkingSrc + '`');

/* ---------- fake DOM ---------- */
function el(opts) {
  /* opts: { cls, tag, children, innerText, display, closestBtn } */
  const node = {
    nodeType: 1,
    tagName: String(opts.tag || 'div').toUpperCase(),
    className: opts.cls || '',
    childNodes: opts.children || [],
    querySelector: () => null,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 100, height: 50 }),
    __display: opts.display || 'block',
  };
  if (opts.innerText !== undefined) node.innerText = opts.innerText;
  if (opts.closestBtn) node.closest = () => ({ tag: 'button' });
  else node.closest = () => null;
  return node;
}
function tx(text) { return { nodeType: 3, textContent: text, childNodes: [] }; }
function makeDoc(selectorMap, bodyInnerText) {
  return {
    querySelectorAll: (sel) => selectorMap[sel] || [],
    querySelector: (sel) => (selectorMap[sel] || [])[0] || null,
    /* body 兜底链（extractLast 的 conv fallback 会落到 body）：无匹配 */
    body: {
      innerText: bodyInnerText || '',
      querySelectorAll: () => [],
      querySelector: () => null,
    },
  };
}
function runExpr(expr, doc) {
  const sandbox = {
    document: doc,
    window: {
      getComputedStyle: (e) => ({ display: e.__display || 'block', visibility: 'visible', opacity: '1' }),
      document: doc,
    },
  };
  return vm.runInNewContext(expr, sandbox, { timeout: 2000 });
}

/* ---------- 场景数据：DeepSeek 网页版思考模式典型消息结构 ---------- */
const THINK_STREAM = '用户想要分析菜根谭，我需要从明代处世哲学的角度切入，先梳理原文结构再提炼核心观点……';
const FOLD_HEADER = '已深度思考（用时 12 秒）';
const BODY_TEXT = '《菜根谭》核心精华：处世让一步为高，待人宽一分是福。';

/* 场景 A：思考流 + 正文共存（流式思考阶段或折叠后 DOM 未清理） */
const mainA = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'ds-thinking-block', children: [tx(THINK_STREAM)] }),
  el({ cls: 'ds-markdown', children: [
    tx(BODY_TEXT),
    el({ tag: 'p', children: [tx('径路窄处留一步，滋味浓时减三分。')] }),
  ] }),
] });
const docA = makeDoc({ '.ds-assistant-message-main-content': [mainA] });

/* 场景 B：纯思考、正文未开始（思考中） */
const mainB = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'ds-thinking-block', children: [tx(THINK_STREAM)] }),
] });
const docB = makeDoc({ '.ds-assistant-message-main-content': [mainB] });

/* 场景 C：折叠头残留 + 正文（折叠后） */
const mainC = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'thinking', innerText: FOLD_HEADER, children: [tx(FOLD_HEADER)] }),
  el({ cls: 'ds-markdown', children: [tx(BODY_TEXT)] }),
] });
const docC = makeDoc({ '.ds-assistant-message-main-content': [mainC] });

/* 场景 D：普通模式（无思考块）——回归（正文需 >10 字符才走 direct 主选择器） */
const PLAIN_ANSWER = '普通模式回答正文：这是一段足够长的回答内容。';
const mainD = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'ds-markdown', children: [tx(PLAIN_ANSWER)] }),
] });
const docD = makeDoc({ '.ds-assistant-message-main-content': [mainD] });

/* 场景 E：正文内容本身含"思考"字样（防误杀回归） */
const mainE = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'ds-markdown', children: [tx('经过思考，我认为答案是 42。')] }),
] });
const docE = makeDoc({ '.ds-assistant-message-main-content': [mainE] });

/* ---------- 1. extractLast：思考文本不混入 ---------- */
const rA = runExpr(extractLastExpr, docA);
check('1a 思考流文本不混入回答', rA.indexOf(THINK_STREAM) < 0, rA.slice(0, 120));
check('1b 正文完整提取', rA.indexOf(BODY_TEXT) >= 0 && rA.indexOf('径路窄处') >= 0, rA.slice(0, 120));

const rB = runExpr(extractLastExpr, docB);
check('1c 纯思考阶段返回空（等待正文，不当思考当答案）', rB === '' || rB.length <= 10, JSON.stringify(rB));

const rC = runExpr(extractLastExpr, docC);
check('1d 折叠头"已深度思考"不混入', rC.indexOf(FOLD_HEADER) < 0 && rC.indexOf('已深度思考') < 0, rC.slice(0, 120));
check('1e 折叠后正文正常', rC.indexOf(BODY_TEXT) >= 0);

const rD = runExpr(extractLastExpr, docD);
check('1f 普通模式不回归', rD.indexOf(PLAIN_ANSWER) >= 0);

const rE = runExpr(extractLastExpr, docE);
check('1g 正文含"思考"字样不误杀', rE.indexOf('经过思考，我认为答案是 42。') >= 0);

/* 场景 F：真实类名 .ds-think-content（含 think 与 content，旧排除列表 content 会让跳过失效） */
const THINK_REAL = '让我从明代处世哲学角度分析菜根谭……';
const mainF = el({ cls: 'ds-assistant-message-main-content', children: [
  el({ cls: 'ds-think-content', children: [tx(THINK_REAL)] }),
  el({ cls: 'ds-markdown', children: [tx(BODY_TEXT)] }),
] });
const docF = makeDoc({ '.ds-assistant-message-main-content': [mainF] });
const rF = runExpr(extractLastExpr, docF);
check('1h 真实类 ds-think-content 思考文本不混入正文', rF.indexOf(THINK_REAL) < 0, rF.slice(0, 120));
check('1i 真实类 ds-think-content 正文完整提取', rF.indexOf(BODY_TEXT) >= 0, rF.slice(0, 120));

/* ---------- 2. thinking 检测 ---------- */
/* 2a 思考中：可见 thinking 容器 + 思考流文本 */
const thinkOpen = el({ cls: 'ds-thinking-block', innerText: THINK_STREAM, children: [tx(THINK_STREAM)] });
check('2a 思考流可见 → thinking=true', runExpr(thinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkOpen] })) === true);

/* 2b 完成折叠：可见容器但内容是折叠头 */
const thinkFolded = el({ cls: 'ds-thinking-block', innerText: FOLD_HEADER, children: [tx(FOLD_HEADER)] });
check('2b 折叠头（已深度思考）→ thinking=false', runExpr(thinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkFolded] })) === false);

/* 2c 折叠内容 display:none（innerText 实际为空——textContent 会误读，此处模拟浏览器行为） */
const thinkHidden = el({ cls: 'ds-thinking-block', display: 'none', children: [tx(THINK_STREAM)] });
check('2c display:none 折叠内容 → thinking=false', runExpr(thinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkHidden] })) === false);

/* 2d 全局进行时标题 */
check('2d body 含"深度思考中..." → thinking=true', runExpr(thinkingExpr, makeDoc({}, '深度思考中...')) === true);
check('2d2 body 含英文 "Thinking..." → thinking=true', runExpr(thinkingExpr, makeDoc({}, 'Thinking...')) === true);

/* 2e 无思考容器 */
check('2e 无思考容器 → thinking=false', runExpr(thinkingExpr, makeDoc({})) === false);

/* 2f 深度思考开关按钮（在 button 内）不算思考中 */
const thinkBtn = el({ cls: 'deep-thinking-toggle', innerText: '深度思考', closestBtn: true });
check('2f 思考开关按钮（button 内）→ thinking=false', runExpr(thinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkBtn] })) === false);

/* 2g 正文中的字样不触发（body 全局标题检测只认"深度思考中/正在深度思考"进行时） */
check('2g 正文提到"已深度思考"不误判', runExpr(thinkingExpr, makeDoc({}, '关于这个问题，已深度思考过了。最终答案是 42。')) === false);

/* 2h/2i/2j 真实类名 .ds-think-content（含 think 但无 thinking 子串，旧 [class*="thinking"] 匹配不到） */
const thinkReal = el({ cls: 'ds-think-content', innerText: THINK_REAL, children: [tx(THINK_REAL)] });
check('2h ds-think-content 可见 → thinking=true', runExpr(thinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkReal] })) === true);
check('2i ds-think-content 可见 → extractThinking 提取思考流', runExpr(extractThinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkReal] })) === THINK_REAL);
const thinkRealHidden = el({ cls: 'ds-think-content', display: 'none', children: [tx(THINK_REAL)] });
check('2j ds-think-content 折叠 display:none → thinking=false', runExpr(thinkingExpr, makeDoc({ '[class*="think"], [class*="reasoning"]': [thinkRealHidden] })) === false);

/* ---------- 3. 完成判定源码断言（轮询循环无法离线驱动，静态验证关键条件） ---------- */
check('3a streamAsk 完成判定含 !thinking', /lastChange > 0 && lastText\.length > 10 && !gen && !thinking/.test(SRC));
check('3b 5s 兜底稳定即完成（不再依赖 !gen，防 generating 误判卡死）', /lastChange > 0 && !thinking && Date\.now\(\) - lastChange >= 5000/.test(SRC));
check('3c waitForResponse 思考防线 + gen 独立兜底（稳定≥5s 即完成）', /if \(!thinking\) \{[\s\S]*?!gen \|\| Date\.now\(\) - stableStart >= Math\.max\(stableDelayMs, 5000\)\) break;/.test(SRC));
check('3d walk 排除思考容器（think/reasoning 且非强正文类，去掉 content 以免 .ds-think-content 漏过）', /cls && \/think\|reasoning\/\.test\(cls\) && !\/markdown\|answer\|message\|reply\|response\/\.test\(cls\)/.test(SRC));
check('3e EXPR.doneActions 定义（完成态正信号：复制/重新生成按钮）', /doneActions: `\(\(\) => \{/.test(SRC));
check('3f 完成判定含 doneSignal（停止按钮消失 或 完成态动作按钮）', /const doneSignal = \(genSeen && !gen\) \|\| doneActions;/.test(SRC));
check('3g 正信号路径：doneSignal 稳定 400ms 即完成（最快、最可靠）', /doneSignal && !thinking && Date\.now\(\) - lastChange >= 400/.test(SRC));
check('3h 兜底路径：非生成+非思考 稳定 1500ms 完成（防生成中静默间隙误 break）', /!gen && !thinking && Date\.now\(\) - lastChange >= 1500/.test(SRC));
check('3i 终态兜底收割：退出前再抓一次 extractLast 取较长者防丢内容', /const re = cleanText\(await evalJs\(pageId, EXPR\.extractLast\)/.test(SRC) && /if \(re\.length > finalText\.length\) finalText = re;/.test(SRC));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
