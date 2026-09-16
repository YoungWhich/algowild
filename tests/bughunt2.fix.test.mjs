// tests/bughunt2.fix.test.mjs — 第二轮排查 5 个真 Bug 的回归测试（防回归）
//
// 每个 Bug 至少一条断言，锁定"修复后的正确行为"，避免后续改动再次引入：
//   BUG-1 畸形 dash 破坏世界 tick（NaN 污染 → 永久崩溃）
//   BUG-2 rts 军事出局未置 alive=false（满血幽灵继续参战）
//   BUG-3 POST /rooms{worldId} 无归属校验（越权篡改他人世界设置）
//   BUG-4 go 超时判负语义错（超时者反而被判胜）
//   BUG-5 go 落子坐标未校验有限整数（Infinity/浮点被静默截断）
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';

await initDB();
await loadKernels();

// ---------------------------------------------------------------- 通用 HTTP 工具
async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}
let seq = 0;
function newUser(prefix) {
  const name = prefix + '_' + Date.now() + '_' + (seq++);
  usersRepo.create(name, name + '@t', 'fakehash');
  const u = usersRepo.byUsername(name);
  return { id: u.id, username: u.username, token: signToken({ id: u.id, username: u.username }) };
}
async function call(app, method, path, body, token) {
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

function goWorld(opts) {
  const wd = new World('bh2fix_' + Math.random(), 1, 42, Object.assign({ mode: 'go' }, opts || {}));
  wd._skipAIFill = true;
  wd.started = true;
  wd.addAI();
  wd.addAI();
  wd._goInit();
  return wd;
}

// ============================================================ BUG-1: 畸形 dash 不应污染世界
test('BH2F-CRASH-01 畸形 dash(1e999→Infinity) 不污染速度/坐标，世界 tick 不崩溃', () => {
  const w = new World('bh2fix_crash', 1, 42, { mode: 'rts' });
  w.started = true;
  const a = w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  // 绕过 net 校验，直接入队畸形 payload（模拟内部路径 / 原始帧）
  w.intentQueue.push(1, { dash: { dx: 1e999, dy: 1e999 } });
  w.tickOnce();
  assert.ok(Number.isFinite(a.vx) && Number.isFinite(a.vy), `速度不应为 NaN（vx=${a.vx},vy=${a.vy}）`);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `坐标不应为 NaN（x=${a.x},y=${a.y}）`);
  assert.doesNotThrow(() => w.tickOnce(), '世界 tick 不应因畸形 payload 持续崩溃');
});

test('BH2F-CRASH-02 正常 dash 仍工作（有限 dx/dy 照常产生冲量）', () => {
  const w = new World('bh2fix_dash', 1, 42, { mode: 'rts' });
  w.started = true;
  const a = w.addPlayer(1, 'A');
  a.x = 50; a.y = 50; a.vx = 0; a.vy = 0; a.dashCharge = 1;
  w.intentQueue.push(1, { dash: { dx: 1, dy: 0 } });
  w.tickOnce();
  assert.ok(a.vx > 1, `合法 dash 应产生向右的冲量（vx=${a.vx}）`);
  assert.equal(a.dashCharge, 0, 'dash 应消耗充能');
});

// ============================================================ BUG-2: rts 军事出局后不应存活
test('BH2F-RTS-01 军事出局（deaths 达 DEATH_LIMIT）后 alive===false 且 hp===0', () => {
  const w = new World('bh2fix_rts', 1, 42, { mode: 'rts' });
  w.started = true;
  const a = w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  a.deaths = World.DEATH_LIMIT;
  a.alive = false;
  a.respawnTicks = 0;
  w.tickOnce();
  assert.equal(a.lost, true, '达死亡上限应出局');
  assert.equal(a.alive, false, '出局者不应仍存活');
  assert.equal(a.hp, 0, '出局者 hp 应为 0（无满血幽灵）');
});

// ============================================================ BUG-3: 越权绑定/篡改他人世界
test('BH2F-AUTH-01 非房主 POST /rooms{worldId} → 403 not_owner 且不改写他人世界设置', async () => {
  const app = await setupApp();
  const victim = newUser('bh2fvic');
  const attacker = newUser('bh2fatk');
  const wRes = await call(app, 'POST', '/api/worlds', { name: 'victim', seed: 7 }, victim.token);
  const worldId = wRes.body.data.worldId;
  // 攻击者越权尝试绑定并篡改 maxPlayers
  const r = await call(app, 'POST', '/api/rooms', { worldId, maxPlayers: 1, name: 'pwn' }, attacker.token);
  assert.equal(r.body.code, 403, '非房主应被拒（403）');
  assert.equal(r.body.message, 'not_owner');
  const { activeWorlds } = await import('../server/worldhub.js');
  const w = activeWorlds.get(worldId);
  assert.ok(w, '世界应在内存');
  assert.equal(w.maxPlayers, 8, '他人世界 maxPlayers 不应被改写');
  // 房主绑定应成功
  const ok = await call(app, 'POST', '/api/rooms', { worldId }, victim.token);
  assert.equal(ok.body.code, 0, '房主绑定自己的世界应成功');
});

// ============================================================ BUG-4: go 超时判负语义
test('BH2F-GO-01 累计超时达上限者不应获胜（即使数子分更高）', () => {
  const wd = new World('bh2fix_to', 1, 42, { mode: 'go', goLimits: { turnMs: 5000, maxTimeouts: 1 } });
  wd._skipAIFill = true;
  wd.started = true;
  wd.addAI();
  wd.addAI();
  wd._goInit();
  const g = wd.go;
  const f0 = g.seatF[0], f1 = g.seatF[1];
  // seat0（先手）密集铺满整盘 → 数子分碾压；seat1 只放角落一子
  for (let x = 0; x < 32; x += 2) for (let y = 0; y < 32; y += 2) wd._life[x][y] = f0;
  wd._life[31][31] = f1;
  // seat0 累计超时达上限
  wd.players[g.seats[0]].goTimeouts = 1;
  wd._goEndTurn({ ok: true }, []);
  assert.ok(g.result, '应已终局');
  assert.equal(g.result.reason, 'timeout', '终局原因应为 timeout');
  assert.notEqual(g.result.winner, g.seats[0], '超时者不应被判胜');
  assert.equal(wd.players[g.seats[0]].lost, true, '超时者应被判负（剥出胜者池）');
});

// ============================================================ BUG-5: go 落子坐标校验
test('BH2F-GO-02 落子坐标 Infinity/浮点被拒；合法整数正常', () => {
  const wd = goWorld();
  const g = wd.go;
  const pid = g.seats[g.turnIdx];
  const before = wd._life[0][0];
  const rInf = wd.applyGoIntent(pid, { lx: 1e999, ly: 0 }, []);
  assert.equal(rInf.ok, false, '非有限坐标应被拒绝');
  assert.equal(wd._life[0][0], before, '(0,0) 不应被落子');
  const rFloat = wd.applyGoIntent(pid, { lx: 3.7, ly: 4.2 }, []);
  assert.equal(rFloat.ok, false, '浮点坐标应被拒绝');
  // 合法整数照常落子
  const rOk = wd.applyGoIntent(pid, { lx: 5, ly: 6 }, []);
  assert.equal(rOk.ok, true, '合法整数应可落子');
});

test('BH2F-GO-03 moves[] 批量路径同样拒绝非整数坐标', () => {
  const wd = goWorld();
  const g = wd.go;
  const pid = g.seats[g.turnIdx];
  const r = wd.applyGoIntent(pid, { moves: [{ lx: 1e999, ly: 0 }] }, []);
  assert.equal(r.ok, false, '批量路径非有限坐标应被拒绝');
  assert.equal(r.reason, 'bad_move');
});
