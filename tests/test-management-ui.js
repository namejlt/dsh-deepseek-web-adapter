/* 单元测试：插件管理页 /setup 聚合与卡片化 HTML
 * 运行：node tests/test-management-ui.js （纯离线：vm 沙箱，不启动真实网关/浏览器） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const GW_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

function makeGateway(tmpBase) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const fakeResources = path.join(tmpBase, 'res');
  fs.mkdirSync(fakeResources, { recursive: true });
  const cut = GW_SRC.indexOf('server.listen(');
  if (cut < 0) throw new Error('server.listen not found');
  const code = GW_SRC.slice(0, cut) + `
;globalThis.__x = {
  pool, state, poolAdd, poolMarkOk, poolMarkQuota,
  providerSnippet, credentialsSnippet, buildAccountsPayload,
  buildHealthPayload, buildProvidersPayload, buildSetupPayload, renderManagementPage,
  healthSummary, gatewayBaseURL, gatewayApiBaseURL,
};`;
  const sandbox = {
    require: (m) => {
      if (m === './provider-registry') return require(path.join(ROOT, 'resources', 'provider-registry'));
      if (!['fs', 'path', 'http', 'crypto', 'child_process'].includes(m)) throw new Error('not allowed: ' + m);
      return require(m);
    },
    process: { argv: ['node', 'gw', '--base', tmpBase], env: {}, on: () => {}, exit: () => {}, platform: process.platform },
    __dirname: fakeResources,
    __filename: path.join(fakeResources, 'dsweb-gateway.js'),
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dsweb-gateway.js' });
  return Object.assign(Object.create(null), sandbox.__x, { __sandbox: sandbox });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-ui-'));
  const gw = makeGateway(tmp);

  check('1a providerSnippet 含 dsweb provider 名称', /dsweb:/.test(gw.providerSnippet()));
  check('1b providerSnippet 含 8 个模型中的 deepseek-think-search', /deepseek-think-search/.test(gw.providerSnippet()));
  check('1c providerSnippet 指向本地 /v1/', /http:\/\/127\.0\.0\.1:5688\/v1\//.test(gw.providerSnippet()), gw.providerSnippet());
  check('1d credentialsSnippet 为 MOCK_LLM_KEY', gw.credentialsSnippet() === 'MOCK_LLM_KEY: sk-mock-any-value');

  gw.poolAdd('acc2');
  gw.pool.accounts.get('acc2').state = 'cooling';
  gw.pool.accounts.get('acc2').cooldownUntil = Date.now() + 120000;
  gw.poolAdd('acc3');
  gw.pool.accounts.get('acc3').state = 'needs_login';

  const accountsPayload = gw.buildAccountsPayload();
  check('2a accounts payload 含 summary', !!accountsPayload.summary && accountsPayload.summary.cooling === 1 && accountsPayload.summary.needsLogin === 1, JSON.stringify(accountsPayload.summary));
  const cooling = accountsPayload.accounts.find((a) => a.name === 'acc2');
  const needsLogin = accountsPayload.accounts.find((a) => a.name === 'acc3');
  check('2b cooling 账号带 cooldownRemainText', !!(cooling && cooling.cooldownRemainText), JSON.stringify(cooling));
  check('2c needs_login 账号带 actionHint', needsLogin && /重新登录/.test(needsLogin.actionHint || ''), JSON.stringify(needsLogin));

  gw.__sandbox.rpc = async (method, params) => {
    if (method !== 'inspect') return {};
    if (params && params.providerId === 'chatgpt') return { login: { needsLogin: true, challenge: true, hasChatInput: false } };
    return { login: { needsLogin: false, hasChatInput: true } };
  };
  const providers = await gw.buildProvidersPayload();
  check('3a provider 聚合包含 DeepSeek、ChatGPT、Qwen', providers.providers.map((provider) => provider.id).join(',') === 'deepseek,chatgpt,qwen', JSON.stringify(providers));
  const chatgpt = providers.providers.find((provider) => provider.id === 'chatgpt');
  check('3b ChatGPT challenge 优先显示人工操作状态', chatgpt && chatgpt.status === 'challenge' && chatgpt.action.kind === 'challenge' && chatgpt.defaultProfile === 'chatgpt-default' && chatgpt.models.length === 2, JSON.stringify(chatgpt));
  const qwen = providers.providers.find((provider) => provider.id === 'qwen');
  check('3c Qwen 聚合含独立默认 profile 与六个模型', qwen && qwen.defaultProfile === 'qwen-default' && qwen.models.length === 6, JSON.stringify(qwen));

  const health = await gw.buildHealthPayload();
  check('3d health payload 含 summary', health.summary && health.summary.gateway === 'down' && health.summary.login === 'logged_in', JSON.stringify(health.summary));
  check('3e health config 含 quotaBackoff 字段', 'quotaBackoffBaseMs' in health.config && 'quotaBackoffMaxMs' in health.config, JSON.stringify(health.config));

  const setup = gw.buildSetupPayload(health, accountsPayload, providers);
  check('4a setup quickLinks 指向 /login', setup.setup.quickLinks && setup.setup.quickLinks.login === '/login');
  check('4b setup 保留 provider 聚合', setup.providers && setup.providers.providers.length === 3, JSON.stringify(setup.providers));
  check('4c setup cards.accounts 汇总账号数', setup.cards.accounts.total === 3 && setup.cards.accounts.cooling === 1 && setup.cards.accounts.needsLogin === 1, JSON.stringify(setup.cards.accounts));

  const html = gw.renderManagementPage(setup);
  check('5a 管理页标题升级为 Provider 指挥台', /Web Provider Console/.test(html));
  check('5b 管理页包含三个 provider 状态卡容器', /providerCards/.test(html) && /DeepSeek/.test(html) && /ChatGPT/.test(html) && /Qwen/.test(html));
  check('5c 管理页包含选中 provider 详情与操作队列', /providerDetail/.test(html) && /actionQueue/.test(html));
  check('5d 管理页 provider 登录链接携带 provider 参数', /login\?provider=/.test(html));
  check('5e 管理页账号操作会传 provider', /provider:\s*selectedProviderId/.test(html));
  check("5f 管理页包含 fetch('/setup') 刷新逻辑", /api\('\/setup'\)/.test(html), html.slice(html.indexOf('Promise.all'), html.indexOf('refreshAll')));
  check('5g 管理页包含 /accounts\/add 动作', /\/accounts\/add/.test(html));
  check('5h 管理页保留全局配置与诊断入口', /全局配置/.test(html) && /\/debug/.test(html));
  check('5i 长运行快照不会挤压全局配置列', /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(html) && /white-space:pre-wrap/.test(html), html.slice(html.indexOf('.bottom-grid'), html.indexOf('</style>')));
  check('5j 点击 provider 卡片内部元素也会切换详情', /closest\('\[data-select-provider\]'\)/.test(html) && /closest\('\[data-provider-action\]'\)/.test(html), html.slice(html.indexOf("document.addEventListener('click'"), html.indexOf('renderAll();')));
  check('5k Provider 卡片为底部操作保留空间', /\.provider-card\{[^}]*padding-bottom:58px/.test(html), html.slice(html.indexOf('.provider-card{'), html.indexOf('.provider-head')));
  check('5l Gateway ready 状态显示为在线而非等待 driver', /summary\.gateway === 'ready'/.test(html), html.slice(html.indexOf('function renderTop'), html.indexOf('function renderProviderCards')));
  check('5m 管理页声明空 favicon 避免 404 控制台噪音', /<link rel="icon" href="data:,">/.test(html));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n== SUMMARY ==');
  console.log('pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});