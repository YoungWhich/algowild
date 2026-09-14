// 通过 CDP 驱动本机 Chrome 复现线上"地图闪一下就报错"：抓 console/异常 + 截图
// 用法: node cdp_repro.mjs <live_url> <cdp_port> <profile_tag>
const LIVE = process.argv[2] || 'http://127.0.0.1:17000/';
const PORT = process.argv[3] || '9334';
const TAG = process.argv[4] || String(Date.now());
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = `repro_shots/repro_${TAG}.png`;

const wait = ms => new Promise(r => setTimeout(r, ms));

// --- connect to the page target ---
const list = await (await fetch(CDP + '/json/list')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map(); const events = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else events.push(m);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params = {}) => new Promise(res => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- collect browser logs ---
const issues = [];
function txtOf(p) {
  if (!p) return '';
  if (p.type === 'string') return p.value;
  if (p.description) return p.description;            // Error 对象：含 "TypeError: ..."
  if (p.preview && p.preview.description) return p.preview.description;
  if (p.value !== undefined) { try { return JSON.stringify(p.value); } catch { return String(p.value); } }
  return p.type || '';
}
const onEvent = m => {
  const method = m.method;
  if (method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    issues.push('EXCEPTION: ' + (d.exception?.description || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
  } else if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    issues.push('CONSOLE[' + m.params.type + ']: ' + m.params.args.map(txtOf).join(' '));
  } else if (method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
    issues.push('LOG[' + m.params.entry.level + ']: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  } else if (method === 'Network.loadingFailed') {
    issues.push('NETFAIL: ' + m.params.errorText + ' ' + (m.params.blockedReason || ''));
  } else if (method === 'Runtime.consoleAPICalled') {
    // 把 info/debug 也留档，便于排查顺序
    events.push(m);
  }
};
ws.addEventListener('message', ev => onEvent(JSON.parse(ev.data)));

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    issues.push('EVAL_ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return null;
  }
  return r.result?.result?.value;
};
const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { const { writeFileSync } = await import('node:fs'); writeFileSync(file, Buffer.from(r.result.data, 'base64')); return true; }
  return false;
};

console.log('navigate →', LIVE);
await send('Page.navigate', { url: LIVE });
await sleep(5000);

// register a fresh user
const user = 'repro' + Math.floor(Math.random() * 1e6);
await evalJs(`document.querySelector('#auth-u').value='${user}'; document.querySelector('#auth-p').value='r3pro_pw'; document.querySelector('#tab-reg').click(); true`);
await evalJs(`document.querySelector('#auth-go').click(); true`);
let logged = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  logged = await evalJs(`document.getElementById('auth-panel').style.display==='none' && document.getElementById('world-panel').style.display==='block'`);
  if (logged) break;
}
console.log('registered/login:', user, logged);
if (!logged) {
  const msg = await evalJs(`(document.getElementById('auth-msg')||{}).textContent`);
  console.log('auth-msg:', msg);
}
await shot(`repro_shots/repro_${TAG}_a_login.png`);

// create world
await evalJs(`document.querySelector('#world-name').value='复现${TAG}'; document.querySelector('#world-seed').value='42'; true`);
await evalJs(`document.querySelector('#create-world').click(); true`);
let created = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const t = await evalJs(`(document.getElementById('world-msg')||{}).textContent||''`);
  if (t.includes('已建')) { created = true; break; }
  const e = await evalJs(`(document.getElementById('world-msg')||{}).textContent||''`);
  if (e.includes('err') || e.includes('失败')) { console.log('create-world msg:', e); break; }
}
console.log('world created:', created);

// quick room → WS hello → snap → first frames
await evalJs(`document.querySelector('#quick-room').click(); true`);
await sleep(2500);
// 关掉首屏任务简报模态，避免遮挡红字（modal 元素 id 固定为 'modal'）
await evalJs(`(function(){const m=document.getElementById('modal');if(m){m.style.display='none';}return !!m;})()`);
await shot(`repro_shots/repro_${TAG}_b_map.png`);
// wait more ticks, watch for the reported error
await sleep(8000);
await shot(`repro_shots/repro_${TAG}_c_late.png`);

// try triggering preview (Q) & movement, to exercise render paths
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'q'})); true`);
await sleep(600);
await shot(`repro_shots/repro_${TAG}_d_q.png`);
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'q'})); true`);

// what's on canvas center? read a probe: dump any red error text drawn on canvas via pixel sample is hard;
// instead read body text / any .toast / #hud content
const hud = await evalJs(`(document.getElementById('hud')||{}).innerHTML||''`);
const toasts = await evalJs(`Array.from(document.querySelectorAll('.toast')).map(t=>t.textContent).join(' | ')`);
console.log('hud:', hud.slice(0, 300));
console.log('toasts:', toasts.slice(0, 300));

console.log('\n==== ISSUES (first 5 distinct) ====');
const seen = new Set();
let dup = 0;
for (const i of issues) {
  const key = i.length > 220 ? i.slice(0, 220) : i;
  if (seen.has(key)) { dup++; continue; }
  seen.add(key);
  console.log(i);
  if (seen.size >= 5) break;
}
if (dup) console.log(`(+${dup} identical repeats)`);
if (!issues.length) console.log('(no console errors/exceptions captured)');

// also grab recent console info (renders/ws)
const infos = events.filter(m => m.method === 'Runtime.consoleAPICalled')
  .map(m => '[' + m.params.type + '] ' + m.params.args.map(txtOf).join(' ')).slice(0, 40);
console.log('\n==== CONSOLE (all types) ====');
for (const s of infos) console.log(s);

console.log('\nDONE files under /tmp/repro_' + TAG + '_*.png');
ws.close();
process.exit(0);
