import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 冷启动复现：driver 刚拉起（Chrome 未运行）时，通过 streamAsk 发起
 * chatgpt 通道请求，验证是否会主动拉起 Chrome（而非报 browser not running）。 */
const DRIVER = process.argv[2] || '/Users/tynam/work/code/github.com/namejlt/dsh-dwwpseek-web-adapter/resources/driver.js';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsweb-coldstart-'));
console.log('base=' + base);

const driver = spawn(process.execPath, [DRIVER], {
  cwd: base,
  env: { ...process.env, DS_WEB_BASE: base, DS_WEB_CHROME: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
driver.on('exit', (code) => { console.log('driver exited code=' + code); process.exit(0); });

let logBuf = '';
driver.stderr.setEncoding('utf8');
driver.stderr.on('data', (c) => { logBuf += c; process.stdout.write('[driver] ' + c); });

let buf = '';
let rpcDone = false;
let startedAt = Date.now();
function send(obj) { driver.stdin.write(JSON.stringify(obj) + '\n'); }
function finish(result) {
  if (rpcDone) return;
  rpcDone = true;
  const launched = /launching\s+\/Applications\/Google Chrome/.test(logBuf);
  const hardFail = /error: browser not running/.test(logBuf) || /browser not running'\)/.test(logBuf);
  console.log('\n===== 验证结果 =====');
  console.log('Chrome 被拉起: ' + (launched ? '是' : '否'));
  console.log('出现 browser not running 硬失败: ' + (hardFail ? '是' : '否'));
  console.log('结果: ' + (launched && !hardFail ? 'PASS（冷启动模型访问能唤起 Chrome）' : 'FAIL（冷启动模型访问无法唤起 Chrome）'));
  if (result) console.log('stream-end: ' + JSON.stringify(result).slice(0, 300));
  send({ id: 999, method: 'shutdown', params: {} });
  setTimeout(() => { try { driver.kill('SIGKILL'); } catch (e) {} process.exit(0); }, 3000);
}

driver.stdout.setEncoding('utf8');
driver.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.event === 'ready') {
      console.log('[test] driver ready, sending streamAsk (chatgpt, pageKey=main, cold start)');
      send({ id: 1, method: 'streamAsk', params: { question: 'hi', providerId: 'chatgpt', profile: 'chatgpt-default', pageKey: 'main', headless: false, reset: true } });
    } else if (msg.id === 1) {
      console.log('[test] streamAsk rpc result:', JSON.stringify(msg).slice(0, 120));
    } else if (msg.event === 'stream-end') {
      console.log('[test] stream-end:', JSON.stringify(msg).slice(0, 200));
      finish(msg);
    }
    if (Date.now() - startedAt > 90000) {
      console.log('[test] 90s 超时');
      finish({ timeout: true });
    }
  }
});
