/* 单元测试：实现完备性审查修复（5 项逻辑缺口的回归防线）
 * 覆盖：
 *   A. SSE 流悬挂修复：SSE 已开始后异常 → catch 不再二次 writeHead（ERR_HTTP_HEADERS_SENT
 *      被内层 catch 吞掉导致 [DONE] 永不发出、客户端连接悬挂）→ headersSent 守卫
 *   B. askOnce 兜底超时：driver 卡死（进程 hang 不退）时 consumer.next() 永久挂起
 *      → 会话锁/信号量永久占用 → 20min 兜底超时强制报错
 *   C. epoch 失配强制 recovery：请求异常/失败/无可用账号 → session.epoch=-1，
 *      防下一请求 delta 增量发进不存在的网页历史（文不对题）
 *   D. buildToolsText 渐进降级：全量(110) → 短描述(30) → 仅名字(0)，
 *      总长受 BUDGET 硬上限（旧实现 body 无上限，30+ 工具时轻松破万 → 发送失败）
 *   E. driver length 信号走迁移+摘要（SPEC-v2 §5.3 偏差修复）：
 *      旧实现检测到 length 后忽略，"对话过长"文案被当正常回复发给 DSH
 *   F. 协议异常显式报错：delta 轮末尾无新输入（assistant 结尾）→ ok:false
 *      'nothing to send'（旧实现静默返回空回复 + 误标账号成功）
 *   G. 非流式异常路径：stream=false + rpc 抛错 → JSON 错误响应
 * 运行：node tests/test-completeness.js （纯离线：vm 沙箱 + mock rpc/res） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GW_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'dsweb-gateway.js'), 'utf8');
const DRV_SRC = fs.readFileSync(path.join(ROOT, 'resources', 'driver.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

/* ---------- 沙箱加载网关（截断到 server.listen 前，导出内部绑定） ---------- */
function makeGateway(tmpBase) {
  const cut = GW_SRC.indexOf('server.listen(');
  if (cut < 0) throw new Error('server.listen not found');
  const code = GW_SRC.slice(0, cut) + `
;globalThis.__x = { handleChatCompletion, buildToolsText, buildHealthPayload, sessions, state, pool, poolAdd, poolMarkOk, poolMarkQuota };`;
  const sandbox = {
    require: (m) => {
      if (!['fs', 'path', 'http', 'crypto', 'child_process'].includes(m)) throw new Error('not allowed: ' + m);
      return require(m);
    },
    process: { argv: ['node', 'gw', '--base', tmpBase], env: {}, on: () => {}, exit: () => {}, platform: process.platform },
    __dirname: tmpBase,
    __filename: path.join(tmpBase, 'dsweb-gateway.js'),
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, setInterval, clearTimeout, clearInterval, Date, Promise, Map, Set, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dsweb-gateway.js' });
  return Object.assign(Object.create(null), sandbox.__x, { __sandbox: sandbox });
}

/* ---------- mock res：模拟真实 Node 的 headersSent 行为（二次 writeHead 抛错） ---------- */
function makeResMock() {
  return {
    headersSent: false, writeHeadCount: 0, statusCode: null,
    setHeader() {},
    writeHead(code) {
      if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT (mock: headers already sent)');
      this.headersSent = true;
      this.writeHeadCount++;
      this.statusCode = code;
    },
    chunks: [], write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; },
  };
}
function sseText(res) { return res.chunks.join(''); }
function parseSseEvents(res) {
  return res.chunks.join('').split('\n\n').map((s) => s.trim()).filter(Boolean).map((frame) => {
    const body = frame.replace(/^data:\s*/, '');
    if (body === '[DONE]') return { done: true };
    try { return { json: JSON.parse(body) }; } catch (e) { return { raw: body }; }
  });
}

/* ---------- mock rpc：script = 每次 streamAsk 的 stream-end 结果序列；
 * rpcThrow = 让 rpc 直接 reject（模拟 streamAsk RPC 超时/driver 崩溃） ---------- */
function makeRpcMock(gw, script, rpcThrow) {
  const calls = [];
  let seq = 0;
  const d = { consumers: new Map() };
  const sb = gw.__sandbox;
  sb.ensureDriver = async () => d;
  sb.rpc = async (method, params) => {
    calls.push({ method, params });
    if (rpcThrow && method === 'streamAsk') throw new Error(rpcThrow);
    if (method === 'streamAsk') {
      const streamId = 's' + (++seq);
      setTimeout(() => {
        const c = d.consumers.get(streamId);
        if (!c) return;
        const resp = script.length ? script.shift() : { ok: true, result: '' };
        c.end(resp);
      }, 5);
      return { streamId };
    }
    return { ok: true };
  };
  return { calls, d };
}

/* ---------- 公共 payload ---------- */
const PAYLOAD_FIRST = {
  model: 'deepseek-chat', stream: true,
  messages: [
    { role: 'system', content: '你是测试助手' },
    { role: 'user', content: 'Current runtime context:\n- cwd: /tmp\n- DSH file policy: full auto\n- Approval policy: auto' },
    { role: 'user', content: '读一下文件' },
  ],
};
/* 与 FIRST 同指纹（同 system + 首条非 ctx user），末尾 assistant → delta 轮 q 为空 */
const PAYLOAD_DELTA_ASSISTANT_TAIL = {
  model: 'deepseek-chat', stream: true,
  messages: [
    { role: 'system', content: '你是测试助手' },
    { role: 'user', content: 'Current runtime context:\n- cwd: /tmp\n- DSH file policy: full auto\n- Approval policy: auto' },
    { role: 'user', content: '读一下文件' },
    { role: 'assistant', content: '上一轮的回复' },
  ],
};

(async () => {
  /* ========== A. SSE 流悬挂修复（headersSent 守卫） ========== */
  console.log('== A. SSE 流悬挂修复（headersSent 守卫） ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-a-'));
    const gw = makeGateway(tmp);
    /* rpc streamAsk 直接抛错（模拟 30s RPC 超时），此时 SSE 头已发出（askOnce 在 sseHeaders 之后） */
    makeRpcMock(gw, [], 'rpc timeout: streamAsk');
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const text = sseText(res);
    check('A1 SSE 已开始后异常 → 仍发出 [DONE]（不悬挂）', text.includes('data: [DONE]'), JSON.stringify(text.slice(-80)));
    check('A2 SSE 含 [错误] 文本', text.includes('[错误]') && text.includes('rpc timeout'), text.slice(0, 120));
    check('A3 writeHead 恰好 1 次（catch 不再补发 SSE 头）', res.writeHeadCount === 1, 'count=' + res.writeHeadCount);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== C. epoch 失配强制 recovery ========== */
  console.log('== C. epoch 失配强制 recovery ==');
  {
    /* C1 rpc 异常 → epoch=-1 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-c1-'));
    const gw = makeGateway(tmp);
    makeRpcMock(gw, [], 'rpc timeout: streamAsk');
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const s = [...gw.sessions.values()][0];
    check('C1 rpc 异常 → session.epoch=-1（下轮强制 recovery）', s && s.epoch === -1, 'epoch=' + (s && s.epoch));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* C2 普通失败（ok:false 无 errorKind，如 timeout）→ epoch=-1 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-c2-'));
    const gw = makeGateway(tmp);
    makeRpcMock(gw, [{ ok: false, error: 'timeout: 等待 240s 未见新回复' }]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const s = [...gw.sessions.values()][0];
    check('C2 普通失败 → epoch=-1', s && s.epoch === -1, 'epoch=' + (s && s.epoch));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* C3 无可用账号（全 cooling）→ epoch=-1（通道页面从未建立） */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-c3-'));
    const gw = makeGateway(tmp);
    const a = gw.pool.accounts.get('default');
    a.state = 'cooling'; a.cooldownUntil = Date.now() + 600000;
    const { calls } = makeRpcMock(gw, []);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const s = [...gw.sessions.values()][0];
    check('C3 无可用账号 → epoch=-1', s && s.epoch === -1, 'epoch=' + (s && s.epoch));
    check('C3b 未发起 streamAsk', calls.filter((c) => c.method === 'streamAsk').length === 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    /* C4 成功请求 → epoch 保持（不为 -1），且会话锁已释放（busy=false） */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-c4-'));
    const gw = makeGateway(tmp);
    makeRpcMock(gw, [{ ok: true, result: '正常回答' }]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const s = [...gw.sessions.values()][0];
    check('C4 成功请求 → epoch 保持（delta 语义有效）', s && s.epoch !== -1 && s.epoch === 0, 'epoch=' + (s && s.epoch));
    check('C4b 会话锁释放（busy=false）', s && s.busy === false);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== F. 协议异常显式报错（delta 轮末尾无新输入） ========== */
  console.log('== F. 协议异常显式报错 ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-f-'));
    const gw = makeGateway(tmp);
    const { calls } = makeRpcMock(gw, [
      { ok: true, result: '首轮回答' },
      { ok: true, result: '不应到达' },
    ]);
    /* 第一轮：first 模式正常；第二轮：同指纹 → delta，末尾 assistant → q 为空。
     * 注：单独发 assistant 结尾的请求（无已有会话）走 recovery 重建是正确行为，
     * q 为空的协议异常只在"已有会话的 delta 轮"发生，故须两连发构造。 */
    const res1 = makeResMock();
    await gw.handleChatCompletion({}, res1, PAYLOAD_FIRST);
    check('F0 首轮 first 模式正常（reset=true）', calls.filter((c) => c.method === 'streamAsk').length === 1 && calls[0].params.reset === true);
    const res2 = makeResMock();
    await gw.handleChatCompletion({}, res2, PAYLOAD_DELTA_ASSISTANT_TAIL);
    const asks = calls.filter((c) => c.method === 'streamAsk');
    const text2 = sseText(res2);
    const s = [...gw.sessions.values()][0];
    check('F1 第二请求被识别为同会话 delta（无新 streamAsk）', asks.length === 1, 'asks=' + asks.length);
    check('F2 SSE 含 nothing to send 显式报错（含 [DONE]）', text2.includes('nothing to send') && text2.includes('[DONE]'), text2.slice(0, 150));
    check('F3 协议异常 → epoch=-1（下轮 recovery）', s && s.epoch === -1, 'epoch=' + (s && s.epoch));
    check('F4 账号统计不被污染（仅首轮计入 requestCount=1）', gw.pool.accounts.get('default').requestCount === 1, 'count=' + gw.pool.accounts.get('default').requestCount);
    check('F5 会话数不变（同会话复用，未新建）', gw.sessions.size === 1, 'size=' + gw.sessions.size);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-f2-'));
    const gw = makeGateway(tmp);
    const { calls } = makeRpcMock(gw, [
      { ok: true, result: '```tool_call\n{"name":"web_search","args":{"queries":["上海天气 2026-08-22"]}}\n```', toolCalls: [{ name: 'web_search', arguments: '{"query":"上海天气 2026-08-22"}' }] },
      { ok: true, result: '上海明天天气晴。' },
    ]);
    const res1 = makeResMock();
    await gw.handleChatCompletion({}, res1, PAYLOAD_FIRST);
    const res2 = makeResMock();
    await gw.handleChatCompletion({}, res2, {
      model: 'deepseek-chat', stream: true,
      messages: [
        { role: 'system', content: '你是测试助手' },
        { role: 'user', content: 'Current runtime context:\n- cwd: /tmp\n- DSH file policy: full auto\n- Approval policy: auto' },
        { role: 'user', content: '读一下文件' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"上海天气 2026-08-22"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '晴，28C' },
      ],
    });
    const asks = calls.filter((c) => c.method === 'streamAsk');
    check('F6 工具循环第二轮仍命中同会话 delta（reset=auto）', asks.length === 2 && asks[1].params.reset === 'auto', JSON.stringify(asks.map((a) => a.params.reset)));
    check('F7 工具循环第二轮不走 recovery 压缩历史', asks.length === 2 && !/网页会话中断/.test(asks[1].params.question || ''), asks[1] && asks[1].params && asks[1].params.question);
    check('F8 工具循环第二轮增量为 tool 结果，不重复首轮上下文', asks.length === 2 && /^\[工具结果\]\n晴，28C/.test(asks[1].params.question || ''), asks[1] && asks[1].params && asks[1].params.question);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-f3-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    let askSeq = 0;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-f3-' + (++askSeq);
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          if (askSeq === 1) {
            c.end({ ok: true, result: '```tool_call\n{"name":"web_search","args":{"queries":["上海天气 2026-08-22"]}}\n```', toolCalls: [{ name: 'web_search', arguments: '{"query":"上海天气 2026-08-22"}' }] });
          } else {
            c.push('上海');
            c.push('明天天气晴。');
            c.end({ ok: true, result: '上海明天天气晴。' });
          }
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const res1 = makeResMock();
    await gw.handleChatCompletion({}, res1, PAYLOAD_FIRST);
    const res2 = makeResMock();
    await gw.handleChatCompletion({}, res2, {
      model: 'deepseek-chat', stream: true,
      messages: [
        { role: 'system', content: '你是测试助手' },
        { role: 'user', content: 'Current runtime context:\n- cwd: /tmp\n- DSH file policy: full auto\n- Approval policy: auto' },
        { role: 'user', content: '读一下文件' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"上海天气 2026-08-22"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '晴，28C' },
      ],
    });
    const ev2 = parseSseEvents(res2);
    const content2 = ev2.filter((e) => e.json && e.json.choices[0].delta.content).map((e) => e.json.choices[0].delta.content).join('');
    const finish2 = ev2.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('F9 工具循环最终正文顺序输出完整', content2 === '上海明天天气晴。', JSON.stringify(ev2));
    check('F10 工具循环最终正文以 stop 收尾', finish2.length === 1 && finish2[0] === 'stop', JSON.stringify(finish2));
    check('F11 工具循环最终正文发送 [DONE] 且连接结束', ev2.filter((e) => e.done).length === 1 && ev2[ev2.length - 1].done === true && res2.ended === true, JSON.stringify(ev2.slice(-3)) + ' ended=' + res2.ended);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== G. 非流式异常路径 ========== */
  console.log('== G. 非流式异常路径 ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-g-'));
    const gw = makeGateway(tmp);
    makeRpcMock(gw, [], 'rpc timeout: streamAsk');
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, Object.assign({}, PAYLOAD_FIRST, { stream: false }));
    const text = sseText(res);
    let obj = null; try { obj = JSON.parse(text); } catch (e) { /* ignore */ }
    check('G1 非流式 + rpc 异常 → 502 + OpenAI error JSON', res.statusCode === 502 && obj && obj.error && obj.error.type === 'api_error' && String(obj.error.message).includes('rpc timeout'), text);
    check('G2 非流式不发送 SSE 头（writeHead 恰 1 次且无 [DONE]）', res.writeHeadCount === 1 && !text.includes('[DONE]'));
    check('G3 非流式异常不再伪装成 assistant content', !(obj && obj.choices), text);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-g2-'));
    const gw = makeGateway(tmp);
    const a = gw.pool.accounts.get('default');
    a.state = 'cooling'; a.cooldownUntil = Date.now() + 600000;
    makeRpcMock(gw, []);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, Object.assign({}, PAYLOAD_FIRST, { stream: false }));
    const text = sseText(res);
    let obj = null; try { obj = JSON.parse(text); } catch (e) { /* ignore */ }
    check('G4 无可用账号且都在 cooling → 429 rate_limit_error', res.statusCode === 429 && obj && obj.error && obj.error.type === 'rate_limit_error' && obj.error.code === 'all_accounts_cooling', text);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-g3-'));
    const gw = makeGateway(tmp);
    const a = gw.pool.accounts.get('default');
    a.state = 'needs_login';
    makeRpcMock(gw, []);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, Object.assign({}, PAYLOAD_FIRST, { stream: false }));
    const text = sseText(res);
    let obj = null; try { obj = JSON.parse(text); } catch (e) { /* ignore */ }
    check('G5 无可用账号且需登录 → 401 authentication_error', res.statusCode === 401 && obj && obj.error && obj.error.type === 'authentication_error' && obj.error.code === 'no_available_account', text);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== S. 真实 SSE 顺序契约 ========== */
  console.log('== S. 真实 SSE 顺序契约 ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-s1-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-seq-1';
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          c.push('思考A', 'thinking');
          c.push('思考B', 'thinking');
          c.push('你好');
          c.push('，世界');
          c.end({ ok: true, result: '你好，世界' });
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const ev = parseSseEvents(res);
    const role = ev[0] && ev[0].json && ev[0].json.choices[0].delta.role;
    const reasoning = ev.filter((e) => e.json && e.json.choices[0].delta.reasoning_content).map((e) => e.json.choices[0].delta.reasoning_content).join('');
    const reasoningMirror = ev.filter((e) => e.json && e.json.choices[0].delta.reasoning).map((e) => e.json.choices[0].delta.reasoning).join('');
    const content = ev.filter((e) => e.json && e.json.choices[0].delta.content).map((e) => e.json.choices[0].delta.content).join('');
    const finish = ev.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('S1 首个 SSE chunk 为 assistant role', role === 'assistant', JSON.stringify(ev[0]));
    check('S2 reasoning_content 已屏蔽，不再输出思考流', reasoning === '', JSON.stringify(ev));
    check('S3 reasoning 镜像字段已屏蔽', reasoningMirror === '', JSON.stringify(ev));
    check('S4 content 顺序输出完整', content === '你好，世界', JSON.stringify(ev));
    check('S5 finish_reason=stop 且只出现一次', finish.length === 1 && finish[0] === 'stop', JSON.stringify(finish));
    check('S6 [DONE] 最后且只出现一次', ev.filter((e) => e.done).length === 1 && ev[ev.length - 1].done === true, JSON.stringify(ev.slice(-2)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-s2-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-seq-2';
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          c.push('思考中', 'thinking');
          c.push('```tool_call\n{"name":"read_file"');
          c.push(',"arguments":{"path":"/tmp/a.txt"}}\n```');
          c.end({ ok: true, result: '```tool_call\n{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}\n```', toolCalls: [{ name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' }] });
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const ev = parseSseEvents(res);
    const content = ev.filter((e) => e.json && e.json.choices[0].delta.content).map((e) => e.json.choices[0].delta.content).join('');
    const reasoning = ev.filter((e) => e.json && e.json.choices[0].delta.reasoning_content).map((e) => e.json.choices[0].delta.reasoning_content).join('');
    const toolHeaders = ev.filter((e) => e.json && e.json.choices[0].delta.tool_calls && e.json.choices[0].delta.tool_calls[0].id).length;
    const toolArgChunks = ev.filter((e) => e.json && e.json.choices[0].delta.tool_calls && e.json.choices[0].delta.tool_calls[0].function && typeof e.json.choices[0].delta.tool_calls[0].function.arguments === 'string' && !e.json.choices[0].delta.tool_calls[0].id).length;
    const finish = ev.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('S7 thinking 后接 tool_calls 时 reasoning 仍屏蔽', reasoning === '', JSON.stringify(ev));
    check('S8 工具 JSON 不泄漏到 content', content === '', JSON.stringify(ev));
    check('S9 tool_calls header 和 arguments chunk 都发出', toolHeaders === 1 && toolArgChunks >= 1, JSON.stringify(ev));
    check('S10 finish_reason=tool_calls 且 [DONE] 收尾', finish.length === 1 && finish[0] === 'tool_calls' && ev[ev.length - 1].done === true, JSON.stringify(ev.slice(-3)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-s3-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-seq-3';
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          c.push('长思考片段A', 'thinking');
          c.push('长思考片段B', 'thinking');
          c.push('处世让一步为高。');
          c.end({ ok: true, result: '处世让一步为高。' });
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const ev = parseSseEvents(res);
    const reasoning = ev.filter((e) => e.json && e.json.choices[0].delta.reasoning_content).map((e) => e.json.choices[0].delta.reasoning_content).join('');
    const content = ev.filter((e) => e.json && e.json.choices[0].delta.content).map((e) => e.json.choices[0].delta.content).join('');
    const finish = ev.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('S11 think 模式短最终正文正常进入 content', content === '处世让一步为高。', JSON.stringify(ev));
    check('S12 think 内容不泄漏进最终 content', content.indexOf('长思考片段') < 0, content);
    check('S13 reasoning 屏蔽后仅 content 存在且 stop 收尾', reasoning === '' && finish.length === 1 && finish[0] === 'stop' && ev[ev.length - 1].done === true, JSON.stringify(ev.slice(-3)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-s4-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-seq-4';
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          c.push('长思考内容一', 'thinking');
          c.push('长思考内容二', 'thinking');
          c.push('正文第一段');
          c.push('，正文第二段');
          c.end({ ok: true, result: '正文第一段，正文第二段' });
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST);
    const ev = parseSseEvents(res);
    const content = ev.filter((e) => e.json && e.json.choices[0].delta.content).map((e) => e.json.choices[0].delta.content).join('');
    const finish = ev.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('S14 think 面板残留场景下正文完整输出', content === '正文第一段，正文第二段', JSON.stringify(ev));
    check('S15 think 面板残留场景下请求正常 stop 结束，不阻塞', finish.length === 1 && finish[0] === 'stop' && ev[ev.length - 1].done === true, JSON.stringify(ev.slice(-3)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    check('S16 driver 工具安全网：looksLikeToolCall 现在接收 tools 上下文', /function looksLikeToolCall\(text, tools\)/.test(DRV_SRC));
    check('S17 driver 工具安全网：解析失败但 toolIntent 仍命中时不会直接 stop', /const toolIntent = looksLikeToolCall\(finalText, params\.tools\);/.test(DRV_SRC) && /if \(toolCalls\.length \|\| !toolIntent\) break;/.test(DRV_SRC), 'driver retry guard missing');
  }

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-s6-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-seq-6';
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          c.end({ ok: true, result: '```tool_call\n{"name":"web_search","args":{"queries":["上海天气 今天 实时"]}}\n```', toolCalls: [{ name: 'web_search', arguments: '{"query":"上海天气 今天 实时"}' }] });
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const payload = Object.assign({}, PAYLOAD_FIRST, {
      tools: [{ type: 'function', function: { name: 'web_search', parameters: { properties: { query: {} } } } }],
    });
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, payload);
    const ev = parseSseEvents(res);
    const toolChunks = ev.filter((e) => e.json && e.json.choices[0].delta.tool_calls);
    const argText = toolChunks.map((e) => {
      const tc = e.json.choices[0].delta.tool_calls[0];
      return (tc.function && tc.function.arguments) || '';
    }).join('');
    const finish = ev.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('S18 web_search 工具调用最终走 tool_calls', finish.length === 1 && finish[0] === 'tool_calls', JSON.stringify(ev));
    check('S19 web_search 参数在 gateway 输出中为规范化后的 query', argText.includes('"query":"上海天气 今天 实时"') && !argText.includes('queries'), argText);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-s7-'));
    const gw = makeGateway(tmp);
    const { d } = makeRpcMock(gw, []);
    const sb = gw.__sandbox;
    sb.rpc = async (method, params) => {
      if (method === 'streamAsk') {
        const streamId = 's-seq-7';
        setTimeout(() => {
          const c = d.consumers.get(streamId);
          if (!c) return;
          c.end({ ok: true, result: '<tool_calls>\n<invoke name="web_search">\n<parameter name="queries">["上海 近三天 天气预报 2026-08-22"]</parameter>\n</invoke>\n</tool_calls>', toolCalls: [{ name: 'web_search', arguments: '{"query":"上海 近三天 天气预报 2026-08-22"}' }] });
        }, 5);
        return { streamId };
      }
      return { ok: true };
    };
    const payload = Object.assign({}, PAYLOAD_FIRST, {
      tools: [{ type: 'function', function: { name: 'web_search', parameters: { properties: { query: {} } } } }],
    });
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, payload);
    const ev = parseSseEvents(res);
    const toolChunks = ev.filter((e) => e.json && e.json.choices[0].delta.tool_calls);
    const argText = toolChunks.map((e) => {
      const tc = e.json.choices[0].delta.tool_calls[0];
      return (tc.function && tc.function.arguments) || '';
    }).join('');
    const finish = ev.filter((e) => e.json && e.json.choices[0].finish_reason).map((e) => e.json.choices[0].finish_reason);
    check('S20 XML tool_calls 最终走 tool_calls 而不是 stop', finish.length === 1 && finish[0] === 'tool_calls', JSON.stringify(ev));
    check('S21 XML tool_calls 参数在 gateway 输出中为规范化后的 query', argText.includes('"query":"上海 近三天 天气预报 2026-08-22"') && !argText.includes('queries'), argText);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== J. health/debug 暴露最近一次完成快照 ========== */
  console.log('== J. health/debug 完成快照 ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-j-'));
    const gw = makeGateway(tmp);
    const sb = gw.__sandbox;
    sb.rpc = async (method) => {
      if (method === 'inspect') {
        return {
          login: { needsLogin: false, hasChatInput: true, url: 'https://chat.deepseek.com/' },
          lastStreamSummary: {
            finishBy: 'doneSignal',
            thinkStalled: true,
            genSeen: true,
            thinking: true,
            searching: false,
            resultLen: 24,
          },
        };
      }
      return { ok: true };
    };
    const health = await gw.buildHealthPayload();
    check('J1 health.driver.lastStreamSummary 暴露最近一次完成快照', !!(health.driver && health.driver.lastStreamSummary && health.driver.lastStreamSummary.finishBy === 'doneSignal' && health.driver.lastStreamSummary.thinkStalled === true), JSON.stringify(health.driver));
    check('J1b health.driver.lastStream 生成可读摘要与细节', !!(health.driver && health.driver.lastStream && typeof health.driver.lastStream.text === 'string' && health.driver.lastStream.text.includes('检测到完成信号') && typeof health.driver.lastStream.detail === 'string' && health.driver.lastStream.detail.includes('finishBy=doneSignal')), JSON.stringify(health.driver && health.driver.lastStream));
    check('J1c 健康摘要为正常完成生成 ok/warn/bad kind', health.driver.lastStream && health.driver.lastStream.kind === 'warn', JSON.stringify(health.driver && health.driver.lastStream));
    check('J2 health 继续复用 inspect.login 作为登录态', health.login && health.login.needsLogin === false && health.summary && health.summary.login === 'logged_in', JSON.stringify(health.login));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-j2-'));
    const gw = makeGateway(tmp);
    const sb = gw.__sandbox;
    sb.rpc = async (method) => {
      if (method === 'inspect') {
        return {
          login: { needsLogin: false, hasChatInput: true, url: 'https://chat.deepseek.com/' },
          lastStreamSummary: {
            finishBy: 'timeoutNoFirstSeen',
            ok: false,
            error: 'timeout: 等待 240s 未见新回复',
            genSeen: false,
            thinking: false,
            searching: false,
            resultLen: 0,
          },
        };
      }
      return { ok: true };
    };
    const health = await gw.buildHealthPayload();
    check('J3 最近失败摘要会标记 bad 并生成人类可读文本', !!(health.driver && health.driver.lastStream && health.driver.lastStream.kind === 'bad' && health.driver.lastStream.text.includes('超时且未见首段输出')), JSON.stringify(health.driver && health.driver.lastStream));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== D. buildToolsText 渐进降级（总长硬上限） ========== */
  console.log('== D. buildToolsText 渐进降级 ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-d-'));
    const gw = makeGateway(tmp);
    /* 60 个工具 × 200 字符描述：旧实现 body ≈ 60×(110+参数行) 不可控；
     * 渐进降级后总长必须受 BUDGET 约束，且工具名一个不丢 */
    const manyTools = [];
    for (let i = 1; i <= 60; i++) {
      manyTools.push({
        type: 'function',
        function: {
          name: 'tool_' + String(i).padStart(2, '0'),
          description: '这是一个用于测试超长工具列表的工具编号' + i + '。' + '功能描述填充文本。'.repeat(30),
          parameters: { type: 'object', properties: { path: { type: 'string', description: '目标路径' }, mode: { type: 'string', enum: ['fast', 'slow'] } }, required: ['path'] },
        },
      });
    }
    const out = gw.buildToolsText(manyTools);
    check('D1 60 工具超长描述 → 总长受硬上限约束（≤5600）', out.length <= 5600, 'len=' + out.length);
    const allNames = manyTools.every((t) => out.includes('- ' + t.function.name));
    check('D2 60 个工具名全部保留（名字永不牺牲）', allNames);
    /* 小工具集：描述正常保留（未触发降级） */
    const small = [{
      type: 'function',
      function: { name: 'read_file', description: '读取指定路径的文件内容并返回文本。', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    }];
    const out2 = gw.buildToolsText(small);
    check('D3 小工具集描述正常保留（不降级）', out2.includes('- read_file: 读取指定路径的文件内容并返回文本。') && out2.includes('file_path(必填,string)'));
    check('D4 协议头与格式说明存在', out2.includes('tool_call') && out2.includes('可用工具：'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ========== E. driver length 信号 → 迁移+摘要（SPEC-v2 §5.3） ========== */
  console.log('== E. driver length 信号 → 迁移+摘要 ==');
  {
    /* E1-E2 模式表行为：length 类文案识别 */
    const start = DRV_SRC.indexOf('const LIMIT_PATTERNS');
    const end = DRV_SRC.indexOf('function stripThinkingBlocks');
    if (start < 0 || end < 0) throw new Error('LIMIT_PATTERNS section not found');
    const sandbox = { console: { log: () => {} } };
    vm.createContext(sandbox);
    vm.runInContext(DRV_SRC.slice(start, end) + ';globalThis.__dl = detectLimit;', sandbox, { filename: 'driver-limit.js' });
    const dl = sandbox.__dl;
    check('E1 对话过长提示 → length', dl('对话过长，无法继续') && dl('对话过长，无法继续').kind === 'length');
    check('E2 内容超出限制 → length', dl('当前内容超出长度限制') && dl('当前内容超出长度限制').kind === 'length');
    check('E3 context too long → length', dl('the context is too long') && dl('the context is too long').kind === 'length');
    check('E4 正常回答 → null（不误判）', dl('好的，对话历史如下所述：') === null);
  }
  {
    /* E5-E9 源码断言：streamAsk 的 length 迁移重试链路 */
    check('E5 检测点含 length 分支（lengthHit 置位）', /lim && lim\.kind === 'length'[\s\S]{0,80}lengthHit = true/.test(DRV_SRC));
    check('E6 迁移重试复用 extractHistoryDigest（摘要提取）', /streamAsk 对话过长 → 迁移\+摘要重试[\s\S]{0,200}extractHistoryDigest\(pageId\)/.test(DRV_SRC));
    check('E7 迁移后重发原问题（payload 前置摘要）', /【之前的对话摘要，请基于此继续】/.test(DRV_SRC));
    check('E8 3 次用尽 → 显式报错（不切账号：无 errorKind）', /'length: 对话过长且迁移重试后仍受限/.test(DRV_SRC));
    check('E9 reset=auto 预防性迁移复用同一摘要函数', /count > limit\)[\s\S]{0,400}digest = await extractHistoryDigest\(pageId\)/.test(DRV_SRC));
  }

  /* ========== B. askOnce 兜底超时（源码断言 + 行为模拟） ========== */
  console.log('== B. askOnce 兜底超时 ==');
  check('B1 兜底超时常量存在（20min > driver 最长 ~13min）', /ASK_WAIT_TIMEOUT_MS = 20 \* 60 \* 1000/.test(GW_SRC));
  check('B2 等待循环 Promise.race 超时保护', /Promise\.race\(\[consumer\.next\(\), waitTimeout\]\)/.test(GW_SRC));
  check('B3 超时分支报错（driver 卡死显式失败）', /__waitTimeout[\s\S]{0,120}gateway timeout: 等待 driver 流式结果超时/.test(GW_SRC));
  check('B4 consumer 清理（防 Map 泄漏）', /finally \{ clearTimeout\(waitTimer\); \}/.test(GW_SRC));
  /* B5 行为模拟：consumer 永不 end → race 超时先返回 __waitTimeout → 转为 ok:false */
  {
    const consumer = { next: () => new Promise(() => {}) }; /* 永不 resolve（模拟 driver 卡死） */
    const evt = await Promise.race([
      consumer.next(),
      new Promise((r) => setTimeout(() => r({ __waitTimeout: true }), 20)),
    ]);
    check('B5 consumer 永不返回 → 超时信号先到（不永久挂起）', !!evt.__waitTimeout);
  }

  /* ========== H. buildContext 首轮：多条 user/tool 消息完整性（v3a 修复） ========== */
  console.log('== H. 首轮上下文多消息完整性 ==');
  {
    /* H1：首轮含多条 user 消息（DSH 典型场景：项目背景 + 参考资料 + 实际问题）
     * + runtime context（需跳过）+ tool 结果消息。旧版只取最后一条 user，前面全丢。*/
    const PAYLOAD_FIRST_MULTI = {
      model: 'deepseek-chat', stream: true,
      messages: [
        { role: 'system', content: '你是代码助手' },
        { role: 'user', content: 'Current runtime context:\n- cwd: /tmp\n- DSH file policy: ask\n- Approval policy: never' },
        { role: 'user', content: '项目背景：这是一个 Node.js 网关项目，对接 DeepSeek 网页版。' },
        { role: 'user', content: '参考资料：前一版只把最后一条 user 消息发给模型，导致模型回答驴唇不对马嘴。' },
        { role: 'tool', content: '{ "ok": true, "files": ["a.js", "b.js"] }' },
        { role: 'user', content: '实际问题：请分析 buildContext 函数并修复上下文不完整问题。' },
      ],
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-cp-h1-'));
    const gw = makeGateway(tmp);
    const { calls } = makeRpcMock(gw, [{ ok: true, result: '多消息首轮修复验证完成' }]);
    const res = makeResMock();
    await gw.handleChatCompletion({}, res, PAYLOAD_FIRST_MULTI);
    const ask = calls.find((c) => c.method === 'streamAsk');
    const sseOut = sseText(res);
    /* 诊断：streamAsk 未发起或 params 无 q 时打印 keys/SSE 定位根因 */
    let diag = '';
    if (!ask) diag = '无 streamAsk 调用；SSE=' + sseOut.slice(0, 200);
    else {
      diag = 'ask.params.keys=' + Object.keys(ask.params).join(',') + '; q type=' + typeof ask.params.q;
      if (typeof ask.params.q === 'string') diag += ' sample=' + ask.params.q.slice(0, 80);
      else if (ask.params.text) diag += ' text=' + String(ask.params.text).slice(0, 80);
    }
    /* 注意：streamAsk RPC 参数属性名是 question（不是 q，网关内部局部变量叫 q，
     * 组装 RPC 时重命名为 question，与 driver streamAsk 参数对齐） */
    check('H1 first 模式 streamAsk 已发起（question 非空）', !!ask && typeof ask.params.question === 'string' && ask.params.question.length > 0, diag);
    const q = (ask && typeof ask.params.question === 'string') ? ask.params.question : '';
    /* v3a 修复：所有非 runtime-context 的 user/tool 消息都必须出现在首轮 q 中。
     * 断言分别检查：三个 [用户] 段 + 一个 [工具结果] 段；runtime context 字符串不出现在 [用户]里。
     * 仅 q 非空时跑以下断言（q 空则 H1 已失败，给出诊断即可，避免级联 TypeError 吞掉根因）*/
    const userCount = q ? (q.match(/\[用户\]/g) || []).length : 0;
    const toolCount = q ? (q.match(/\[工具结果\]/g) || []).length : 0;
    check('H2 首轮上下文含 3 段 [用户]（背景+资料+问题，旧版仅 1 段）', userCount === 3, 'userCount=' + userCount + ' | q=' + q.slice(0, 200));
    check('H3 首轮上下文含 1 段 [工具结果]（tool 消息不丢）', toolCount === 1, 'toolCount=' + toolCount);
    check('H4 首轮 user1：项目背景 保留', q.includes('项目背景：这是一个 Node.js 网关项目'), '背景丢失');
    check('H5 首轮 user2：参考资料 保留', q.includes('前一版只把最后一条 user 消息发给模型'), '参考资料丢失');
    check('H6 首轮 user3：实际问题 保留（旧版只有这条）', q.includes('请分析 buildContext 函数并修复上下文不完整问题'), '实际问题丢失');
    check('H7 首轮 tool：JSON 结果保留', q.includes('"files": ["a.js", "b.js"]'), '工具结果丢失');
    /* H8：正确行为 = runtime context 作为 extractBaseline 单独提取的"环境段"出现在 q 中
     * （模型确实需要知道 cwd、file policy、approval policy）；但它**绝不能**被错误地
     * 包装成 `[用户]\n...` 段（旧版三条件 AND 失配会把 Approval policy=never 的
     * runtime context 误当成普通用户消息，挤占真实用户消息位置）。*/
    const runtimeWrappedAsUser = /\[用户\]\nCurrent runtime context/.test(q);
    const runtimeContentPresent = q.indexOf('Approval policy: never') >= 0;
    check('H8 runtime context 作为独立环境段注入（不包成 [用户]），且内容保留',
      !runtimeWrappedAsUser && runtimeContentPresent,
      'runtimeWrappedAsUser=' + runtimeWrappedAsUser + ' runtimeContentPresent=' + runtimeContentPresent);
    check('H9 system 消息不单独出现在 [用户]/[工具结果] 段中（走 sys prompt 机制）',
      !q.includes('[用户]\n你是代码助手'), 'system 被误当 user 注入');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
