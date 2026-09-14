// scripts/qa_lobby_e2e.mjs — 房间大厅端到端验证（真实起服务）
// 覆盖：先建房后建世界、自定义席位、手动加电脑、电脑占席位、满员拒绝、
//       公开/私密+密码、搜索/列表、暂停、任意玩家存档、WS 进房、go 多方。
import WebSocket from 'ws';

const PORT = process.env.PORT || 17892;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`[PASS] ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${label}${extra ? ' — ' + extra : ''}`); }
}

async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

function wsConnect(worldId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      seen.push(m);
      if (m.type === 'snap' && !resolve.done) { resolve.done = true; resolve({ ws, snaps: seen, first: m.data }); }
    });
    ws.on('error', reject);
    setTimeout(() => { if (!resolve.done) { resolve.done = true; resolve({ ws, snaps: seen, first: null }); } }, 4000);
  });
}

const uniq = Date.now();
async function newUser(tag) {
  const u = `${tag}_${uniq}`;
  const r = await req('POST', '/api/auth/register', { username: u, password: 'password123' });
  return r.data;
}

const main = async () => {
  const host = await newUser('host');
  const guest = await newUser('guest');
  ok(!!host.token && !!guest.token, '两个账号注册成功');

  // 1) 先建房（还没有世界）
  const room = await req('POST', '/api/rooms', { name: 'E2E 房', maxPlayers: 4, visibility: 'public', mode: 'go' }, host.token);
  ok(room.code === 0, '建房成功', room.message);
  const code = room.data.code;
  ok(room.data.room.worldId === null && room.data.room.phase === 'lobby', '建房时还没有世界（先建房后建世界）');

  // 2) 大厅列表能搜到
  const list = await req('GET', '/api/rooms', null, host.token);
  ok(list.code === 0 && list.data.rooms.some(r => r.code === code), '公开房间出现在大厅列表');

  // 3) 房主建世界
  const w = await req('POST', `/api/rooms/${code}/world`, { mode: 'go' }, host.token);
  ok(w.code === 0 && w.data.mode === 'go', '房主建立 go 世界成功', w.data && w.data.mode);
  const worldId = w.data.worldId;
  ok(w.data.room.phase === 'ready', '建世界后房间进入 ready');

  // 4) 房主加入 + 手动加 2 个电脑
  const hj = await req('POST', `/api/rooms/${code}/join`, {}, host.token);
  ok(hj.code === 0 && hj.data.worldId === worldId, '房主加入世界');
  const ai1 = await req('POST', `/api/rooms/${code}/ai`, {}, host.token);
  const ai2 = await req('POST', `/api/rooms/${code}/ai`, {}, host.token);
  ok(ai1.code === 0 && ai2.code === 0, '手动添加 2 个电脑玩家成功');
  let info = await req('GET', `/api/rooms/${code}`, null, host.token);
  ok(info.data.seatCount === 3 && info.data.aiCount === 2, '电脑玩家占用席位', `seat=${info.data.seatCount} ai=${info.data.aiCount}`);

  // 5) 开始游戏（不需等齐）
  const st = await req('POST', `/api/rooms/${code}/start`, {}, host.token);
  ok(st.code === 0 && st.data.room.started === true, '不需等玩家到齐即可开始');

  // 6) 中途加入：第 4 个席位给人
  const gj = await req('POST', `/api/rooms/${code}/join`, {}, guest.token);
  ok(gj.code === 0, '第二个真人中途加入成功');
  info = await req('GET', `/api/rooms/${code}`, null, host.token);
  ok(info.data.seatCount === 4, '席位 4/4（2 人 + 2 电脑）', `${info.data.humanCount}H + ${info.data.aiCount}AI`);

  // 7) 满员后拒绝
  const third = await newUser('third');
  const full = await req('POST', `/api/rooms/${code}/join`, {}, third.token);
  ok(full.code === 4002, '满席后加入被拒绝 room_full', full.message);

  // 8) 房主暂停 / 恢复；非房主不可暂停
  const pDeny = await req('POST', `/api/rooms/${code}/pause`, { paused: true }, guest.token);
  ok(pDeny.code === 403, '非房主不能暂停');
  const pOn = await req('POST', `/api/rooms/${code}/pause`, { paused: true }, host.token);
  ok(pOn.code === 0 && pOn.data.paused === true, '房主暂停成功');
  const pOff = await req('POST', `/api/rooms/${code}/pause`, { paused: false }, host.token);
  ok(pOff.data.paused === false, '房主恢复成功');

  // 9) 任意玩家存档
  const sv = await req('POST', `/api/rooms/${code}/save`, {}, guest.token);
  ok(sv.code === 0 && !!sv.data.savedAt, '任意玩家（非房主）可以存档');

  // 10) WS 进房 + go 多方快照
  const conn = await wsConnect(worldId, host.token);
  const snap = conn.first;
  ok(!!snap, 'WS 收到快照');
  if (snap) {
    ok(snap.mode === 'go', '快照模式为 go');
    ok(snap.go && Array.isArray(snap.go.seats) && snap.go.seats.length === 4, 'go 快照含 4 个席位', snap.go && snap.go.seats && snap.go.seats.length);
    ok(snap.go && snap.go.seats.filter(s => s.isAI).length === 2, '席位中 2 个是电脑');
    ok(snap.seatCap === 4, '快照席位上限 = 房主设定的 4', String(snap.seatCap));
  }
  // 11) 落一手（若轮到人类）
  if (snap && snap.go) {
    const turnPid = snap.go.turn;
    const humanTurn = String(turnPid) === String(host.id) || String(turnPid) === String(guest.id);
    if (humanTurn) {
      const mover = String(turnPid) === String(host.id) ? host : guest;
      const conn2 = String(turnPid) === String(host.id) ? conn : await wsConnect(worldId, guest.token);
      conn2.ws.send(JSON.stringify({ type: 'intent', data: { go: { lx: 16, ly: 16 } } }));
      await new Promise(r => setTimeout(r, 900));
      const last = conn2.snaps[conn2.snaps.length - 1];
      const moved = last && last.type === 'snap' && last.data.go && last.data.go.moveNo >= 2;
      ok(!!moved, '人类落子成功且手数推进', last && last.data && last.data.go ? 'moveNo=' + last.data.go.moveNo : 'n/a');
    } else {
      ok(true, '（本轮行动方是电脑，跳过人类落子检查）');
    }
  }
  try { conn.ws.close(); } catch {}

  // 12) 私密房间：密码错拒绝、密码对通过；不上大厅列表
  const pri = await req('POST', '/api/rooms', { name: '私密', maxPlayers: 2, visibility: 'private', password: 'pw123456', mode: 'rts' }, host.token);
  const pc = pri.data.code;
  ok(pri.data.room.hasPassword === true, '私密房间标记需要密码');
  await req('POST', `/api/rooms/${pc}/world`, { mode: 'rts' }, host.token);
  const bad = await req('POST', `/api/rooms/${pc}/join`, { password: 'nope' }, guest.token);
  ok(bad.code === 4003, '私密房密码错误被拒绝');
  const good = await req('POST', `/api/rooms/${pc}/join`, { password: 'pw123456' }, guest.token);
  ok(good.code === 0, '私密房密码正确可加入');
  const list2 = await req('GET', '/api/rooms', null, host.token);
  ok(!list2.data.rooms.some(r => r.code === pc), '私密房不出现在大厅列表');
  const found = await req('GET', `/api/rooms/search?code=${pc}`, null, host.token);
  ok(found.code === 0 && found.data.visibility === 'private' && found.data.players === undefined, '按房间号可搜索到，但不泄露成员');

  console.log(`\n===== PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('E2E 异常：', e); process.exit(1); });
