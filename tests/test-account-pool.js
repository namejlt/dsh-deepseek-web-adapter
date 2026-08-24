/* 单元测试：多账号池（AccountPool）· 限流自动切换 · 动态风控退避策略
 * 覆盖 SPEC-v2：§5.1 状态机/指数退避/二次确认、§5.2 调度、§5.4 切换重试、§5.6 落盘、
 * FF4（切换后 mode=recovery）、FF5/FF5b（状态持久/退避正确性）、FF8（无凭据落盘）。
 * 运行：node tests/test-account-pool.js （纯离线：vm 沙箱 + mock rpc，不启动浏览器/网关） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const GW_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');
const DRV_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'driver.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 沙箱工厂：加载 gateway（截断到 server.listen 前） ---------- */
function makeGateway(tmpBase) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const fakeResources = path.join(tmpBase, 'res');
  fs.mkdirSync(fakeResources, { recursive: true });
  const cut = GW_SRC.indexOf('server.listen(');
  if (cut < 0) throw new Error('server.listen not found');
  /* const 声明（pool/state）不泄漏到沙箱全局 → 末尾显式导出测试所需的绑定 */
  const code = GW_SRC.slice(0, cut) + `
;globalThis.__x = {
  pool, state, backoffMs, poolRefresh, poolMarkQuota, poolMarkOk, poolMarkDown,
  poolAdd, poolRemove, poolSetEnabled, poolPick, poolEarliestRetry, poolDescribe,
  effectiveConcurrent, handleChatCompletion,
};`;
  const sandbox = {
    require: (m) => {
      if (!['fs', 'path', 'http', 'crypto', 'child_process'].includes(m)) throw new Error('not allowed: ' + m);
      return require(m);
    },
    process: { argv: ['node', 'gw', '--base', tmpBase], env: {}, on: () => {}, exit: () => {}, platform: process.platform },
    __dirname: fakeResources,
    __filename: path.join(fakeResources, 'dsweb-gateway.js'),
    console: { log: () => {}, error: () => {}, warn: () => {} }, /* 静音网关日志 */
    setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dsweb-gateway.js' });
  /* 返回导出绑定的浅拷贝 + 原始沙箱（mock 需覆盖沙箱顶层函数绑定） */
  return Object.assign(Object.create(null), sandbox.__x, { __sandbox: sandbox });
}

/* ---------- mock rpc / res：驱动 handleChatCompletion 集成流程 ---------- */
function makeRpcMock(gw, script, loginResult) {
  const calls = [];
  let ensureCount = 0;
  let seq = 0;
  const d = { consumers: new Map() };
  const sb = gw.__sandbox;
  /* 覆盖沙箱顶层绑定（function 声明挂在 globalThis 上，直接改属性即可生效） */
  sb.ensureDriver = async () => { ensureCount++; return d; };
  sb.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'streamAsk') {
      const streamId = 's' + (++seq);
      setTimeout(() => {
        const c = d.consumers.get(streamId);
        if (!c) return;
        const resp = script.length ? script.shift() : { ok: true, result: '' };
        for (const event of resp.events || []) c.push(event.delta, event.kind);
        c.end(resp);
      }, 5);
      return { streamId };
    }
    if (method === 'login') return loginResult || { ok: true, loggedIn: true };
    return { ok: true };
  };
  return { calls, d, getEnsureCount: () => ensureCount };
}
function makeResMock() {
  return {
    statusCode: null, headers: null,
    setHeader() {}, writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers || null; },
    chunks: [], write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; },
  };
}
function sseText(res) { return res.chunks.join(''); }

/* 首轮请求 payload（无 assistant 历史 → mode=first） */
const PAYLOAD_FIRST = {
  model: 'deepseek-chat',
  messages: [
    { role: 'system', content: '你是测试助手' },
    { role: 'user', content: 'Current runtime context:\n- cwd: /tmp\n- DSH file policy: full auto\n- Approval policy: auto' },
    { role: 'user', content: '读一下文件' },
  ],
};

(async () => {
  console.log('== 1. AccountPool 状态机与退避（SPEC-v2 §5.1，FF5b） ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-pool-'));
    const gw = makeGateway(tmp);

    /* 1a 初始化：无文件 → default active */
    check('1a 无文件初始化 default active', gw.pool.accounts.size === 1 && gw.pool.accounts.get('default').state === 'active');

    /* 1b 指数退避序列：base=5min，×2，封顶 6h */
    const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => gw.backoffMs(n));
    const expect = [300000, 600000, 1200000, 2400000, 4800000, 9600000, 19200000, 21600000, 21600000];
    check('1b 退避序列 5min×2^(n-1) 封顶 6h', JSON.stringify(seq) === JSON.stringify(expect), JSON.stringify(seq));

    /* 1c 二次确认：首次 suspect（保持 active），窗口内二次 → cooling 第 1 次退避 */
    gw.poolMarkQuota('default');
    let a = gw.pool.accounts.get('default');
    check('1c1 首次受限保持 active（suspect）', a.state === 'active' && a.quotaHits === 1);
    gw.poolMarkQuota('default');
    a = gw.pool.accounts.get('default');
    check('1c2 窗口内二次确认 → cooling', a.state === 'cooling' && a.backoffCount === 1);
    check('1c3 退避时长 = base（5min）', Math.abs(a.cooldownUntil - Date.now() - 300000) < 2000);

    /* 1d cooling 到期 → probing（惰性）；probe 成功 → active 清零 */
    a.cooldownUntil = Date.now() - 1;
    gw.poolRefresh(a);
    check('1d1 到期 → probing', a.state === 'probing');
    gw.poolMarkOk('default');
    a = gw.pool.accounts.get('default');
    check('1d2 探测成功 → active 退避清零', a.state === 'active' && a.backoffCount === 0 && a.requestCount === 1);

    /* 1e probing 探测失败 → 退避翻倍 */
    gw.poolMarkQuota('default'); /* 首次（窗口外，markOk 已清 lastQuotaAt）→ suspect */
    gw.poolMarkQuota('default'); /* 窗口内 → cooling count=1 */
    a = gw.pool.accounts.get('default');
    a.cooldownUntil = Date.now() - 1;
    gw.poolRefresh(a);
    check('1e1 到期 → probing', a.state === 'probing' && a.backoffCount === 1);
    gw.poolMarkQuota('default'); /* probing 失败 → count=2 */
    a = gw.pool.accounts.get('default');
    check('1e2 探测失败 → cooling 退避翻倍（10min）', a.state === 'cooling' && a.backoffCount === 2 && Math.abs(a.cooldownUntil - Date.now() - 600000) < 2000);

    /* 1f captcha → disabled；markOk 不自动恢复 disabled */
    gw.poolMarkDown('default', 'captcha');
    check('1f1 captcha → disabled', gw.pool.accounts.get('default').state === 'disabled');
    gw.poolMarkOk('default');
    check('1f2 disabled 不被 markOk 自动恢复', gw.pool.accounts.get('default').state === 'disabled');
    gw.poolSetEnabled('default', true);
    check('1f3 手动启用 → needs_login（需登录验证）', gw.pool.accounts.get('default').state === 'needs_login');

    /* 1g 落盘恢复（FF5）：状态/退避字段跨实例保留 */
    gw.poolMarkOk('default'); /* → active */
    gw.poolAdd('acc2');
    gw.pool.accounts.get('acc2').state = 'active'; /* 模拟已登录（quota 信号只会来自被调度选中的 active/probing 账号） */
    gw.poolMarkQuota('acc2'); gw.poolMarkQuota('acc2'); /* acc2 → cooling count=1 */
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'accounts.json'), 'utf8'));
    const gw2 = makeGateway(tmp);
    const r1 = gw2.pool.accounts.get('default');
    const r2 = gw2.pool.accounts.get('acc2');
    check('1g1 落盘恢复：账号集合一致', gw2.pool.accounts.size === 2 && !!r1 && !!r2);
    check('1g2 落盘恢复：cooling 状态与退避字段', r2.state === 'cooling' && r2.backoffCount === 1 && Math.abs(r2.cooldownUntil - saved.accounts.find((x) => x.name === 'acc2').cooldownUntil) === 0);
    check('1g3 FF8 落盘无凭据字段', !/password|cookie|token/i.test(fs.readFileSync(path.join(tmp, 'accounts.json'), 'utf8')));

    /* 1h 调度（§5.2）：轮转（最旧优先）/ 粘性 / exclude / suspect 绕开 */
    gw2.poolMarkOk('acc2'); /* acc2 → active */
    const d1 = gw2.pool.accounts.get('default');
    const a2 = gw2.pool.accounts.get('acc2');
    d1.lastUsedAt = 1000; a2.lastUsedAt = 2000;
    check('1h1 轮转选最旧', gw2.poolPick().name === 'default');
    check('1h2 粘性优先', gw2.poolPick('acc2').name === 'acc2');
    check('1h3 exclude 排除', gw2.poolPick(null, new Set(['default'])).name === 'acc2');
    /* suspect 窗口内绕开 */
    gw2.poolMarkQuota('acc2'); /* acc2 首次 suspect */
    check('1h4 suspect 窗口内被绕开', gw2.poolPick().name === 'default');
    check('1h5 粘性 suspect 也不选', gw2.poolPick('acc2').name === 'default');

    /* 1i 全受限 → poolPick null + 最早探测时间 */
    gw2.poolMarkQuota('default'); gw2.poolMarkQuota('default'); /* default cooling */
    gw2.poolMarkQuota('acc2'); gw2.poolMarkQuota('acc2'); /* acc2 cooling */
    check('1i1 全 cooling → 无可用', gw2.poolPick() === null);
    const er = gw2.poolEarliestRetry();
    check('1i2 最早探测账号存在', !!er && (er.name === 'default' || er.name === 'acc2'));

    /* 1j accountPool=false 旁路（FF1 回退开关） */
    gw2.state.accountPool = false;
    check('1j 旁路模式恒选 default（即使 cooling）', gw2.poolPick().name === 'default');

    /* 1k 账号管理校验 */
    gw2.state.accountPool = true;
    gw2.state.maxAccounts = 2;
    let err = null;
    try { gw2.poolAdd('acc3'); } catch (e) { err = e.message; }
    check('1k1 超上限拒绝添加', /上限/.test(err || ''));
    try { gw2.poolAdd('default'); } catch (e) { err = e.message; }
    check('1k2 重名拒绝', /已存在/.test(err || ''));
    try { gw2.poolRemove('acc2'); } catch (e) { err = e.message; }
    check('1k3 删除需二次确认', /confirm/.test(err || ''));
    try { gw2.poolRemove('default', true); } catch (e) { err = e.message; }
    check('1k4 default 不可删', /不可删除/.test(err || ''));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('== 2. 切换重试集成（SPEC-v2 §5.4，mock rpc 驱动 handleChatCompletion，FF4） ==');
  {
    /* 2a quota → 切换账号 → recovery 重建 → 成功 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-sw1-'));
    const gw = makeGateway(tmp);
    gw.poolAdd('acc2');
    gw.pool.accounts.get('acc2').state = 'active'; /* 模拟 acc2 已登录可用（直接置态，避免 markOk 的 requestCount 副作用） */
    const { calls } = makeRpcMock(gw, [
      { ok: false, errorKind: 'quota', error: 'DeepSeek 风控受限（quota）: 服务器繁忙，请稍后再试' },
      { ok: true, result: 'acc2 的正常回答' },
    ]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const asks = calls.filter((c) => c.method === 'streamAsk');
    check('2a1 quota 后发生 2 次 streamAsk', asks.length === 2, 'asks=' + asks.length);
    check('2a2 首次用 default', asks[0].params.profile === 'default');
    check('2a3 切换后用 acc2', asks[1].params.profile === 'acc2');
    check('2a4 FF4 切换后 recovery 重建（含压缩历史标注）', /网页会话中断/.test(asks[1].params.question));
    check('2a5 FF4 recovery 强制 newChat（reset=true）', asks[1].params.reset === true);
    check('2a6 SSE 返回第二账号回答', sseText(res).includes('acc2 的正常回答'));
    check('2a7 default 首次受限保持 active（suspect 不误杀）', gw.pool.accounts.get('default').state === 'active');
    check('2a8 acc2 成功后 requestCount=1', gw.pool.accounts.get('acc2').requestCount === 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2b 全部账号受限 → 报错（中途失败路径） */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-sw2-'));
    const gw = makeGateway(tmp);
    gw.poolAdd('acc2');
    gw.poolMarkOk('acc2');
    const { calls } = makeRpcMock(gw, [
      { ok: false, errorKind: 'quota', error: 'DeepSeek 风控受限（quota）: 服务器繁忙' },
      { ok: false, errorKind: 'quota', error: 'DeepSeek 风控受限（quota）: 服务器繁忙' },
    ]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const asks = calls.filter((c) => c.method === 'streamAsk');
    check('2b1 切换预算内尝试 2 个账号后停止', asks.length === 2);
    check('2b2 SSE 报风控受限错误', sseText(res).includes('风控受限'));
    check('2b3 两个账号均 suspect（首次）', gw.pool.accounts.get('default').state === 'active' && gw.pool.accounts.get('acc2').state === 'active');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2c 登录失效 → 自动登录 → 同账号 recovery 重试成功（§5.5） */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-sw3-'));
    const gw = makeGateway(tmp);
    const { calls } = makeRpcMock(gw, [
      { ok: false, errorKind: 'login', error: 'login required: 页面已关闭或未登录' },
      { ok: true, result: '登录后重试成功' },
    ], { ok: true, loggedIn: true });
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const m = calls.map((c) => c.method);
    check('2c1 顺序：streamAsk → login → streamAsk', m[0] === 'streamAsk' && m[1] === 'login' && m[2] === 'streamAsk', m.join(','));
    check('2c2 登录重试同账号（default）', calls[2].params.profile === 'default');
    check('2c3 登录重试走 recovery', /网页会话中断/.test(calls[2].params.question));
    check('2c4 SSE 返回重试结果', sseText(res).includes('登录后重试成功'));
    check('2c5 账号恢复 active', gw.pool.accounts.get('default').state === 'active');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2d 无可用账号（全 cooling）→ 429 语义提示（含最早探测时间） */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-sw4-'));
    const gw = makeGateway(tmp);
    const a = gw.pool.accounts.get('default');
    a.state = 'cooling';
    a.cooldownUntil = Date.now() + 600000;
    const { calls } = makeRpcMock(gw, []);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const text = sseText(res);
    check('2d1 SSE 返回受限提示', text.includes('账号暂时受限') && text.includes('指数退避'));
    check('2d2 提示含探测时间（不承诺解冻）', text.includes('探测'));
    check('2d3 未发起 streamAsk', calls.filter((c) => c.method === 'streamAsk').length === 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2e captcha → 账号 disabled → 无其他账号 → 报错 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-sw5-'));
    const gw = makeGateway(tmp);
    const { calls } = makeRpcMock(gw, [
      { ok: false, errorKind: 'captcha', error: 'DeepSeek 风控受限（captcha）: 请完成安全验证' },
    ]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    check('2e1 captcha 账号 → disabled（转人工）', gw.pool.accounts.get('default').state === 'disabled');
    check('2e2 SSE 报错（无可用切换）', sseText(res).includes('风控受限'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2h 跨分片工具标记不能先以 content 泄漏；普通 Markdown 仍完整输出一次 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-stream-prefix-'));
    const gw = makeGateway(tmp);
    makeRpcMock(gw, [
      {
        events: [
          { delta: '`' },
          { delta: '``tool_call\n{\"name\":\"write\",\"args\":{\"file_path\":\"a.txt\",\"content\":\"hi\"}}\n```' },
        ],
        ok: true,
        result: '```tool_call\n{\"name\":\"write\",\"args\":{\"file_path\":\"a.txt\",\"content\":\"hi\"}}\n```',
        toolCalls: [{ name: 'write', arguments: { file_path: 'a.txt', content: 'hi' } }],
      },
      {
        events: [{ delta: '`' }, { delta: '``javascript\nconst x = 1;\n```' }],
        ok: true,
        result: '```javascript\nconst x = 1;\n```',
      },
      {
        events: [
          { delta: '<tool_call>\n' },
          { delta: '{\"name\":\"write\",\"args\":{\"file_path\":\"b.txt\",\"content\":\"ok\"}}\n</tool_call>' },
        ],
        ok: true,
        result: '<tool_call>\n{\"name\":\"write\",\"args\":{\"file_path\":\"b.txt\",\"content\":\"ok\"}}\n</tool_call>',
        toolCalls: [{ name: 'write', arguments: { file_path: 'b.txt', content: 'ok' } }],
      },
    ]);
    const toolRes = makeResMock();
    await gw.handleChatCompletion({}, toolRes, PAYLOAD_FIRST);
    const toolText = sseText(toolRes);
    check('2h1 跨分片工具标记仅输出 tool_calls', /\"tool_calls\"/.test(toolText) && !/\"content\":\"`/.test(toolText), toolText);
    const markdownRes = makeResMock();
    await gw.handleChatCompletion({}, markdownRes, PAYLOAD_FIRST);
    const markdownText = sseText(markdownRes);
    const codeOccurrences = (markdownText.match(/const x = 1/g) || []).length;
    check('2h2 普通 Markdown 前缀完整且只输出一次', codeOccurrences === 1 && markdownText.includes('```javascript'), markdownText);
    const xmlRes = makeResMock();
    await gw.handleChatCompletion({}, xmlRes, PAYLOAD_FIRST);
    const xmlText = sseText(xmlRes);
    check('2h3 跨分片 XML 工具标记仅输出 tool_calls', /\"tool_calls\"/.test(xmlText) && !/\"content\":\"<tool_call/.test(xmlText), xmlText);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2g 无效 OpenAI 请求必须在 driver/SSE 前返回 JSON 错误 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-invalid-'));
    const gw = makeGateway(tmp);
    const { calls, getEnsureCount } = makeRpcMock(gw, [{ ok: true, result: '不应生成' }]);
    const unknown = makeResMock();
    await gw.handleChatCompletion({}, unknown, { model: 'not-a-real-model', messages: PAYLOAD_FIRST.messages });
    check('2g1 未知模型返回 404', unknown.statusCode === 404, String(unknown.statusCode));
    check('2g2 未知模型返回 JSON 错误', /\"code\":\"model_not_found\"/.test(sseText(unknown)) && !/data: /.test(sseText(unknown)), sseText(unknown));
    const emptyMessages = makeResMock();
    await gw.handleChatCompletion({}, emptyMessages, { model: 'deepseek-chat', messages: [] });
    check('2g3 空 messages 返回 400', emptyMessages.statusCode === 400, String(emptyMessages.statusCode));
    check('2g4 空 messages 返回 JSON 错误', /\"code\":\"invalid_messages\"/.test(sseText(emptyMessages)) && !/data: /.test(sseText(emptyMessages)), sseText(emptyMessages));
    check('2g5 无效请求不启动 driver 或 streamAsk', getEnsureCount() === 0 && calls.filter((c) => c.method === 'streamAsk').length === 0, 'ensure=' + getEnsureCount() + ' calls=' + JSON.stringify(calls));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* 2f 单账号正常成功路径（零回归：v1 行为） */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-sw6-'));
    const gw = makeGateway(tmp);
    const { calls } = makeRpcMock(gw, [{ ok: true, result: '正常回答' }]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    check('2f1 单次成功调用', calls.filter((c) => c.method === 'streamAsk').length === 1);
    check('2f2 SSE 正常返回', sseText(res).includes('正常回答'));
    check('2f3 账号保持 active', gw.pool.accounts.get('default').state === 'active');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('== 3. driver 限流模式表 detectLimit（动态风控文案，R4/R7） ==');
  {
    const start = DRV_SRC.indexOf('const LIMIT_PATTERNS');
    const end = DRV_SRC.indexOf('function stripThinkingBlocks');
    if (start < 0 || end < 0) throw new Error('LIMIT_PATTERNS section not found');
    const sandbox = { console: { log: () => {} } };
    vm.createContext(sandbox);
    vm.runInContext(DRV_SRC.slice(start, end) + ';globalThis.__dl = detectLimit;', sandbox, { filename: 'driver-limit.js' });
    const dl = sandbox.__dl;
    check('3a 中文繁忙提示 → quota', dl('服务器繁忙，请稍后再试') && dl('服务器繁忙，请稍后再试').kind === 'quota');
    check('3b 中文频繁提示 → quota', dl('发送太频繁') && dl('发送太频繁').kind === 'quota');
    check('3c 英文 rate limit → quota', dl('You have hit the rate limit') && dl('You have hit the rate limit').kind === 'quota');
    check('3d 安全验证 → captcha', dl('请完成安全验证以继续') && dl('请完成安全验证以继续').kind === 'captcha');
    check('3e 正常回答 → null', dl('好的，我已读取文件内容如下：\n```json\n{"a":1}\n```') === null);
    check('3f 空文本 → null', dl('') === null);
    /* 误判防线说明：driver 侧仅对 <400 字符的新回复检测（集成逻辑，单测模式表本身） */
    const longNormal = '关于你提到的 quota 与 rate limit 概念的详细解释：'.repeat(20);
    check('3g 长正常文本含关键词也会命中（证明 <400 长度限制必要）', dl(longNormal) !== null);
  }

  console.log('== 4. 多账号并发退化（P0 单浏览器：effectiveConcurrent） ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-conc-'));
    const gw = makeGateway(tmp);
    check('4a 单账号保持 v1 并发', gw.effectiveConcurrent() === gw.state.maxConcurrent);
    gw.poolAdd('acc2');
    gw.poolMarkOk('acc2');
    check('4b 多账号退化为 1（P0 单浏览器切换需重启）', gw.effectiveConcurrent() === 1);
    gw.state.accountPool = false;
    check('4c 旁路模式恢复 v1 并发', gw.effectiveConcurrent() === gw.state.maxConcurrent);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
