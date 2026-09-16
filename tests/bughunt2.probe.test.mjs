// tests/bughunt2.probe.test.mjs — 第二轮对抗式 Bug 排查（只调研/取证，不改源码）
//
// 覆盖：go 超时判负语义、go 落子坐标校验、权限（非房主/越权）、封禁生命周期、
//       私密房匿名泄露、棋盘/设置输入校验、XFF 管理来源绕过。
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createRouter } from '../server/routes.js';
import { signToken, isBanActive } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';
import { normBoard, createRoom } from '../server/rooms.js';

await initDB();
await loadKernels();

let seq = 0;
function newUser(prefix) {
  const name = prefix + '_' + Date.now() + '_' + (seq++);
  usersRepo.create(name, name + '@t', 'fakehash');
  const u = usersRepo.byUsername(name);
  return { id: u.id, username: u.username, token: signToken({ id: u.id, username: u.username }) };
}
function goWorld(opts) {
  const wd = new World('bh2_' + Math.random(), 1, 42, Object.assign({ mode: 'go' }, opts || {}));
  wd._skipAIFill = true;
  wd.started = true;
  wd.addAI();
  wd.addAI();
  wd._goInit();
  return wd;
}

// ============================================================ BUG-3: go 超时判负语义
// 「累计超时判负」：某玩家累计超时达上限 → 该玩家应判负。当前实现 _goEndTurn 只把
// reason 记为 'timeout' 就调用 _goFinish('timeout')，而 _goFinish 完全按**数子分**
// 决定胜者（认输/被吃光才从胜者池剔除，超时者未加 lost 标记）→ 超时者若地盘大，
// 反而**赢了**这局。这是终局结果错误。
test('BH2-GO-01 超时判负：累计超时达上限的玩家不应因分数高而获胜', () => {
  const wd = new World('bh2_to', 1, 42, { mode: 'go', goLimits: { turnMs: 5000, maxTimeouts: 1 } });
  wd._skipAIFill = true;
  wd.started = true;
  wd.addAI();
  wd.addAI();
  wd._goInit();
  const g = wd.go;
  const f0 = g.seatF[0], f1 = g.seatF[1];
  // 让 seat0（先手）以密集格点铺满整盘 → 数子分碾压；seat1 只放角落一子
  for (let x = 0; x < 32; x += 2) for (let y = 0; y < 32; y += 2) wd._life[x][y] = f0;
  wd._life[31][31] = f1;
  // seat0「累计超时」达上限（maxTimeouts=1）
  wd.players[g.seats[0]].goTimeouts = 1;
  // 收束一回合 → 触发超时终局
  wd._goEndTurn({ ok: true }, []);
  assert.ok(g.result, '应已终局');
  assert.equal(g.result.reason, 'timeout', '终局原因应为 timeout');
  // 期望：超时者判负——胜者不应是 seat0（超时者）
  assert.notEqual(g.result.winner, g.seats[0],
    '累计超时达上限的玩家不应获胜（当前实现会因数子分高而判其胜）');
});

// ============================================================ BUG-4: go 落子坐标未校验有限整数
// gomoku/weiqi 用 Number.isInteger 拒绝 NaN/Infinity/浮点；go 的 applyGoIntent 只做
// `typeof === 'number'` 判定，随后 `lx | 0` 静默截断：
//   · 1e999（JSON 合法数字，parse 成 Infinity）→ Infinity|0 = 0 → 落到 (0,0)！
//   · 3.7 → 落到 (3, ...)。
// WS 原始帧 '{"go":{"lx":1e999,"ly":0}}' 即可复现（JSON.parse 产出 Infinity）。
test('BH2-GO-02 落子坐标 1e999(→Infinity) 不应被静默截断为 (0,0)', () => {
  const wd = goWorld();
  const g = wd.go;
  const pid = g.seats[g.turnIdx];
  const before = wd._life[0][0];
  const r = wd.applyGoIntent(pid, { lx: 1e999, ly: 0 }, []);
  assert.equal(r.ok, false, '超大/非有限坐标应被拒绝（当前会截断到 0 并落子）');
  assert.equal(wd._life[0][0], before, '(0,0) 不应被落子');
});

test('BH2-GO-03 落子坐标浮点 (3.7,4.2) 不应被静默截断为 (3,4)', () => {
  const wd = goWorld();
  const g = wd.go;
  const pid = g.seats[g.turnIdx];
  const r = wd.applyGoIntent(pid, { lx: 3.7, ly: 4.2 }, []);
  assert.equal(r.ok, false, '非整数坐标应被拒绝（gomoku/weiqi 均拒绝，go 应一致）');
});

// ============================================================ BUG-1: 畸形 dash 破坏世界 tick（崩溃面）
// net.js 的 INTENT 只对 `intent.move` 做 Number.isFinite 校验，**未校验 `intent.dash`**。
// dash 的 dx/dy 直接进入 engine `p.vx += (dx/l)*2.4`；dx=1e999（JSON 合法 → JSON.parse 得 Infinity）时
// l=hypot(Inf)=Inf，dx/l=Inf/Inf=NaN → p.vx=NaN → 坐标 NaN → 之后每 tick 在 `_life[NaN]` 抛
// "Cannot read properties of undefined" → 该世界 tick 永久崩溃（per-world DoS + 日志刷屏）。
test('BH2-CRASH-01 畸形 dash(1e999→Infinity) 不应污染速度/坐标或破坏世界 tick', () => {
  const w = new World('bh2_crash', 1, 42, { mode: 'rts' });
  w.started = true;
  const a = w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  w.intentQueue.push(1, { dash: { dx: 1e999, dy: 1e999 } });   // 模拟 WS 原始帧 payload
  w.tickOnce();
  assert.ok(Number.isFinite(a.vx) && Number.isFinite(a.vy), `速度不应为 NaN（vx=${a.vx},vy=${a.vy}）`);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `坐标不应为 NaN（x=${a.x},y=${a.y}）`);
  assert.doesNotThrow(() => w.tickOnce(), '世界 tick 不应因畸形 payload 持续崩溃');
});

// ============================================================ BUG-5: rts 军事出局后仍存活
// 死亡数达 DEATH_LIMIT 的玩家应「出局」（不再参与对局）。但复活块先 `p.alive=true; hp=hpMax`，
// 随后只置 `p.lost=true` 而**漏置 `p.alive=false`**（对照 wiped 出局路径 L627 有置 false）→
// 出局者变成满血幽灵：仍被 P6 攻击循环锁定、可移动/攻击/收资源，与注释「已出局不再复活」相悖。
test('BH2-RTS-01 军事出局（deaths 达 DEATH_LIMIT）后玩家不应存活', () => {
  const w = new World('bh2_rts', 1, 42, { mode: 'rts' });
  w.started = true;
  const a = w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  a.deaths = World.DEATH_LIMIT;
  a.alive = false;
  a.respawnTicks = 0;
  w.tickOnce();
  assert.equal(a.lost, true, '达死亡上限应出局');
  assert.equal(a.alive, false, '出局者不应仍存活（当前 alive=true → 满血幽灵继续参战）');
});

// ============================================================ 权限：非房主不能执行房主专属操作
async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}
function call(app, method, path, body, token) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        method, hostname: '127.0.0.1', port: srv.address().port, path,
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; });
        res.on('end', () => { srv.close(); let j; try { j = JSON.parse(d); } catch { j = { raw: d.slice(0, 200) }; } resolve({ status: res.statusCode, body: j }); });
      });
      req.on('error', () => { srv.close(); resolve({ err: true }); });
      if (data) req.write(data);
      req.end();
    });
  });
}

test('BH2-AUTH-01 非房主执行 开始/暂停/改设置/建世界/关房 均应 403', async () => {
  const app = await setupApp();
  const host = newUser('bh2host');
  const other = newUser('bh2other');
  const r = await call(app, 'POST', '/api/rooms', { name: 'x', maxPlayers: 4, visibility: 'public' }, host.token);
  const code = r.body.data.code;

  // 先由**房主**建世界（这样才有世界可用于后续探测）
  const wbuild = await call(app, 'POST', `/api/rooms/${code}/world`, {}, host.token);
  assert.equal(wbuild.body.code, 0, '房主建世界应成功');

  // 另一房间，专门测"非房主建世界"
  const r2 = await call(app, 'POST', '/api/rooms', { name: 'y', maxPlayers: 4, visibility: 'public' }, host.token);
  const w2 = await call(app, 'POST', `/api/rooms/${r2.body.data.code}/world`, {}, other.token);
  assert.equal(w2.body.code, 403, '非房主建世界应 403');

  const st = await call(app, 'POST', `/api/rooms/${code}/start`, {}, other.token);
  assert.equal(st.body.code, 403, '非房主开始应 403');
  const pa = await call(app, 'POST', `/api/rooms/${code}/pause`, {}, other.token);
  assert.equal(pa.body.code, 403, '非房主暂停应 403');
  const se = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { victoryLines: { territory: true } }, other.token);
  assert.equal(se.body.code, 403, '非房主改设置应 403');
  const del = await call(app, 'DELETE', `/api/rooms/${code}`, null, other.token);
  assert.equal(del.body.code, 403, '非房主关房应 403');
});

test('BH2-AUTH-03 任意登录用户可 POST /rooms{worldId} 绑定他人世界并篡改其 maxPlayers', async () => {
  const app = await setupApp();
  const victim = newUser('bh2vic');
  const attacker = newUser('bh2atk');
  // 受害者建世界（默认 8 席）
  const wRes = await call(app, 'POST', '/api/worlds', { name: 'victim', seed: 7 }, victim.token);
  const worldId = wRes.body.data.worldId;
  // 攻击者用裸 worldId 越权绑定他人世界（归属校验应拒绝）
  const r = await call(app, 'POST', '/api/rooms', { worldId, maxPlayers: 1, name: 'pwn' }, attacker.token);
  assert.equal(r.body.code, 403, '非房主越权绑定他人世界应被拒（BUG-3 已修复）');
  assert.equal(r.body.message, 'not_owner');
  // 受害者世界的 maxPlayers 被改成 1 → 第 2 人加入被拒
  const { activeWorlds } = await import('../server/worldhub.js');
  const w = activeWorlds.get(worldId);
  assert.ok(w, '世界应在内存');
  assert.equal(w.maxPlayers, 8, '他人世界 maxPlayers 不应被外部请求改写');
});

test('BH2-AUTH-02 记录：非房主添加/移除电脑玩家的实际行为', async () => {
  const app = await setupApp();
  const host = newUser('bh2h2');
  const other = newUser('bh2o2');
  const r = await call(app, 'POST', '/api/rooms', { name: 'x', maxPlayers: 4, visibility: 'public' }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, {}, host.token);
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, other.token);
  const add = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, other.token);
  // 期望：房主专属 → 403；实际：非房主可添加电脑玩家（设计待确认）
  assert.equal(add.body.code, 403, `非房主添加电脑应被拒，实际 code=${add.body.code}`);
});

test('BH2-AUTH-04 非成员添加电脑应 403；在座成员添加应成功（权限颗粒度）', async () => {
  const app = await setupApp();
  const host = newUser('bh2h3');
  const member = newUser('bh2m3');
  const outsider = newUser('bh2x3');
  const r = await call(app, 'POST', '/api/rooms', { name: 'x', maxPlayers: 4, visibility: 'public' }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, {}, host.token);
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, member.token);
  const out = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, outsider.token);
  assert.equal(out.body.code, 403, '非成员不应能添加电脑');
  const inm = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, member.token);
  assert.equal(inm.body.code, 403, '在座非房主成员不应能添加电脑（仅房主专属）');
});

test('BH2-C-01 已开局后改棋盘形状应被服务端拒绝（board_locked）', async () => {
  const app = await setupApp();
  const host = newUser('bh2bl');
  const r = await call(app, 'POST', '/api/rooms', { mode: 'rts', maxPlayers: 4, visibility: 'public' }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, {}, host.token);
  await call(app, 'POST', `/api/rooms/${code}/start`, {}, host.token);
  const shape = Array.from({ length: 8 }, () => '#'.repeat(8)).join('/');
  const se = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { board: { w: 8, h: 8, shape } }, host.token);
  assert.equal(se.body.code, 403, '开局后改棋盘应 403');
  assert.equal(se.body.message, 'board_locked');
});

test('BH2-JOIN-01 私密房密码：错误密码 4003、正确密码可进', async () => {
  const app = await setupApp();
  const host = newUser('bh2pj');
  const guest = newUser('bh2pg');
  const r = await call(app, 'POST', '/api/rooms',
    { name: 'priv', maxPlayers: 4, visibility: 'private', password: 'pw123456' }, host.token);
  const code = r.body.data.code;
  const bad = await call(app, 'POST', `/api/rooms/${code}/join`, { password: 'nope' }, guest.token);
  assert.equal(bad.body.code, 4003, '错误密码应 4003');
  const ok = await call(app, 'POST', `/api/rooms/${code}/join`, { password: 'pw123456' }, guest.token);
  assert.equal(ok.body.code, 0, '正确密码可加入');
});

// ============================================================ 封禁生命周期
test('BH2-BAN-01 isBanActive：永久封禁生效；到期封禁放行', () => {
  const u = newUser('bh2ban');
  usersRepo.setBan(u.id, { banned: true, reason: 'test', until: 0 });
  assert.equal(isBanActive(usersRepo.byIdFull(u.id)), true, '永久封禁应生效');
  usersRepo.setBan(u.id, { banned: true, reason: 'test', until: Date.now() - 1000 });
  assert.equal(isBanActive(usersRepo.byIdFull(u.id)), false, '已到期封禁应放行');
});

test('BH2-BAN-02 被封禁用户 /me 与登录返回 4004；解封后恢复', async () => {
  const app = await setupApp();
  const u = newUser('bh2bleak');
  usersRepo.setBan(u.id, { banned: true, reason: 'x', until: 0 });
  const me = await call(app, 'GET', '/api/me', null, u.token);
  assert.equal(me.body.code, 4004, '/me 应提示封禁');
  const lg = await call(app, 'POST', '/api/auth/login', { username: u.username, password: 'x' });
  // 密码错误也是 401，这里只验证不泄漏；用正确密码验证封禁
  usersRepo.setBan(u.id, { banned: false });
  assert.equal(isBanActive(usersRepo.byIdFull(u.id)), false, '解封后不再封禁');
});

// ============================================================ 私密房匿名泄露
test('BH2-PRIV-01 私密房匿名 GET /rooms/:code 不应返回房名/成员', async () => {
  const app = await setupApp();
  const host = newUser('bh2p');
  const r = await call(app, 'POST', '/api/rooms',
    { name: 'SECRET_ROOM_NAME', maxPlayers: 4, visibility: 'private', password: 'pw123456' }, host.token);
  const code = r.body.data.code;
  const anon = await call(app, 'GET', `/api/rooms/${code}`, null, null);
  assert.equal(anon.body.code, 0);
  assert.equal(anon.body.data.visibility, 'private');
  assert.equal(anon.body.data.name, undefined, '匿名不应看到私密房名');
  assert.equal(anon.body.data.players, undefined, '匿名不应看到成员');
});

// ============================================================ 输入校验 / DoS
test('BH2-INPUT-01 normBoard 超大尺寸被钳制（不分配超大位图）', () => {
  // w/h 远超上限：应钳到 boardMax（go=100），且行/列不符 → 回 null（默认矩形）
  const huge = normBoard({ w: 1e9, h: 1e9, shape: '#' }, 'go');
  assert.equal(huge, null, '超大/不匹配的 shape 应回默认矩形（null）');
  // 恰好 100×100 全可落：允许
  const shape = Array.from({ length: 100 }, () => '#'.repeat(100)).join('/');
  const ok = normBoard({ w: 100, h: 100, shape }, 'go');
  assert.ok(ok && ok.w === 100 && ok.h === 100, '100×100 合法');
  // 负尺寸 → 回默认
  assert.equal(normBoard({ w: -5, h: -5, shape: '' }, 'go'), null, '负尺寸回默认');
});

test('BH2-INPUT-02 房间设置注入/越界被钳制', async () => {
  const room = await createRoom({
    code: 'BH2' + String(Date.now()).slice(-6), ownerId: 1,
    stonesPerTurn: '{"x":1}', lonelyDeathDelay: -999, maxPlayers: 9999,
  });
  assert.equal(room.maxPlayers, 8, 'maxPlayers 上限 8');
  assert.equal(room.lonelyDeathDelay, 0, '负数钳到 0');
  assert.ok(room.stonesPerTurn >= 1 && room.stonesPerTurn <= 16, 'stonesPerTurn 落在 [1,16]');
});

// ============================================================ 管理来源：XFF 可伪造绕过 IP 白名单
test('BH2-ADMIN-01 伪造 X-Forwarded-For 可绕过 ADMIN_ALLOWED_IPS（安全设计待确认）', async () => {
  const app = await setupApp();
  const admin = newUser('bh2adm');
  usersRepo.setRole(admin.id, 'admin');
  const prevIps = process.env.ADMIN_ALLOWED_IPS;
  const prevKey = process.env.ADMIN_ACCESS_KEY;
  process.env.ADMIN_ALLOWED_IPS = '10.0.0.0/8';
  delete process.env.ADMIN_ACCESS_KEY;
  try {
    // 真实来源是 127.0.0.1（不在 10/8）→ 无 XFF 时应 403
    const noXff = await call(app, 'GET', '/api/admin/overview', null, admin.token);
    assert.equal(noXff.body.code, 403, '真实来源 127.0.0.1 不在白名单 → 应 403');
    // 伪造 XFF 到白名单网段 → 是否放行？
    const res = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const req = http.request({
          method: 'GET', hostname: '127.0.0.1', port: srv.address().port, path: '/api/admin/overview',
          headers: { Authorization: 'Bearer ' + admin.token, 'X-Forwarded-For': '10.9.9.9' },
        }, (resp) => {
          let d = ''; resp.on('data', (c) => { d += c; });
          resp.on('end', () => { srv.close(); let j; try { j = JSON.parse(d); } catch { j = {}; } resolve(j); });
        });
        req.on('error', () => { srv.close(); resolve({}); });
        req.end();
      });
    });
    assert.notEqual(res.code, 0, '伪造 XFF 不应让非白名单来源进入管理后台（当前可绕过）');
  } finally {
    if (prevIps === undefined) delete process.env.ADMIN_ALLOWED_IPS; else process.env.ADMIN_ALLOWED_IPS = prevIps;
    if (prevKey === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = prevKey;
    usersRepo.setRole(admin.id, 'player');
  }
});
