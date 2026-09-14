// scripts/qa_reconnect_probe.mjs — QA 独立复核：断线后 5s 内重连（<15s 宽限）反向用例
// 断言：1) 角色/领土保留（lifeCells > 0 且未归零）2) 玩家未被重复 addPlayer（人数不增、id 唯一）
//      3) 重连后仍单 tick（相邻 snap tick 差主值=1）4) 断线期间世界仍在前进（grace 内继续 tick）
// 另加：双连接（同账号两个 WS）幂等性检查。
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:17003';
const BASE_URL = new URL(BASE);

async function req(method, path, body, token = null) {
  let url = BASE + path;
  if (token) { const sep = url.includes('?') ? '&' : '?'; url += sep + 'token=' + encodeURIComponent(token); }
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`api ${method} ${path} -> ${r.status} ${j && j.message}`);
  return j.data;
}
const wsUrl = `${BASE_URL.protocol === 'https:' ? 'wss:' : 'ws:'}//${BASE_URL.host}/ws`;

// 建立连接并持续收集 snap
async function connect(token, worldId) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const st = { last: null, ticks: [], ws };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'snap') { st.last = m.data; st.ticks.push(m.data.tick); }
  });
  ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } }));
  for (let i = 0; i < 60 && !st.last; i++) await sleep(50);
  return st;
}
const ids = (snap) => (snap.players || []).map(p => String(p.id));
const mine = (snap, uid) => (snap.players || []).find(p => String(p.id) === String(uid));

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} — ${detail}`); };

const main = async () => {
  const suffix = Date.now();
  const reg = await req('POST', '/api/auth/register', { username: 'qarc_' + suffix, password: 'password123' });
  const token = reg.token; const uid = (reg.user && reg.user.id) ?? (reg.user && reg.user.uid);
  const w = await req('POST', '/api/worlds', { name: 'qarc', seed: 3 }, token);
  const worldId = w.worldId;
  await req('POST', '/api/rooms', { worldId }, token);

  // ---- 建立连接并积累领土：先活到 era1 再狂按 F 落子 ----
  const s1 = await connect(token, worldId);
  const myUid = mine(s1.last, uid) ? String(mine(s1.last, uid).id) : String(ids(s1.last)[0]);
  // 一直发 plant + 移动意图，约 40s（era1 在 600 tick≈37s 解锁，这里只求等到能落子）
  const planter = setInterval(() => {
    try {
      s1.ws.send(JSON.stringify({ type: 'intent', data: { move: { dx: (Math.random() * 2 - 1), dy: (Math.random() * 2 - 1) }, plant: true } }));
    } catch {}
  }, 120);
  const t0 = Date.now();
  while (Date.now() - t0 < 42000 && (mine(s1.last, myUid)?.lifeCells || 0) < 6) await sleep(500);
  clearInterval(planter);
  await sleep(300);

  const before = s1.last;
  const beforeMe = mine(before, myUid);
  const beforeIds = ids(before);
  const beforeCount = beforeIds.length;
  const beforeCells = beforeMe ? (beforeMe.lifeCells || 0) : 0;
  const beforeEra = beforeMe ? beforeMe.era : -1;
  console.log(`[断线前] players=${beforeCount} ids=${beforeIds.join(',')} me.lifeCells=${beforeCells} era=${beforeEra} tick=${before.tick}`);
  if (beforeCells === 0) { console.log('WARN: 断线前 lifeCells=0，领土保留断言不可靠（era 未解锁）'); }

  // ---- 断开，等 5s（< 15s 宽限）----
  const tickAtDrop = s1.last.tick;
  s1.ws.close();
  await sleep(5000);

  // ---- 重连 ----
  const s2 = await connect(token, worldId);
  await sleep(300);
  const after = s2.last;
  const afterMe = mine(after, myUid);
  const afterIds = ids(after);
  const afterCount = afterIds.length;
  const afterCells = afterMe ? (afterMe.lifeCells || 0) : 0;
  console.log(`[重连后] players=${afterCount} ids=${afterIds.join(',')} me.lifeCells=${afterCells} era=${afterMe && afterMe.era} tick=${after.tick}`);

  check('C-1 重连后玩家仍在（未被 removePlayer）', !!afterMe, `me=${afterMe ? afterMe.name : 'null'}`);
  check('C-2 玩家总数未增加（无重复 addPlayer）', afterCount <= beforeCount, `before=${beforeCount} after=${afterCount}`);
  check('C-3 玩家 id 无重复', new Set(afterIds).size === afterIds.length, `ids=${afterIds.join(',')}`);
  check('C-4 领土未被擦除（lifeCells 保留）', beforeCells === 0 || afterCells >= 1, `before=${beforeCells} after=${afterCells}`);
  check('C-5 断线期间世界仍在前进（宽限内继续 tick）', after.tick > tickAtDrop + 20, `dropTick=${tickAtDrop} afterTick=${after.tick} Δ=${after.tick - tickAtDrop}`);

  // 重连后 tick 节奏
  s2.ticks.length = 0; await sleep(1500);
  const d = []; for (let i = 1; i < s2.ticks.length; i++) d.push(s2.ticks[i] - s2.ticks[i - 1]);
  const cnt = {}; for (const x of d) cnt[x] = (cnt[x] || 0) + 1;
  const dom = d.length ? d.reduce((a, b) => (cnt[a] >= (cnt[b] || 0) ? a : b)) : -1;
  check('C-6 重连后仍单 tick（相邻差主值=1）', dom === 1, `dist=${JSON.stringify(cnt)}`);

  // ---- 双连接幂等（H2）----
  const s3 = await connect(token, worldId);
  await sleep(600);
  const dualIds = ids(s3.last);
  check('C-7 同账号双 WS：玩家不重复', new Set(dualIds).size === dualIds.length && dualIds.length <= afterCount,
    `ids=${dualIds.join(',')} (before=${afterCount})`);
  s3.ws.close();
  await sleep(800);
  // 关掉第二个连接后，第一个仍在 → 不该触发 removePlayer
  check('C-8 关掉双开连接后主连接角色仍在', !!mine(s2.last, myUid), `players=${ids(s2.last).length}`);

  s2.ws.close();
  await sleep(200);

  const failed = results.filter(r => !r.ok);
  console.log(`\n[SUMMARY] ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
};
main().catch((e) => { console.error(e); process.exit(1); });
