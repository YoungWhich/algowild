// scripts/qa_go_e2e_probe.mjs
// go 模式 HTTP/WS 端到端探针（严过关）。真实起服务、真实 REST + WS。
// 用法：由 bash 先 `PORT=17881 node server/index.js &` 起服务，再运行本脚本。
const BASE = process.env.BASE || 'http://127.0.0.1:17881';
const WSBASE = BASE.replace(/^http/, 'ws');

let PASS = 0, FAIL = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); results.push([ 'PASS', name ]); }
  else { FAIL++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); results.push([ 'FAIL', name, detail ]); }
}
async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
import WebSocket from 'ws';

const u = 'qa_' + Date.now();
console.log(`\n=== E2E: 注册用户 ${u} ===`);
const reg = await api('POST', '/api/auth/register', { username: u, password: 'Passw0rd!23' });
ok('注册成功', reg.code === 0 && reg.data && reg.data.token, JSON.stringify(reg).slice(0, 120));
const token = reg.data.token;

console.log('\n=== C1. POST /api/worlds mode=go ===');
const cw = await api('POST', '/api/worlds', { name: 'qa-go-世界', mode: 'go' }, token);
ok('建 go 世界返回 worldId', cw.code === 0 && cw.data && cw.data.worldId, JSON.stringify(cw).slice(0, 160));
ok('建 go 世界返回 mode=go', cw.data.mode === 'go', `mode=${cw.data.mode}`);
const worldId = cw.data.worldId;

console.log('\n=== C2. GET /api/worlds/:id → snapshot.mode/go ===');
const gw = await api('GET', `/api/worlds/${worldId}`, null, token);
const snap = gw.data && (gw.data.snap || gw.data.snapshot || gw.data);
ok('快照 mode === "go"', snap && snap.mode === 'go', `mode=${snap && snap.mode}`);
ok('快照 go !== null', snap && snap.go != null, `go=${snap ? JSON.stringify(snap.go).slice(0, 140) : 'n/a'}`);

console.log('\n=== C3. 建 go 房间 → 座位上限 == 2 ===');
const cr = await api('POST', '/api/rooms', { worldId }, token);
ok('建房间返回 code', cr.code === 0 && cr.data && cr.data.code, JSON.stringify(cr).slice(0, 160));
ok('go 房间 maxPlayers === 2', cr.data && cr.data.maxPlayers === 2, `maxPlayers=${cr.data && cr.data.maxPlayers}`);
const roomCode = cr.data.code;

console.log('\n=== C4. 建 rts 房间对照 → maxPlayers === 4 ===');
const cwR = await api('POST', '/api/worlds', { name: 'qa-rts-世界', mode: 'rts' }, token);
const crR = await api('POST', '/api/rooms', { worldId: cwR.data.worldId }, token);
ok('rts 房间 maxPlayers === 4', crR.data && crR.data.maxPlayers === 4, `maxPlayers=${crR.data && crR.data.maxPlayers}`);

console.log('\n=== C5. WS 连接 go 世界 → snapshot.mode=go；intent 落子推进一手 ===');
await new Promise((resolve) => {
  const ws = new WebSocket(`${WSBASE}/ws`);
  let gotSnap = false, sentIntent = false, gotMoveEvent = false, myId = null;
  let moveNoAtSnap = null, moveNoAfterMine = null, maxMoveNo = 0;
  const timer = setTimeout(finish, 7000);

  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } })));
  let done = false;
  function finish() {
    if (done) return; done = true;
    ok('WS 收到 snapshot 且 mode==="go"', gotSnap, gotSnap ? `go.moveNo=${moveNoAtSnap}` : '未收到 mode=go 的快照');
    ok('落子 intent 产生了 go_move 事件', gotMoveEvent, gotMoveEvent ? `我方 moveNo=${moveNoAfterMine}` : '未收到我方 go_move');
    ok('落子后 moveNo 前进', gotMoveEvent && maxMoveNo > (moveNoAtSnap || 0),
      `snap.moveNo=${moveNoAtSnap} → 最大 moveNo=${maxMoveNo}`);
    clearTimeout(timer);
    try { ws.close(); } catch {}
    resolve();
  }
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'welcome' && m.data && m.data.you) myId = m.data.you.id;
    if (m.type === 'snap' && !gotSnap && m.data && m.data.mode === 'go') {
      gotSnap = true;
      moveNoAtSnap = m.data.go && m.data.go.moveNo;
      if (!sentIntent) { sentIntent = true; ws.send(JSON.stringify({ type: 'intent', data: { go: { lx: 16, ly: 16 } } })); }
    }
    if (m.type === 'snap' && m.data && m.data.go && typeof m.data.go.moveNo === 'number') {
      maxMoveNo = Math.max(maxMoveNo, m.data.go.moveNo);
    }
    if (m.type === 'event' && Array.isArray(m.data)) {
      for (const e of m.data) {
        if (e.type === 'go_move' && String(e.playerId) === String(myId)) {
          gotMoveEvent = true; moveNoAfterMine = e.moveNo;
        }
      }
    }
    if (gotSnap && gotMoveEvent) finish();
  });
  ws.on('error', (e) => { ok('WS 连接无错误', false, String(e && e.message)); clearTimeout(timer); resolve(); });
});

console.log('\n\n========== E2E 汇总 ==========');
console.log(`PASS=${PASS} FAIL=${FAIL}`);
if (FAIL) { console.log('--- FAIL 明细 ---'); for (const r of results) if (r[0] === 'FAIL') console.log('  ✗ ' + r[1] + ' — ' + r[2]); }
process.exit(FAIL ? 1 : 0);
