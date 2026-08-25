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
  buildHealthPayload, buildSetupPayload, renderManagementPage,
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

  gw.__sandbox.rpc = async () => ({ login: { needsLogin: false } });
  const health = await gw.buildHealthPayload();
  check('3a health payload 含 summary', health.summary && health.summary.gateway === 'down' && health.summary.login === 'logged_in', JSON.stringify(health.summary));
  check('3b health config 含 quotaBackoff 字段', 'quotaBackoffBaseMs' in health.config && 'quotaBackoffMaxMs' in health.config, JSON.stringify(health.config));

  const setup = gw.buildSetupPayload(health, accountsPayload);
  check('4a setup quickLinks 指向 /login', setup.setup.quickLinks && setup.setup.quickLinks.login === '/login');
  check('4b setup checklist 含登录项且已完成', setup.setup.checklist.some((x) => x.key === 'login' && x.done === true), JSON.stringify(setup.setup.checklist));
  check('4c setup cards.accounts 汇总账号数', setup.cards.accounts.total === 3 && setup.cards.accounts.cooling === 1 && setup.cards.accounts.needsLogin === 1, JSON.stringify(setup.cards.accounts));

  const html = gw.renderManagementPage(setup);
  check('5a 管理页标题存在', /DeepSeek 网页版插件管理/.test(html));
  check('5b 管理页包含快速登录卡片', /快速登录/.test(html));
  check('5c 管理页包含账户检查与管理卡片', /账户检查与管理/.test(html));
  check('5d 管理页包含运行配置卡片', /运行配置/.test(html));
  check('5e 管理页包含默认账号登录入口', /href="\/login"/.test(html));
  check("5f 管理页包含 fetch('/setup') 刷新逻辑", /api\('\/setup'\)/.test(html), html.slice(html.indexOf('Promise.all'), html.indexOf('renderSetup')));
  check('5g 管理页包含 /accounts\/add 动作', /\/accounts\/add/.test(html));
  check('5h 管理页保留未来 DSH 卡片复用说明', /未来接入 DSH 原生设置卡片/.test(html));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n== SUMMARY ==');
  console.log('pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
