// scripts/qa_live_smoke.mjs — 线上（已发布）全链路冒烟：房间大厅 + 席位模型 + 双模式
// 用法：BASE=https://xxx.app.workbuddy.link node scripts/qa_live_smoke.mjs
// 注意：该平台反向代理会劫持 Authorization 头，故一律用 ?token= 查询参数鉴权（优先级最高的通道）。
import WebSocket from 'ws';

const BASE = process.env.BASE;
if (!BASE) { console.error('缺少 BASE 环境变量'); process.exit(2); }
const WS_BASE = BASE.replace(/^http/, 'ws');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

async function j(method, path, body, token) {
  const url = BASE + '/api' + path + (token ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { code: -1, message: 'non_json: ' + txt.slice(0, 120) }; }
}

const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function mkUser(tag) {
  const u = tag + '_' + uniq();
  const r = await j('POST', '/auth/register', { username: u, password: 'password123' });
  if (r.code !== 0) throw new Error('register failed: ' + r.message);
  return { ...r.data.user, token: r.data.token, username: u };
}

console.log('线上冒烟目标:', BASE, '\n');

// ---------- 0. 探活 ----------
console.log('0. 探活');
{
  const m = await j('GET', '/meta');
  ok('GET /api/meta 返回 code=0', m.code === 0, JSON.stringify(m.data));
}

// ---------- 1. 先建房（不建世界） ----------
console.log('\n1. 房间模型：先建房 → 后建世界');
const host = await mkUser('host');
let code, worldId;
{
  const r = await j('POST', '/rooms', { maxPlayers: 4, mode: 'go', visibility: 'public', name: '线上冒烟房' }, host.token);
  ok('POST /api/rooms 建房成功（未建世界）', r.code === 0, JSON.stringify(r.data));
  code = r.data && r.data.code;
  ok('返回房间号', typeof code === 'string' && code.length >= 4, 'code=' + code);
  ok('maxPlayers 回显 4', r.data && Number(r.data.maxPlayers) === 4, 'maxPlayers=' + (r.data && r.data.maxPlayers));
  ok('worldId 尚未创建（空）', !r.data.worldId, 'worldId=' + JSON.stringify(r.data.worldId));

  const w = await j('POST', `/rooms/${code}/world`, { mode: 'go' }, host.token);
  ok('POST /rooms/:code/world 房主建世界', w.code === 0, JSON.stringify(w.data));
  worldId = w.data && w.data.worldId;
  ok('拿到 worldId', !!worldId, 'worldId=' + worldId);
}

// ---------- 2. 房主入座 + 手动加电脑玩家 ----------
console.log('\n2. 席位：房主入座 + 手动加电脑玩家（电脑占席位）');
let aiCount = 0;
{
  const join = await j('POST', `/rooms/${code}/join`, {}, host.token);
  ok('房主 join 成功', join.code === 0, join.message);
  for (let i = 0; i < 2; i++) {
    const a = await j('POST', `/rooms/${code}/ai`, {}, host.token);
    if (a.code === 0) aiCount++;
  }
  ok('手动添加 2 个电脑玩家', aiCount === 2, '成功 ' + aiCount + '/2');
  const info = await j('GET', `/rooms/${code}`, null, host.token);
  ok('房间详情可读', info.code === 0, JSON.stringify(info.data && { seatCount: info.data.seatCount, aiCount: info.data.aiCount, mode: info.data.mode }));
  ok('席位 = 人类 + 电脑', info.data && Number(info.data.seatCount) === 3, 'seatCount=' + (info.data && info.data.seatCount));
}

// ---------- 3. 公开房间出现在大厅列表 ----------
console.log('\n3. 公开房间 → 大厅列表');
{
  const r = await j('GET', '/rooms', null, host.token);
  ok('GET /api/rooms 返回 code=0', r.code === 0, r.message);
  const list = (r.data && r.data.rooms) || [];
  const mine = list.find(x => x.code === code);
  ok('公开房出现在列表', !!mine, '列表 ' + list.length + ' 条');
  if (mine) {
    ok('列表项含人数/模式/席位', mine.mode != null && mine.seatCount != null, JSON.stringify({ mode: mine.mode, seatCount: mine.seatCount, maxPlayers: mine.maxPlayers }));
    ok('公开房 hasPassword=false', mine.hasPassword === false, 'hasPassword=' + mine.hasPassword);
  }
  ok('maxPlayers 上限为 8', r.data && Number(r.data.maxPlayers) === 8, 'maxPlayers=' + (r.data && r.data.maxPlayers));
}

// ---------- 4. 私密房间：密码 + 不泄露 + 按号搜索 ----------
console.log('\n4. 私密房间：密码保护 / 不进列表 / 按房间号搜索');
let privCode;
{
  const r = await j('POST', '/rooms', { maxPlayers: 8, mode: 'rts', visibility: 'private', password: 's3cret', name: '秘密基地' }, host.token);
  ok('建私密房成功', r.code === 0, JSON.stringify(r.data));
  privCode = r.data && r.data.code;

  const list = await j('GET', '/rooms', null, host.token);
  const leaked = ((list.data && list.data.rooms) || []).find(x => x.code === privCode);
  ok('私密房不出现在公开列表', !leaked);

  // 契约：私密房搜索返回 { code, visibility:'private', hasPassword, mode, phase }（不含 exists 字段）
  const s = await j('GET', `/rooms/search?code=${privCode}`, null, host.token);
  ok('按房间号搜到私密房', s.code === 0 && s.data && s.data.code === privCode, JSON.stringify(s.data));
  ok('搜索标注 visibility=private', s.data && s.data.visibility === 'private', 'visibility=' + (s.data && s.data.visibility));
  ok('搜索注明需要密码', s.data && s.data.hasPassword === true, 'hasPassword=' + (s.data && s.data.hasPassword));
  ok('搜索不泄露房间名与成员', s.data && s.data.name === undefined && s.data.players === undefined, JSON.stringify(s.data));

  const nf = await j('GET', '/rooms/search?code=ZZZZZZ', null, host.token);
  ok('搜不存在的房间 → 4001 room_not_found', nf.code === 4001, 'code=' + nf.code + ' ' + nf.message);

  const pubSearch = await j('GET', `/rooms/search?code=${code}`, null, host.token);
  ok('公开房搜索返回完整房间信息', pubSearch.code === 0 && pubSearch.data && pubSearch.data.visibility === 'public' && pubSearch.data.name === '线上冒烟房', JSON.stringify(pubSearch.data && { visibility: pubSearch.data.visibility, name: pubSearch.data.name }));

  const outsider = await mkUser('out');
  const bad = await j('POST', `/rooms/${privCode}/join`, { password: 'wrong' }, outsider.token);
  ok('错误密码被拒绝', bad.code !== 0, 'code=' + bad.code + ' ' + bad.message);

  const world = await j('POST', `/rooms/${privCode}/world`, { mode: 'rts' }, host.token);
  ok('房主可为私密房建世界', world.code === 0, world.message);

  const good = await j('POST', `/rooms/${privCode}/join`, { password: 's3cret' }, outsider.token);
  ok('正确密码可加入', good.code === 0, 'code=' + good.code + ' ' + good.message);
  ok('加入后拿到快照与模式', good.code === 0 && good.data && good.data.snap && good.data.mode === 'rts', 'mode=' + (good.data && good.data.mode));
}

// ---------- 5. 房主暂停（非房主应 403） ----------
console.log('\n5. 房主暂停权限');
{
  const outsider = await mkUser('nb');
  const bad = await j('POST', `/rooms/${code}/pause`, {}, outsider.token);
  ok('非房主暂停被拒（403）', bad.code === 403, 'code=' + bad.code + ' ' + bad.message);
  const good = await j('POST', `/rooms/${code}/pause`, {}, host.token);
  ok('房主可暂停', good.code === 0, 'code=' + good.code + ' ' + good.message);
  const res = await j('POST', `/rooms/${code}/pause`, {}, host.token);
  ok('房主可恢复', res.code === 0, 'code=' + res.code);
}

// ---------- 6. 任意玩家可存档 ----------
console.log('\n6. 任意玩家存档');
{
  const guest = await mkUser('g');
  const jn = await j('POST', `/rooms/${code}/join`, {}, guest.token);
  ok('第 2 个人类加入', jn.code === 0, jn.message);
  const s = await j('POST', `/rooms/${code}/save`, {}, guest.token);
  ok('非房主玩家也能存档', s.code === 0, 'code=' + s.code + ' ' + s.message);
}

// ---------- 7. WS：seatCap 与多方快照 ----------
console.log('\n7. WebSocket：席位上限 + 多方快照');
{
  const snap = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/ws`);
    let first = null;
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token: host.token, worldId } })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'snap' && !first) { first = m.data; done(m.data); }
    });
    ws.on('error', (e) => done({ error: String(e && e.message) }));
    setTimeout(() => done(first || { error: 'timeout' }), 8000);
  });
  ok('WS hello 后收到快照', !!snap && !snap.error, snap.error || 'ok');
  if (snap && !snap.error) {
    ok('快照含座位数上限 seatCap=4', Number(snap.seatCap) === 4, 'seatCap=' + snap.seatCap);
    ok('快照含 mode=go', snap.mode === 'go', 'mode=' + snap.mode);
    ok('go 快照含 seats 数组', snap.go && Array.isArray(snap.go.seats), 'seats=' + (snap.go && snap.go.seats && snap.go.seats.length));
    ok('玩家数 = 房主 + 1 人类 + 2 电脑', (snap.players || []).length === 4, 'players=' + (snap.players || []).length);
    const ais = (snap.players || []).filter(p => p.isAI).length;
    ok('其中电脑玩家 2 个', ais === 2, 'AI=' + ais);
  }
}

console.log('\n──────────────────────────────');
console.log(`线上冒烟结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
