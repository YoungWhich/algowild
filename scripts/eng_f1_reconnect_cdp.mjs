// scripts/eng_f1_reconnect_cdp.mjs — 工程师复验 F1（QA P1-1 重连风暴）的浏览器级证据
// 思路：CDP 打开页面 → 注册 → 建世界 → 快速建房 → 在浏览器里连续调用 joinWS() 两次
// （= 用户重复点「快速建房/房间码进房」的真实触发链），随后用 CDP 的
// Network.webSocketCreated 事件统计 8 秒内新建 WebSocket 的数量。
//   - 修复前：旧 ws 的 onclose 无条件 scheduleReconnect() → 每 1~2s 拆建一次 → 计数持续上涨
//   - 修复后：旧 ws 的 onclose 先判 `state.ws !== ws` 直接 return → 计数稳定在 2 次（即两次显式调用）
// 用法：node scripts/eng_f1_reconnect_cdp.mjs <live_url> <cdp_port> [tag]
import { writeFileSync } from 'node:fs';

const LIVE = process.argv[2] || 'http://127.0.0.1:17006/';
const PORT = process.argv[3] || '9340';
const TAG = process.argv[4] || 'f1';
const CDP = `http://127.0.0.1:${PORT}`;
// 注意：client.js 是 ES module（index.html 里 type="module"），顶层 joinWS/state 不挂 window，
// 因此本脚本全部通过 DOM 点击触发 + CDP 的 Network.webSocketCreated 计数来判定。
const OUT = `repro_shots/eng_f1_${TAG}.txt`;

const log = [];
const out = (s) => { log.push(String(s)); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(CDP + '/json/list')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
let wsCreated = 0, wsClosed = 0, wsFailed = 0;
const issues = [];
const consoleLines = [];

function txtOf(p) {
  if (!p) return '';
  if (p.type === 'string') return p.value;
  if (p.description) return p.description;
  if (p.preview && p.preview.description) return p.preview.description;
  if (p.value !== undefined) { try { return JSON.stringify(p.value); } catch { return String(p.value); } }
  return p.type || '';
}
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  const method = m.method;
  if (method === 'Network.webSocketCreated') wsCreated++;
  else if (method === 'Network.webSocketClosed') wsClosed++;
  else if (method === 'Network.webSocketFrameError' || method === 'Network.loadingFailed') {
    wsFailed++;
    issues.push('NETFAIL: ' + (m.params && (m.params.errorText || m.params.timestamp)));
  } else if (method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    issues.push('EXCEPTION: ' + (d.exception?.description || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
  } else if (method === 'Runtime.consoleAPICalled') {
    const line = '[' + m.params.type + '] ' + m.params.args.map(txtOf).join(' ');
    consoleLines.push(line);
    if (m.params.type === 'error' || m.params.type === 'warning') issues.push('CONSOLE[' + m.params.type + ']: ' + m.params.args.map(txtOf).join(' '));
  } else if (method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
    issues.push('LOG[' + m.params.entry.level + ']: ' + m.params.entry.text);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params = {}) => new Promise(res => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) { issues.push('EVAL_ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return null; }
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });   // 保证每次都取最新 client.js

out('navigate → ' + LIVE);
await send('Page.navigate', { url: LIVE });
await sleep(5000);

// --- 注册新用户 ---
const user = 'f1_' + Math.floor(Math.random() * 1e6);
await evalJs(`document.querySelector('#auth-u').value='${user}'; document.querySelector('#auth-p').value='r3pro_pw'; document.querySelector('#tab-reg').click(); true`);
await evalJs(`document.querySelector('#auth-go').click(); true`);
let logged = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  logged = await evalJs(`document.getElementById('auth-panel').style.display==='none' && document.getElementById('world-panel').style.display==='block'`);
  if (logged) break;
}
out('registered/login: ' + user + ' ' + logged);

// --- 建世界 ---
await evalJs(`document.querySelector('#world-name').value='F1复现'; document.querySelector('#world-seed').value='42'; true`);
await evalJs(`document.querySelector('#create-world').click(); true`);
let created = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const t = await evalJs(`(document.getElementById('world-msg')||{}).textContent||''`);
  if (t.includes('已建')) { created = true; break; }
}
out('world created: ' + created);

// --- 进房（第一次：点「快速建房」）---
await evalJs(`document.querySelector('#quick-room').click(); true`);
await sleep(3000);
const hudJoined = await evalJs(`(document.getElementById('hud')||{}).textContent||''`);
const joined = String(hudJoined).includes('落子占下') || String(hudJoined).length > 20;
out('joined(HUD 已渲染): ' + joined);

// --- 风暴触发：再点一次「快速建房」（= 用户重复点建房/进房，QA 的触发链）---
wsCreated = 0; wsClosed = 0; wsFailed = 0;
await evalJs(`document.querySelector('#quick-room').click(); true`);
await sleep(2500);
await evalJs(`document.querySelector('#quick-room').click(); true`);
await sleep(1000);
const after1s = wsCreated;
// 逐秒时间线：直观看出是否出现"每 1~2s 新建 1 个"的自持循环
out('[时间线] t=1s 新建=' + wsCreated + ' 关闭=' + wsClosed);
for (let s = 2; s <= 12; s++) {
  await sleep(1000);
  out(`[时间线] t=${s}s 新建=${wsCreated} 关闭=${wsClosed}`);
}
const after8s = wsCreated;
const hudText = await evalJs(`(document.getElementById('hud')||{}).textContent||''`);

out(`[WS 计数] 1s 内新建=${after1s}  8s 内累计新建=${after8s}  关闭=${wsClosed}  失败=${wsFailed}`);
out(`[HUD] ${String(hudText).slice(0, 120)}`);

// 判定：两次显式点击最多新建 2 个 WS；修复前旧 onclose 会每 1~2s 再排一次重连 → 计数持续上涨
const stormFree = after8s <= 3 && !String(hudText).includes('重连中');
out('');
out(stormFree
  ? 'PASS: 重复点「快速建房」后 8s 内 WebSocket 新建数 = ' + after8s + '（≤3）且 HUD 无「重连中」→ 无重连风暴'
  : 'FAIL: 8s 内新建 ' + after8s + ' 个 WS，HUD=' + String(hudText).slice(0, 60) + ' → 疑似仍在拆建循环');

out('');
out('==== ISSUES (distinct, max 5) ====');
const seen = new Set();
for (const i of issues) {
  const key = i.length > 200 ? i.slice(0, 200) : i;
  if (seen.has(key)) continue;
  seen.add(key);
  out(i);
  if (seen.size >= 5) break;
}
if (!issues.length) out('(no console errors/exceptions captured)');

writeFileSync(OUT, log.join('\n'));
ws.close();
process.exit(stormFree && issues.length === 0 ? 0 : 1);
