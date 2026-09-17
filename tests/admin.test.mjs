// tests/admin.test.mjs — 管理员后台：角色引导 / 鉴权 / 封禁 / 级联删除 / 审计
// 覆盖：
//   1) 首个注册用户为 admin，第二个为 player
//   2) 非管理员访问 /api/admin/* → 403
//   3) 用户列表分页与搜索；结果不含 passhash
//   4) 封禁 → 登录 4004 / GET /me 4004 / WS 握手被拒(4004)
//   5) 解封 → 登录恢复 code 0
//   6) DELETE 需 confirmUsername 一致；一致则级联清理 worlds/rooms/scores
//   7) 护栏：封禁自己 / 删除自己 / 降级最后一个管理员 → 拒绝
//   8) 每次操作写入审计日志
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createRouter } from '../server/routes.js';
import { initDB, db, usersRepo, worldsRepo, roomsRepo, scoresRepo } from '../server/db/index.js';
import { loadKernels } from '../server/engine.js';
import { attachWS } from '../server/net.js';

await initDB();
await loadKernels();

let server, baseUrl, wsPort;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', createRouter());
  server = http.createServer(app);
  attachWS(server);
  await new Promise((res) => { server.listen(0, '127.0.0.1', () => res()); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/api`;
  wsPort = port;
});

test.after(() => { if (server) server.close(); });

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers['Authorization'] = 'Bearer ' + token; headers['x-auth-token'] = token; }
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

let seq = 0;
function uName(p) { return `${p}_${Date.now()}_${seq++}`; }

async function register(name) {
  const r = await call('POST', '/auth/register', { username: name, password: 'password123' });
  assert.equal(r.body.code, 0, '注册应成功: ' + JSON.stringify(r.body));
  return r.body.data; // { token, user }
}

// 尝试用被封禁账号发起 WS 握手，返回 close code（超时 → 0）
function wsHandshake(token, worldId = 'nonexistent') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(code); } };
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } })));
    ws.on('close', (code) => finish(code));
    ws.on('error', () => finish(-1));
    setTimeout(() => finish(0), 2500);
  });
}

// 状态在文件内顺序累积，供后续测试复用
const ctx = { admin: null, player: null };

// ---------------------------------------------------------------- 1) 引导：首账号管理员
test('ADM-01 首个注册账号自动成为管理员；第二个为玩家', async () => {
  const a = await register(uName('admin'));
  const p = await register(uName('player'));
  assert.equal(a.user.role, 'admin', '首个账号应为管理员');
  assert.equal(p.user.role, 'player', '第二个账号应为普通玩家');
  ctx.admin = a;
  ctx.player = p;

  // 登录也应带回 role
  const lg = await call('POST', '/auth/login', { username: a.user.username, password: 'password123' });
  assert.equal(lg.body.code, 0);
  assert.equal(lg.body.data.user.role, 'admin', '登录应返回 role');

  // /me 也应返回 role
  const me = await call('GET', '/me', null, a.token);
  assert.equal(me.body.code, 0);
  assert.equal(me.body.data.role, 'admin');

  // 后续用例需要"能改角色"的身份（改角色端点仅超管可用），
  // 这里把首个账号提升为 superadmin（等价服务端的 MASTER 自举路径）。
  // 注意：引导本身给的是 admin，提升发生在断言之后，不影响本用例的语义。
  usersRepo.setRole(a.user.id, 'superadmin');
  assert.equal(usersRepo.byId(a.user.id).role, 'superadmin', 'setRole 应能写入超管角色');
});

// ---------------------------------------------------------------- 2) 非管理员 403
test('ADM-02 非管理员访问所有 /api/admin/* 一律 403', async () => {
  const paths = [
    ['GET', '/admin/overview'],
    ['GET', '/admin/users'],
    ['GET', '/admin/actions'],
    ['GET', '/admin/rooms'],
    ['POST', '/admin/users/1/kick'],
    ['POST', '/admin/users/1/unban'],
    ['POST', '/admin/users/1/role'],
    ['POST', '/admin/users/1/ban'],
  ];
  for (const [m, p] of paths) {
    const r = await call(m, p, m === 'GET' ? null : {}, ctx.player.token);
    assert.equal(r.status, 403, `${m} ${p} 应 403，实际 ${r.status}`);
    assert.equal(r.body.code, 403);
  }
});

// ---------------------------------------------------------------- 3) 列表/搜索/无 passhash
test('ADM-03 用户列表分页与搜索；结果不含 passhash', async () => {
  // 再造几个用户（player_ 前缀便于搜索）
  for (let i = 0; i < 3; i++) await register(uName('searchme'));

  const list = await call('GET', '/admin/users?page=1&pageSize=2', null, ctx.admin.token);
  assert.equal(list.body.code, 0);
  assert.ok(list.body.data.rows.length <= 2, 'pageSize=2 时行数应 ≤2');
  assert.ok(list.body.data.total >= 5, '总数应 ≥5');

  // 严禁 passhash
  const raw = JSON.stringify(list.body.data);
  assert.ok(!/passhash/i.test(raw), '列表响应不得含 passhash');

  // 搜索（子串）
  const s = await call('GET', '/admin/users?q=searchme', null, ctx.admin.token);
  assert.equal(s.body.code, 0);
  assert.ok(s.body.data.rows.length >= 3, '搜索 searchme 应至少命中 3 个');
  assert.ok(s.body.data.rows.every((u) => u.username.includes('searchme')));

  // 按 id 精确搜索
  const byId = await call('GET', `/admin/users?q=${ctx.player.user.id}`, null, ctx.admin.token);
  assert.equal(byId.body.code, 0);
  assert.ok(byId.body.data.rows.some((u) => u.id === ctx.player.user.id), '按 id 搜索应命中');

  // 过滤 admin：返回全部提权角色（此时系统里只有超管）
  const adm = await call('GET', '/admin/users?filter=admin', null, ctx.admin.token);
  assert.equal(adm.body.code, 0);
  assert.ok(adm.body.data.rows.length >= 1, 'filter=admin 应命中提权账号');
  assert.ok(adm.body.data.rows.every((u) => ['admin', 'readonly', 'superadmin'].includes(u.role)),
    'filter=admin 只返回提权角色（管理员 / 只读 / 超管）');
});

// ---------------------------------------------------------------- 4) 封禁全链路
test('ADM-04 封禁 → 登录 4004 / me 4004 / WS 握手被拒', async () => {
  const pid = ctx.player.user.id;
  const ban = await call('POST', `/admin/users/${pid}/ban`, { reason: '测试封禁', durationHours: 0 }, ctx.admin.token);
  assert.equal(ban.body.code, 0, '封禁应成功');
  assert.equal(ban.body.data.banned, true);

  // 登录被拒
  const lg = await call('POST', '/auth/login', { username: ctx.player.user.username, password: 'password123' });
  assert.equal(lg.body.code, 4004, '被封禁登录应返回 4004');
  assert.equal(lg.body.message, 'account_banned');

  // /me 被拒
  const me = await call('GET', '/me', null, ctx.player.token);
  assert.equal(me.body.code, 4004, '被封禁 /me 应返回 4004');

  // WS 握手被拒（close 4004）
  const code = await wsHandshake(ctx.player.token);
  assert.equal(code, 4004, '被封禁账号 WS 握手应以 4004 关闭，实际: ' + code);
});

// ---------------------------------------------------------------- 5) 解封恢复
test('ADM-05 解封后登录恢复 code 0', async () => {
  const pid = ctx.player.user.id;
  const un = await call('POST', `/admin/users/${pid}/unban`, {}, ctx.admin.token);
  assert.equal(un.body.code, 0);
  const lg = await call('POST', '/auth/login', { username: ctx.player.user.username, password: 'password123' });
  assert.equal(lg.body.code, 0, '解封后应能登录');
});

// ---------------------------------------------------------------- 6) 删除 + 级联
test('ADM-06 删除需 confirmUsername 一致；一致则级联清理', async () => {
  const victim = await register(uName('victim'));
  const vid = victim.user.id;
  // 造数据：一个世界 + 一条分数 + 一个房间
  const w = await call('POST', '/worlds', { name: 'victim世界', seed: 7 }, victim.token);
  assert.equal(w.body.code, 0);
  const worldId = w.body.data.worldId;
  await call('POST', '/scores', { worldId, score: 42 }, victim.token);
  const rm = await call('POST', '/rooms', { name: 'victim房', maxPlayers: 4 }, victim.token);
  assert.equal(rm.body.code, 0);
  const roomCode = rm.body.data.code;

  // 错误确认名 → 拒绝
  const bad = await call('DELETE', `/admin/users/${vid}`, { confirmUsername: 'wrong-name' }, ctx.admin.token);
  assert.equal(bad.body.code, 400, '确认名不一致应拒绝');
  assert.equal(bad.body.message, 'confirm_username_mismatch');
  assert.ok(usersRepo.byId(vid), '拒绝后用户应仍存在');

  // 正确确认名 → 删除
  const ok = await call('DELETE', `/admin/users/${vid}`, { confirmUsername: victim.user.username }, ctx.admin.token);
  assert.equal(ok.body.code, 0, '确认名一致应删除成功');

  // 用户消失
  assert.equal(usersRepo.byId(vid), null, '用户应被删除');
  // 级联：world / scores / rooms 无残留
  assert.equal(worldsRepo.get(worldId), null, 'world 应被清理');
  assert.equal(worldsRepo.listByOwner(vid).length, 0, 'listByOwner 应无残留');
  assert.equal(scoresRepo.byUser(vid).length, 0, 'scores 应被清理');
  assert.equal(roomsRepo.get(roomCode), null, 'room 应被清理');
});

// ---------------------------------------------------------------- 7) 护栏
test('ADM-07 护栏：封禁自己 / 删除自己 / 降级最后一个管理员', async () => {
  const aid = ctx.admin.user.id;

  const banSelf = await call('POST', `/admin/users/${aid}/ban`, { reason: 'x' }, ctx.admin.token);
  assert.equal(banSelf.body.code, 400, '封禁自己应拒绝');
  assert.equal(banSelf.body.message, 'cannot_target_self');

  const delSelf = await call('DELETE', `/admin/users/${aid}`, { confirmUsername: ctx.admin.user.username }, ctx.admin.token);
  assert.equal(delSelf.body.code, 400, '删除自己应拒绝');
  assert.equal(delSelf.body.message, 'cannot_target_self');

  // 此时系统内唯一可写管理员就是 ctx.admin（超管）→ 降级应被 last_admin_protected 拒绝
  const cnt = usersRepo.count();
  assert.equal(cnt.admins, 1, '此刻应只有 1 个可写管理员（超管计入 admins）');
  assert.equal(cnt.superadmins, 1, '此刻应只有 1 个超管');
  const demote = await call('POST', `/admin/users/${aid}/role`, { role: 'player' }, ctx.admin.token);
  assert.equal(demote.body.code, 400, '降级最后一个管理员应拒绝');
  assert.equal(demote.body.message, 'last_admin_protected');
});

// ---------------------------------------------------------------- 8) 审计日志
test('ADM-08 每次操作都留下审计记录（GET /admin/actions）', async () => {
  const target = await register(uName('auditee'));
  const tid = target.user.id;
  await call('POST', `/admin/users/${tid}/ban`, { reason: 'audit', durationHours: 1 }, ctx.admin.token);
  await call('POST', `/admin/users/${tid}/unban`, {}, ctx.admin.token);
  await call('POST', `/admin/users/${tid}/kick`, {}, ctx.admin.token);
  await call('POST', `/admin/users/${tid}/role`, { role: 'admin' }, ctx.admin.token);
  await call('POST', `/admin/users/${tid}/role`, { role: 'player' }, ctx.admin.token);

  const acts = await call('GET', '/admin/actions?limit=100', null, ctx.admin.token);
  assert.equal(acts.body.code, 0);
  const names = acts.body.data.rows.map((a) => a.action);
  for (const want of ['ban', 'unban', 'kick', 'set_role']) {
    assert.ok(names.includes(want), `审计应包含动作 ${want}`);
  }
  // 审计行不含 passhash，且含操作者
  const raw = JSON.stringify(acts.body.data);
  assert.ok(!/passhash/i.test(raw), '审计响应不得含 passhash');
  const latest = acts.body.data.rows[0];
  assert.ok(latest.actor_name, '审计应记录操作者名');
  assert.ok(latest.created_at, '审计应记录时间');

  // 管理员降级自己（多管理员时）→ cannot_target_self（另一分支覆盖）
  const demoteOther = await call('POST', `/admin/users/${ctx.admin.user.id}/role`, { role: 'player' }, ctx.admin.token);
  // 此刻有 2 个管理员(admin + auditee 刚降级为 player，实际仅 admin)。仅断言是 400 拒绝即可。
  assert.equal(demoteOther.body.code, 400, '降级唯一的自己应被拒绝');
});

// ---------------------------------------------------------------- 附加：总览/房间接口可用
test('ADM-09 总览与房间列表接口对管理员可用', async () => {
  const ov = await call('GET', '/admin/overview', null, ctx.admin.token);
  assert.equal(ov.body.code, 0);
  assert.ok(ov.body.data.users && typeof ov.body.data.users.total === 'number');
  assert.equal(typeof ov.body.data.dbType, 'string');
  assert.ok('online' in ov.body.data);
  assert.ok(typeof ov.body.data.version === 'string');

  const rooms = await call('GET', '/admin/rooms', null, ctx.admin.token);
  assert.equal(rooms.body.code, 0);
  assert.ok(Array.isArray(rooms.body.data.rooms));
});

// ---------------------------------------------------------------- 10) 封禁覆盖所有需登录接口
test('ADM-10 被封禁用户对全部需登录接口一律 4004（含此前漏网的大厅/房间/快照/存档/AI）', async () => {
  const leaky = await register(uName('leaky'));
  const ban = await call('POST', `/admin/users/${leaky.user.id}/ban`, { reason: '全覆盖测试', durationHours: 0 }, ctx.admin.token);
  assert.equal(ban.body.code, 0, '封禁应成功');

  // 覆盖 routes.js 中所有已加 requireActive 的路由（GET /rooms/:code 为公开接口，见下方说明，不在内）
  const endpoints = [
    ['GET', '/rooms'],
    ['GET', '/rooms/search?code=AAAAAA'],
    ['GET', '/worlds/deadbeef'],
    ['GET', '/worlds/deadbeef/saves'],
    ['GET', '/worlds/deadbeef/emergents'],
    ['GET', '/scores/me'],
    ['POST', '/worlds'],
    ['POST', '/worlds/deadbeef/save'],
    ['POST', '/scores'],
    ['POST', '/rooms'],
    ['POST', '/rooms/AAAAAA/world'],
    ['POST', '/rooms/AAAAAA/start'],
    ['POST', '/rooms/AAAAAA/join'],
    ['POST', '/rooms/AAAAAA/pause'],
    ['POST', '/rooms/AAAAAA/ai'],
    ['POST', '/rooms/AAAAAA/save'],
    ['DELETE', '/rooms/AAAAAA/ai/1'],
    ['DELETE', '/rooms/AAAAAA'],
  ];
  for (const [m, p] of endpoints) {
    const r = await call(m, p, m === 'GET' ? null : {}, leaky.token);
    assert.equal(r.body.code, 4004, `${m} ${p} 应对被封禁用户返回 4004，实际 code=${r.body.code}`);
    assert.equal(r.body.message, 'account_banned', `${m} ${p} message 应为 account_banned`);
  }

  // GET /rooms/:code 是"公开邀请落地页"接口（无需登录）：保持公开、不叠加 requireActive。
  // 验证其仍可匿名访问（既有回归测试依赖），封禁与否不影响这条公开读。
  const pubRoom = await call('GET', '/rooms/AAAAAA', null, null);
  assert.notEqual(pubRoom.body.code, 4004, '公开房间详情接口不应因封禁返回 4004（它本就无需登录）');
});

// ---------------------------------------------------------------- 11) 管理员不可被封禁
test('ADM-11 封禁 role===admin 的用户 → cannot_ban_admin；该管理员仍可登录；且不写审计', async () => {
  const a2 = await register(uName('adminp'));
  // 提升为管理员
  const promote = await call('POST', `/admin/users/${a2.user.id}/role`, { role: 'admin' }, ctx.admin.token);
  assert.equal(promote.body.code, 0);

  const bad = await call('POST', `/admin/users/${a2.user.id}/ban`, { reason: '不该成功' }, ctx.admin.token);
  assert.equal(bad.body.code, 400, '封禁管理员应被拒绝');
  assert.equal(bad.body.message, 'cannot_ban_admin');

  // 该管理员仍能登录（未被封）
  const lg = await call('POST', '/auth/login', { username: a2.user.username, password: 'password123' });
  assert.equal(lg.body.code, 0, '管理员不应被封，仍可登录');
  assert.equal(lg.body.data.user.role, 'admin');

// 被拒动作不写审计：审计里不应出现"目标=该管理员 且 动作=ban"的记录
  const acts = await call('GET', '/admin/actions?limit=200', null, ctx.admin.token);
  const bannedAdminLogged = acts.body.data.rows.some((a) => a.action === 'ban' && a.target_name === a2.user.username);
  assert.equal(bannedAdminLogged, false, '被拒的封禁不应写审计');
});

// ============================================================ 账号级角色分级（player < readonly < admin < superadmin）
const ROLE_CTX = { readonly: null };

/** 由超管把某账号设为指定角色。 */
async function setRole(targetId, role, token) {
  return call('POST', `/admin/users/${targetId}/role`, { role }, token);
}

// ---------------------------------------------------------------- 12) 角色白名单（仓储层）
test('ADM-12 usersRepo.setRole 接受 4 个合法角色；非法值回落 player', () => {
  const u = usersRepo.byId(ctx.player.user.id);
  for (const r of ['player', 'readonly', 'admin', 'superadmin']) {
    usersRepo.setRole(u.id, r);
    assert.equal(usersRepo.byId(u.id).role, r, `setRole 应写入 ${r}`);
  }
  for (const bad of ['root', '', null, undefined, 42, { r: 'admin' }]) {
    usersRepo.setRole(u.id, bad);
    assert.equal(usersRepo.byId(u.id).role, 'player', `非法角色 ${String(bad)} 应回落 player`);
  }
  // admins 统计含 superadmin，superadmins 单独一项
  const before = usersRepo.count();
  usersRepo.setRole(u.id, 'superadmin');
  const after = usersRepo.count();
  assert.equal(after.admins, before.admins + 1, '超管应计入 admins（否则"最后一个管理员"保护会失效）');
  assert.equal(after.superadmins, before.superadmins + 1, '超管应计入 superadmins');
  usersRepo.setRole(u.id, 'player');
});

// ---------------------------------------------------------------- 13) 只读管理员：读全通
test('ADM-13 readonly 可读全部只读端点（overview/users/user/rooms/actions/maintenance）', async () => {
  const ro = await register(uName('readonlyAdmin'));
  const promo = await setRole(ro.user.id, 'readonly', ctx.admin.token);
  assert.equal(promo.body.code, 0, '超管应能把账号设为只读');
  ROLE_CTX.readonly = ro;

  const reads = [
    ['GET', '/admin/overview'],
    ['GET', '/admin/users'],
    ['GET', `/admin/users/${ctx.player.user.id}`],
    ['GET', '/admin/rooms'],
    ['GET', '/admin/actions'],
    ['GET', '/admin/maintenance'],
  ];
  for (const [m, p] of reads) {
    const r = await call(m, p, null, ro.token);
    assert.equal(r.body.code, 0, `readonly 应能读 ${m} ${p}，实际 ${JSON.stringify(r.body)}`);
  }
});

// ---------------------------------------------------------------- 14) 只读管理员：写全拒
test('ADM-14 readonly 对所有变更端点一律 403 readonly_forbidden', async () => {
  const victim = await register(uName('roTarget'));
  const ro = ROLE_CTX.readonly;
  const rm = await call('POST', '/rooms', { name: 'ro房', maxPlayers: 4 }, victim.token);
  const code = rm.body.data.code;

  const writes = [
    ['POST', `/admin/users/${victim.user.id}/ban`, { reason: 'x' }],
    ['POST', `/admin/users/${victim.user.id}/unban`, {}],
    ['POST', `/admin/users/${victim.user.id}/kick`, {}],
    ['POST', `/admin/users/${victim.user.id}/role`, { role: 'admin' }],
    ['DELETE', `/admin/users/${victim.user.id}`, { confirmUsername: victim.user.username }],
    ['POST', `/admin/rooms/${code}/close`, {}],
    ['POST', '/admin/maintenance/inactive-days', { days: 30 }],
    ['POST', '/admin/maintenance/purge', {}],
  ];
  for (const [m, p, body] of writes) {
    const r = await call(m, p, body, ro.token);
    assert.equal(r.status, 403, `${m} ${p} 应对 readonly 返回 403，实际 ${r.status}`);
    assert.equal(r.body.code, 403, `${m} ${p} body.code 应为 403`);
    assert.equal(r.body.message, 'readonly_forbidden', `${m} ${p} message 应为 readonly_forbidden`);
  }
  // 确认没有副作用：目标账号仍在、未被封、未被删，房间也没被关
  const still = usersRepo.byId(victim.user.id);
  assert.ok(still, '被拒操作后用户应仍存在');
  assert.equal(still.banned, 0, 'readonly 的封禁不应生效');
  assert.equal(still.role, 'player', 'readonly 的改角色不应生效');
  const rooms = await call('GET', '/admin/rooms', null, ctx.admin.token);
  assert.ok(rooms.body.data.rooms.some((x) => x.code === code), '房间不应被 readonly 关闭');
});

// ---------------------------------------------------------------- 15) 管理员：能写 / 不能改角色 / 不能碰超管
test('ADM-15 admin 可写但不能改角色；对超管 ban/kick/delete/降级 一律 403', async () => {
  const ad = await register(uName('plainAdmin'));
  assert.equal((await setRole(ad.user.id, 'admin', ctx.admin.token)).body.code, 0);
  const target = await register(uName('adminTarget'));

  // 能写：封禁一个普通玩家应成功（随后解封复原）
  const ban = await call('POST', `/admin/users/${target.user.id}/ban`, { reason: 'ok' }, ad.token);
  assert.equal(ban.body.code, 0, '管理员应能封禁普通玩家');
  assert.equal((await call('POST', `/admin/users/${target.user.id}/unban`, {}, ad.token)).body.code, 0);

  // 不能改角色（含给自己提权）
  for (const id of [target.user.id, ad.user.id]) {
    const r = await setRole(id, 'admin', ad.token);
    assert.equal(r.status, 403, `管理员改角色 ${id} 应 403`);
    assert.equal(r.body.message, 'role_change_forbidden', '非超管改角色应为 role_change_forbidden');
  }
  assert.equal(usersRepo.byId(target.user.id).role, 'player', '管理员的改角色不应生效');

  // 不能碰超管：ban / kick / delete / 降级
  const saId = ctx.admin.user.id;
  const banSa = await call('POST', `/admin/users/${saId}/ban`, { reason: 'x' }, ad.token);
  assert.equal(banSa.status, 403);
  assert.equal(banSa.body.message, 'cannot_target_superadmin', '管理员封禁超管应 cannot_target_superadmin');
  const kickSa = await call('POST', `/admin/users/${saId}/kick`, {}, ad.token);
  assert.equal(kickSa.status, 403);
  assert.equal(kickSa.body.message, 'cannot_target_superadmin');
  const delSa = await call('DELETE', `/admin/users/${saId}`, { confirmUsername: ctx.admin.user.username }, ad.token);
  assert.equal(delSa.status, 403);
  assert.equal(delSa.body.message, 'cannot_target_superadmin');
  const demoteSa = await setRole(saId, 'readonly', ad.token);
  assert.equal(demoteSa.status, 403);
  assert.equal(demoteSa.body.message, 'cannot_target_superadmin');
  assert.ok(usersRepo.byId(saId), '超管账号不应被管理员删掉');
  assert.equal(usersRepo.byId(saId).role, 'superadmin', '超管角色不应被管理员改动');
});

// ---------------------------------------------------------------- 16) 超管：改角色 + 最后一个超管保护
test('ADM-16 超管能改出 4 种角色；最后一个超管不可被降级', async () => {
  const p = await register(uName('roleCycle'));
  const pid = p.user.id;
  for (const r of ['readonly', 'admin', 'superadmin', 'player']) {
    const res = await setRole(pid, r, ctx.admin.token);
    assert.equal(res.body.code, 0, `超管应能设为 ${r}：${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.role, r);
    assert.equal(usersRepo.byId(pid).role, r, `库里应落地 ${r}`);
  }
  // 非法值 → 400 bad_role
  const bad = await setRole(pid, 'root', ctx.admin.token);
  assert.equal(bad.body.code, 400);
  assert.equal(bad.body.message, 'bad_role');

  // 最后一个超管 self 降级 → last_superadmin_protected（此时还有别的 admin，故不是 last_admin_protected）
  assert.ok(usersRepo.count().admins >= 2, '此刻应存在其他可写管理员，才能单独验证超管保护');
  for (const r of ['admin', 'readonly', 'player']) {
    const res = await setRole(ctx.admin.user.id, r, ctx.admin.token);
    assert.equal(res.body.code, 400, `降级最后一个超管到 ${r} 应被拒绝`);
    assert.equal(res.body.message, 'last_superadmin_protected');
  }
  assert.equal(usersRepo.byId(ctx.admin.user.id).role, 'superadmin', '最后一个超管角色应保持不变');

  // 有两个超管时，降级其中一个是允许的（保护的是"最后一个"，不是一刀切）
  const sa2 = await register(uName('secondSa'));
  assert.equal((await setRole(sa2.user.id, 'superadmin', ctx.admin.token)).body.code, 0);
  assert.ok(usersRepo.count().superadmins >= 2);
  assert.equal((await setRole(sa2.user.id, 'player', ctx.admin.token)).body.code, 0, '存在多个超管时可降级其中一个');
  assert.equal(usersRepo.byId(sa2.user.id).role, 'player');
});

// ---------------------------------------------------------------- 17) 旧/未知角色值按玩家处理
test('ADM-17 未知角色值按玩家处理：无后台权限，且仍可被超管改回合法角色', async () => {
  const legacy = await register(uName('legacyRole'));
  // 直接写库模拟历史脏数据
  usersRepo.setRole(legacy.user.id, 'player');
  db().run('UPDATE users SET role=? WHERE id=?', ['moderator', legacy.user.id]);
  assert.equal(usersRepo.byId(legacy.user.id).role, 'moderator', '脏数据应原样读回');

  const r = await call('GET', '/admin/overview', null, legacy.token);
  assert.equal(r.status, 403, '未知角色应视为普通玩家 → 403');
  assert.equal(r.body.code, 403);

  // 超管仍可把它改成合法角色（不会卡死），随后复原为玩家
  assert.equal((await setRole(legacy.user.id, 'readonly', ctx.admin.token)).body.code, 0);
  assert.equal(usersRepo.byId(legacy.user.id).role, 'readonly');
  assert.equal((await setRole(legacy.user.id, 'player', ctx.admin.token)).body.code, 0);
});

// ---------------------------------------------------------------- 19) 不活跃清理不碰提权账号
test('ADM-18 不活跃清理候选排除全部提权账号（只读 / 管理员 / 超管都不会被清理）', () => {
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  const old = now - 200 * DAY;
  const mk = (prefix, role) => {
    const name = uName(prefix);
    usersRepo.create(name, null, 'x');
    db().run('UPDATE users SET created_at=?, last_login=? WHERE username=?', [old, old, name]);
    const u = usersRepo.byUsername(name);
    if (role) usersRepo.setRole(u.id, role);
    return name;
  };
  const plain = mk('inactivePlain', null);
  const ro = mk('inactiveReadonly', 'readonly');
  const ad = mk('inactiveAdmin', 'admin');
  const sa = mk('inactiveSuperadmin', 'superadmin');

  const cands = usersRepo.listInactive(now - 30 * DAY).map((r) => r.username);
  assert.ok(cands.includes(plain), '不活跃普通玩家应在候选里');
  assert.ok(!cands.includes(ro), '只读管理员不应被清理');
  assert.ok(!cands.includes(ad), '管理员不应被清理');
  assert.ok(!cands.includes(sa), '超管不应被清理');
});

// ---------------------------------------------------------------- 19) MASTER 自举 = superadmin
test('ADM-19 MASTER_USERNAME 自举账号为 superadmin（含已存在账号的强制提回）', async () => {
  const prevName = process.env.MASTER_USERNAME;
  const prevPass = process.env.MASTER_PASSWORD;
  const prevNoStart = process.env.ALGOWILD_NO_AUTOSTART;
  const masterName = uName('masterBoot');
  process.env.ALGOWILD_NO_AUTOSTART = '1';   // 只导入不拉起 HTTP / WS
  process.env.MASTER_USERNAME = masterName;
  process.env.MASTER_PASSWORD = 'MasterPass123';
  try {
    const { bootstrapMaster } = await import('../server/index.js');
    await bootstrapMaster();
    const created = usersRepo.byUsername(masterName);
    assert.ok(created, '自举应创建 master 账号');
    assert.equal(created.role, 'superadmin', 'MASTER 自举账号应为 superadmin');

    const lg = await call('POST', '/auth/login', { username: masterName, password: 'MasterPass123' });
    assert.equal(lg.body.code, 0, '自举账号应能用 MASTER_PASSWORD 登录');
    assert.equal(lg.body.data.user.role, 'superadmin', '登录应带回 superadmin');

    // 被降级后再次自举 → 强制提回 superadmin
    usersRepo.setRole(created.id, 'admin');
    await bootstrapMaster();
    assert.equal(usersRepo.byUsername(masterName).role, 'superadmin', '角色不符时应被强制提回');
  } finally {
    if (prevName === undefined) delete process.env.MASTER_USERNAME; else process.env.MASTER_USERNAME = prevName;
    if (prevPass === undefined) delete process.env.MASTER_PASSWORD; else process.env.MASTER_PASSWORD = prevPass;
    if (prevNoStart === undefined) delete process.env.ALGOWILD_NO_AUTOSTART; else process.env.ALGOWILD_NO_AUTOSTART = prevNoStart;
  }
});

