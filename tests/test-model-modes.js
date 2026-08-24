/* 单元测试：最新页面模式映射 + pill 幂等切换（2026-08 页面重构适配）
 * 背景：chat.deepseek.com 改版——模型选择器（专家模式）已下线，统一为
 * 输入框下方 pill 开关：快速模式（可选 深度思考/智能搜索）、专家模式（可选 深度思考）、识图模式（可选 深度思考）。
 * 旧实现两类缺陷：
 *   1. reasoner 依赖"专家模式"选择器/校准回放 → 已下线 → 静默退化快速模式
 *   2. pill 是开关，旧代码"点击了事"不读状态 → 连续请求会把已开启的思考再点关
 * 修复：EXPR.setToggle 幂等（读状态→不一致才点击）+ applyConfig 重写 +
 *       网关 MODELS 对齐（chat/reasoner/search/vision）+ 校准降级 fallback。
 * 运行：node tests/test-model-modes.js （纯离线：源码提取 + fake DOM） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DRV_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'driver.js'), 'utf8');
const GW_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

/* ---------- 从源码提取 EXPR 函数模板（区分转义反引号） ---------- */
function grabTemplate(src, name) {
  const idx = src.indexOf('  ' + name + ':');
  if (idx < 0) throw new Error('EXPR.' + name + ' not found');
  let i = src.indexOf('`', idx) + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
    if (c === '`') return out;
    out += c; i++;
  }
  throw new Error('EXPR.' + name + ' unterminated');
}
/* setToggle(labels, want) 是模板函数：eval 源码还原函数本体 */
const setToggleFn = eval('(labels, want) => `' + grabTemplate(DRV_SRC, 'setToggle') + '`');
const toggleStateFn = eval('(labels) => `' + grabTemplate(DRV_SRC, 'toggleState') + '`');

/* ---------- fake DOM pill ---------- */
function pill(opts) {
  /* opts: { text, pressed, checked, selected, dataState, cls, ariaLabel, title } */
  const state = { clicked: false };
  const node = {
    nodeType: 1, tagName: 'BUTTON', className: opts.cls || '',
    innerText: opts.text || '', textContent: opts.text || '',
    childNodes: [],
    getAttribute: (n) => {
      if (n === 'aria-pressed') return opts.pressed;
      if (n === 'aria-checked') return opts.checked;
      if (n === 'aria-selected') return opts.selected;
      if (n === 'aria-label') return opts.ariaLabel;
      if (n === 'title') return opts.title;
      if (n === 'data-state') return opts.dataState;
      return null;
    },
    getBoundingClientRect: () => ({ width: 60, height: 26 }),
    click: () => { state.clicked = true; },
    __state: state,
  };
  return node;
}
function runPill(expr, pills) {
  const doc = {
    querySelectorAll: () => pills,
    querySelector: () => pills[0] || null,
    body: { innerText: '', querySelectorAll: () => [], querySelector: () => null },
  };
  return {
    ret: vm.runInNewContext(expr, { document: doc }, { timeout: 2000 }),
    pills,
  };
}
const THINK = ['深度思考', 'DeepThink', 'Deep Think', '深度推理'];

/* ---------- 1. setToggle 幂等语义（核心修复） ---------- */
/* 1a 关闭态 + want=true → 点击 */
{
  const p = pill({ text: '深度思考', pressed: 'false' });
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1a 关闭+want开 → clicked 且实际点击', ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}
/* 1b 开启态 + want=true → 不点击（幂等核心——旧代码会误关） */
{
  const p = pill({ text: '深度思考', pressed: 'true' });
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1b 开启+want开 → none 且不点击（幂等）', ret.action === 'none' && p.__state.clicked === false, JSON.stringify(ret));
}
/* 1c 开启态 + want=false → 点击关闭（chat 请求需关思考） */
{
  const p = pill({ text: '深度思考', pressed: 'true' });
  const { ret } = runPill(setToggleFn(THINK, false), [p]);
  check('1c 开启+want关 → clicked（关闭）', ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}
/* 1d 关闭态 + want=false → 不点击 */
{
  const p = pill({ text: '深度思考', pressed: 'false' });
  const { ret } = runPill(setToggleFn(THINK, false), [p]);
  check('1d 关闭+want关 → none', ret.action === 'none' && p.__state.clicked === false, JSON.stringify(ret));
}
/* 1e pill 不存在 → not-found（触发校准 fallback 的信号） */
{
  const { ret } = runPill(setToggleFn(THINK, true), []);
  check('1e 无 pill → found=false', ret.found === false && ret.action === 'none', JSON.stringify(ret));
}
/* 1f 连续两次设置相同目标（模拟连续两个 reasoner 请求）→ 第二次不点击 */
{
  const p = pill({ text: '深度思考', pressed: 'false' });
  runPill(setToggleFn(THINK, true), [p]); /* 第一次：点击开启 */
  /* 模拟点击后状态翻转 */
  p.getAttribute = (n) => (n === 'aria-pressed' ? 'true' : null);
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1f 连续两次 reasoner → 第二次不重复点击（旧 bug 场景）', ret.action === 'none', JSON.stringify(ret));
}
/* 1g 状态信号变体：aria-checked / data-state / class active */
{
  const p = pill({ text: '深度思考', checked: 'true' });
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1g1 aria-checked=true 判定为开', ret.action === 'none', JSON.stringify(ret));
}
{
  const p = pill({ text: '深度思考', dataState: 'checked' });
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1g2 data-state=checked 判定为开', ret.action === 'none', JSON.stringify(ret));
}
{
  const p = pill({ text: '深度思考', cls: 'e5a6c7 active' });
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1g3 class 含 active 判定为开', ret.action === 'none', JSON.stringify(ret));
}
{
  const p = pill({ text: '深度思考', dataState: 'off' });
  const { ret } = runPill(setToggleFn(THINK, true), [p]);
  check('1g4 data-state=off 判定为关 → 点击', ret.action === 'clicked', JSON.stringify(ret));
}
/* 1h 智能搜索 pill */
{
  const p = pill({ text: '智能搜索', pressed: 'false' });
  const { ret } = runPill(setToggleFn(['智能搜索', '联网搜索', '联网', 'Search'], true), [p]);
  check('1h 智能搜索 pill 开启', ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}

/* ---------- 2. toggleState 读取 ---------- */
{
  const p = pill({ text: '深度思考', pressed: 'true' });
  const { ret } = runPill(toggleStateFn(THINK), [p]);
  check('2a toggleState 读开启态', ret.found === true && ret.state === true, JSON.stringify(ret));
}
{
  const { ret } = runPill(toggleStateFn(THINK), []);
  check('2b toggleState 无 pill → found=false', ret.found === false, JSON.stringify(ret));
}

/* ---------- 3. 网关 MODELS 映射（对齐最新页面三模式八组合） ---------- */
const { MODELS } = require('../resources/provider-registry');
const mMatch = !!MODELS;
check('3a MODELS 由 provider registry 提供', mMatch);
if (mMatch) {
  check('3b deepseek-chat = 快速无开关', MODELS['deepseek-chat'].mode === 'quick' && MODELS['deepseek-chat'].deepThink === false && MODELS['deepseek-chat'].search === false, JSON.stringify(MODELS['deepseek-chat']));
  /* 深度思考是快速模式的 pill 选项（V3 增强 CoT），reasoner = 快速 + 深度思考；
   * 与 SPEC.md / README / 用户描述一致（三模式均可选深度思考）。 */
  check('3c deepseek-reasoner = 快速 + 深度思考（quick 的 深度思考 pill）', MODELS['deepseek-reasoner'].mode === 'quick' && MODELS['deepseek-reasoner'].deepThink === true && MODELS['deepseek-reasoner'].search === false, JSON.stringify(MODELS['deepseek-reasoner']));
  check('3d deepseek-search = 快速+智能搜索', MODELS['deepseek-search'] && MODELS['deepseek-search'].search === true, JSON.stringify(MODELS['deepseek-search']));
  check('3d2 deepseek-think-search = 快速+深度思考+智能搜索', MODELS['deepseek-think-search'] && MODELS['deepseek-think-search'].mode === 'quick' && MODELS['deepseek-think-search'].deepThink === true && MODELS['deepseek-think-search'].search === true, JSON.stringify(MODELS['deepseek-think-search']));
  check('3e deepseek-vision = 识图（纯识图，不带思考）', MODELS['deepseek-vision'].mode === 'vision' && MODELS['deepseek-vision'].deepThink === false, JSON.stringify(MODELS['deepseek-vision']));
  check('3e2 deepseek-vision-reasoner = 识图+深度思考', MODELS['deepseek-vision-reasoner'] && MODELS['deepseek-vision-reasoner'].mode === 'vision' && MODELS['deepseek-vision-reasoner'].deepThink === true, JSON.stringify(MODELS['deepseek-vision-reasoner']));
  check('3f deepseek-expert = 专家模式', MODELS['deepseek-expert'] && MODELS['deepseek-expert'].mode === 'expert' && MODELS['deepseek-expert'].deepThink === false, JSON.stringify(MODELS['deepseek-expert']));
  /* 专家模式可选深度思考：expert-reasoner = 专家入口 + 开启 深度思考 pill；
   * 与模型名"专家+深度思考"及用户描述一致。 */
  check('3f2 deepseek-expert-reasoner = 专家 + 深度思考（expert 入口，deepThink=true）', MODELS['deepseek-expert-reasoner'] && MODELS['deepseek-expert-reasoner'].mode === 'expert' && MODELS['deepseek-expert-reasoner'].deepThink === true, JSON.stringify(MODELS['deepseek-expert-reasoner']));
  check('3g registry 保留 8 个 DeepSeek 模型（总公开模型 13 个）', Object.keys(MODELS).filter((id) => id.startsWith('deepseek-')).length === 8 && Object.keys(MODELS).length === 13, 'count=' + Object.keys(MODELS).length);
  check('3h DeepSeek expert/vision 模型均不带 search（页面无此 pill）', Object.values(MODELS).filter((m) => m.providerId === 'deepseek').every((m) => m.mode === 'quick' || m.search === false));
}

/* ---------- 4. 调用链源码断言 ---------- */
check('4a 网关 streamAsk 传 search 开关', /search: cfg\.search === true/.test(GW_SRC));
check('4b driver streamAsk 调用 applyConfig（pill 主路径）', /const rep = await applyConfig\(pageId, \{/.test(DRV_SRC));
check('4c 校准降级为 fallback（pill 未找到才回放）', /needFallback[\s\S]{0,200}applyCalibration\(pageId, params\.calibKey\)/.test(DRV_SRC));
check('4d applyConfig 幂等 setPill think', /setPill\(pageId, \['深度思考'/.test(DRV_SRC));
check('4e applyConfig 幂等 setPill search', /setPill\(pageId, \['智能搜索'/.test(DRV_SRC));
check('4f 旧"专家模式"盲点击已移除', !/clickText\(\['专家模式', 'DeepSeek-R1'/.test(DRV_SRC));
check('4g applyConfig 三模式入口含图标标签（闪电/钻石/眼睛）', /quick: \['快速'/.test(DRV_SRC) && /expert: \['专家'/.test(DRV_SRC) && /vision: \['识图'/.test(DRV_SRC) && /闪电/.test(DRV_SRC) && /钻石/.test(DRV_SRC) && /眼睛/.test(DRV_SRC));
check('4h search 仅 quick 模式应用', /wantSearch = opts\.search === true && wantMode === 'quick'/.test(DRV_SRC));
check('4i expert 模式入口找不到时降级盲点击', /!m\.ok && wantMode !== 'quick'/.test(DRV_SRC));

/* ---------- 5. aria-label / title 匹配（图标按钮定位修复） ---------- */
const EXPERT = ['专家', '专家模式', 'Expert', '钻石', '钻石模式', 'Pro'];
/* 5a 图标按钮无 innerText 但有 aria-label="专家模式" → 可定位 */
{
  const p = pill({ ariaLabel: '专家模式', pressed: 'false' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5a aria-label 匹配"专家模式" → found+clicked', ret.found === true && ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}
/* 5b 图标按钮有 title="擅长复杂问题" → includes "专家" 不可匹配，但 includes "钻石" 也不可；
 *    但 title="专家模式 · 擅长复杂问题" → includes "专家" 可匹配 */
{
  const p = pill({ title: '专家模式 · 擅长复杂问题', pressed: 'false' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5b title 含"专家模式" → found+clicked', ret.found === true && ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}
/* 5c aria-label 匹配 + 已激活 → 不重复点击 */
{
  const p = pill({ ariaLabel: '专家模式', selected: 'true' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5c aria-label 匹配 + aria-selected=true → 幂等不点击', ret.action === 'none' && p.__state.clicked === false, JSON.stringify(ret));
}
/* 5d aria-selected 状态检测 */
{
  const p = pill({ text: '专家', selected: 'false' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5d aria-selected=false → 判定为关 → 点击', ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}
/* 5e data-state=selected 判定为开 */
{
  const p = pill({ text: '专家', dataState: 'selected' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5e data-state=selected → 判定为开 → 幂等不点击', ret.action === 'none', JSON.stringify(ret));
}
/* 5f class 含 current 判定为开 */
{
  const p = pill({ text: '专家', cls: 'tab-item current' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5f class 含 current → 判定为开 → 幂等不点击', ret.action === 'none', JSON.stringify(ret));
}
/* 5g toggleState 也支持 aria-label 匹配 */
{
  const p = pill({ ariaLabel: '专家模式', selected: 'true' });
  const { ret } = runPill(toggleStateFn(EXPERT), [p]);
  check('5g toggleState aria-label 匹配 + aria-selected=true', ret.found === true && ret.state === true, JSON.stringify(ret));
}
/* 5h 快速模式闪电图标：aria-label="快速模式" */
{
  const QUICK = ['快速', '快速模式', 'Quick', '闪电', '闪电模式', 'Instant'];
  const p = pill({ ariaLabel: '快速模式', pressed: 'true' });
  const { ret } = runPill(setToggleFn(QUICK, true), [p]);
  check('5h 快速模式 aria-label 匹配 + 已激活 → 幂等', ret.action === 'none' && p.__state.clicked === false, JSON.stringify(ret));
}
/* 5i 识图模式眼睛图标：title="识图模式" */
{
  const VISION = ['识图', '视图', '识图模式', '图片理解', 'Vision', '眼睛'];
  const p = pill({ title: '识图模式', pressed: 'false' });
  const { ret } = runPill(setToggleFn(VISION, true), [p]);
  check('5i 识图模式 title 匹配 → found+clicked', ret.found === true && ret.action === 'clicked' && p.__state.clicked === true, JSON.stringify(ret));
}
/* 5j 无文本无 aria-label 无 title → not-found */
{
  const p = pill({ text: '', ariaLabel: '', title: '' });
  const { ret } = runPill(setToggleFn(EXPERT, true), [p]);
  check('5j 纯图标无辅助属性 → not-found', ret.found === false, JSON.stringify(ret));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);