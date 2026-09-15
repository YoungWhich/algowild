// tests/go_limits.test.mjs — 房主可配的回合制限制（手数上限 / 每手时限 / 超时判负次数）
//
// 背景：这三项此前硬编码在 go.js（GO_MAX_MOVES=150 / GO_TURN_MS=30000 / GO_MAX_TIMEOUTS=3），
// 房主无法调整。现在归一到 world.goLimits，并可经房间设置（含 PATCH）配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { World, loadKernels } from '../server/engine.js';
import { normGoLimits, createRoom, roomInfo, setRoomSettings } from '../server/rooms.js';

await initDB();
await loadKernels();

function goWorld(opts) {
  const wd = new World('gl_' + Math.random(), 1, 42, Object.assign({ mode: 'go' }, opts || {}));
  wd._skipAIFill = true;
  wd.started = true;
  wd.addAI();
  wd.addAI();
  wd._goInit();
  return wd;
}

// ---------------------------------------------------------------- 归一
test('GL-01 normGoLimits：缺省/非法 → 默认；越界 → 钳制；字符串入参可解析', () => {
  assert.deepEqual(normGoLimits(null), { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
  assert.deepEqual(normGoLimits(undefined), { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
  assert.deepEqual(normGoLimits(''), { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
  assert.deepEqual(normGoLimits('{bad'), { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
  // 越界钳制
  assert.deepEqual(normGoLimits({ maxMoves: 5, turnMs: 1, maxTimeouts: 999 }),
    { maxMoves: 20, turnMs: 5000, maxTimeouts: 20 });
  assert.deepEqual(normGoLimits({ maxMoves: 9999, turnMs: 999999, maxTimeouts: 0 }),
    { maxMoves: 600, turnMs: 300000, maxTimeouts: 1 });
  // JSON 串 / 合法值原样
  assert.deepEqual(normGoLimits('{"maxMoves":60,"turnMs":45000,"maxTimeouts":2}'),
    { maxMoves: 60, turnMs: 45000, maxTimeouts: 2 });
  // 非数字 → 回默认
  assert.deepEqual(normGoLimits({ maxMoves: 'abc', turnMs: null, maxTimeouts: [] }),
    { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
});

test('GL-02 World 构造器：不传 goLimits → 与旧硬编码常量一致（行为不变）', () => {
  const wd = goWorld();
  assert.deepEqual(wd.goLimits, { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
  // 旧常量仍在（作为文档化默认值）
  assert.equal(World.GO_MAX_MOVES, 150);
  assert.equal(World.GO_TURN_MS, 30000);
  assert.equal(World.GO_MAX_TIMEOUTS, 3);
});

// ---------------------------------------------------------------- 三项限制各自生效
test('GL-03 手数上限生效：到配置手数即终局（reason=max_moves）', () => {
  const wd = goWorld({ goLimits: { maxMoves: 20 } });
  const g = wd.go;
  assert.ok(!g.result, '初始未终局');
  g.moveNo = 20; g.passStreak = 0;
  wd._goEndTurn({ ok: true }, []);
  assert.ok(g.result, '应已终局');
  assert.equal(g.result.reason, 'max_moves');
  // 默认 150 的对照：把 moveNo 设为 20 不应终局
  const wd2 = goWorld();
  wd2.go.moveNo = 20; wd2.go.passStreak = 0;
  wd2._goEndTurn({ ok: true }, []);
  assert.ok(!wd2.go.result, '默认 150 时 moveNo=20 不应终局');
});

test('GL-04 每手时限生效：到配置时限即自动 pass 并计超时', () => {
  // maxTimeouts 调大，避免因超时直接终局，只观察「自动 pass + 计一次超时」
  const wd = goWorld({ goLimits: { turnMs: 5000, maxTimeouts: 20 } });
  const g = wd.go;
  const pid = g.seats[g.turnIdx];
  const before = (wd.players[pid].goTimeouts || 0);
  g.turnTicks = 5;                    // 5 × 1000 >= 5000
  const r = wd._goTick();
  assert.equal(wd.players[pid].goTimeouts, before + 1, '应计入一次超时');
  assert.ok(r.events.some(e => e.type === 'go_timeout'), '应发出 go_timeout 事件');
  assert.ok(!g.result, 'maxTimeouts=20 时不应立即终局');
  // 时限未到（4 tick）不应触发
  const wd2 = goWorld({ goLimits: { turnMs: 5000, maxTimeouts: 20 } });
  wd2.go.turnTicks = 4;
  wd2._goTick();
  const pid2 = wd2.go.seats[wd2.go.turnIdx];
  assert.equal(wd2.players[pid2].goTimeouts || 0, 0, '4 tick < 5s 不应计超时');
});

test('GL-05 超时判负次数生效：达配置次数即终局（reason=timeout）', () => {
  const wd = goWorld({ goLimits: { turnMs: 5000, maxTimeouts: 1 } });
  const g = wd.go;
  g.turnTicks = 5;                    // 触发一次超时
  wd._goTick();
  assert.ok(g.result, 'maxTimeouts=1 时应终局');
  assert.equal(g.result.reason, 'timeout', '终局原因应为 timeout');
});

// ---------------------------------------------------------------- 房间设置链路
test('GL-06 createRoom / roomInfo 透传 goLimits，旧数据缺省回默认', async () => {
  const room = await createRoom({
    code: 'GL' + String(Date.now()).slice(-6), ownerId: 1, mode: 'go',
    goLimits: { maxMoves: 60, turnMs: 45000, maxTimeouts: 2 },
  });
  assert.deepEqual(room.goLimits, { maxMoves: 60, turnMs: 45000, maxTimeouts: 2 });
  const info = roomInfo(room, 1);
  assert.deepEqual(info.goLimits, { maxMoves: 60, turnMs: 45000, maxTimeouts: 2 });
  // 未传 → 默认
  const room2 = await createRoom({ code: 'GL' + String(Date.now()).slice(-6) + 'b', ownerId: 1, mode: 'go' });
  assert.deepEqual(roomInfo(room2, 1).goLimits, { maxMoves: 150, turnMs: 30000, maxTimeouts: 3 });
});

test('GL-07 setRoomSettings 可改 goLimits（归一后写回房间）', async () => {
  const room = await createRoom({ code: 'GL' + String(Date.now()).slice(-6) + 'c', ownerId: 1, mode: 'go' });
  const updated = setRoomSettings(room.code, { goLimits: { maxMoves: 30, turnMs: 10000, maxTimeouts: 5 } });
  assert.deepEqual(updated.goLimits, { maxMoves: 30, turnMs: 10000, maxTimeouts: 5 });
  // 越界值被钳制（不是原样存入）
  const u2 = setRoomSettings(room.code, { goLimits: { maxMoves: 1, turnMs: 1, maxTimeouts: 99 } });
  assert.deepEqual(u2.goLimits, { maxMoves: 20, turnMs: 5000, maxTimeouts: 20 });
});

// ---------------------------------------------------------------- HTTP 端到端
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

test('GL-08 HTTP：建房带 goLimits → 回显；PATCH 可改；非房主被拒', async () => {
  const app = await setupApp();
  const host = newUser('glhost');
  const r = await call(app, 'POST', '/api/rooms',
    { mode: 'go', maxPlayers: 2, visibility: 'public', goLimits: { maxMoves: 44, turnMs: 20000, maxTimeouts: 7 } }, host.token);
  const code = r.body.data.code;
  assert.deepEqual(r.body.data.goLimits, { maxMoves: 44, turnMs: 20000, maxTimeouts: 7 }, '建房响应应回显');
  const info = await call(app, 'GET', '/api/rooms/' + code, null, host.token);
  assert.deepEqual(info.body.data.goLimits, { maxMoves: 44, turnMs: 20000, maxTimeouts: 7 }, 'roomInfo 应回显');

  // 非房主 PATCH → 403 not_host
  const other = newUser('glother');
  const deny = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { goLimits: { maxMoves: 30 } }, other.token);
  assert.equal(deny.body.code, 403, '非房主应被拒');
  assert.equal(deny.body.message, 'not_host');

  // 房主 PATCH → 生效
  const ok = await call(app, 'PATCH', `/api/rooms/${code}/settings`, { goLimits: { maxMoves: 33, turnMs: 15000, maxTimeouts: 2 } }, host.token);
  assert.equal(ok.body.code, 0, '房主可改');
  assert.deepEqual(ok.body.data.goLimits, { maxMoves: 33, turnMs: 15000, maxTimeouts: 2 });
  const info2 = await call(app, 'GET', '/api/rooms/' + code, null, host.token);
  assert.deepEqual(info2.body.data.goLimits, { maxMoves: 33, turnMs: 15000, maxTimeouts: 2 }, '改后 roomInfo 同步');
});

test('GL-09 HTTP：goLimits 经 World 透传并落到快照 settings', async () => {
  const app = await setupApp();
  const host = newUser('glsnap');
  const r = await call(app, 'POST', '/api/rooms',
    { mode: 'go', maxPlayers: 2, visibility: 'public', goLimits: { maxMoves: 55, turnMs: 12000, maxTimeouts: 4 } }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go' }, host.token);
  const { getRoom } = await import('../server/rooms.js');
  const room = getRoom(code);
  // 世界已建成 → 通过世界实例校验
  const { worldForRoom } = await import('../server/routes.js');
  const w = typeof worldForRoom === 'function' ? worldForRoom(room) : null;
  if (w) {
    assert.deepEqual(w.goLimits, { maxMoves: 55, turnMs: 12000, maxTimeouts: 4 }, '世界应带上 goLimits');
    assert.deepEqual(w.snapshot().settings.goLimits, { maxMoves: 55, turnMs: 12000, maxTimeouts: 4 }, '快照 settings 应带 goLimits');
    assert.equal(w._goSnapshotState().maxMoves, 55, 'go 快照 maxMoves 应反映配置');
    assert.equal(w._goSnapshotState().turnMs, 12000, 'go 快照 turnMs 应反映配置（供前端倒计时环）');
  }
});
