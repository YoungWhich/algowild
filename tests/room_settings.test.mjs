// tests/room_settings.test.mjs — 房间玩法设置（stonesPerTurn / lonelyDeathDelay）
//
// 冻结契约（本轮玩法返工）：
//   stonesPerTurn  : 回合制"一回合可下几颗"（1..16，默认 3）
//   lonelyDeathDelay: 无法存活的孤子"还能撑几个回合才死"（0..10，默认 0）
// 覆盖：
//   RS-01 建房时透传并在房间详情回读
//   RS-02 不传 → 默认值 3 / 0
//   RS-03 非法 / 越界值被钳制且不返回 5xx（含 POST /worlds）
//   RS-04 独立建世界（POST /worlds）后 snapshot().settings 与请求一致
//   RS-05 房间建世界后 snapshot().settings 与房间设置一致（含 lifeHits 契约）
//   RS-06 重启重建路径（内存世界移除后按 seed 重建）设置不丢
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { loadKernels } from '../server/engine.js';
import { activeWorlds } from '../server/worldhub.js';

await initDB();
await loadKernels();

async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}

// settings 现已扩展 victoryLines/victoryThresholds/availableLines（房主可配置胜利条件）；
// 本文件只关心既有两字段，故抽取后比对（保持原断言语义，不因新增字段而误报）。
function pickSettings(s) {
  return { stonesPerTurn: s.stonesPerTurn, lonelyDeathDelay: s.lonelyDeathDelay };
}

let seq = 0;
function newUser(prefix = 'u') {
  const name = prefix + '_' + Date.now() + '_' + (seq++);
  usersRepo.create(name, name + '@t', 'fakehash');
  const u = usersRepo.byUsername(name);
  return { id: u.id, username: u.username, token: signToken({ id: u.id, username: u.username }) };
}

async function call(app, method, path, body, token) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.on('listening', () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        method, hostname: '127.0.0.1', port, path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const txt = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch (e) { parsed = { raw: txt }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

// ------------------------------------------------------------------ RS-01 透传+回读
test('RS-01 建房透传 stonesPerTurn/lonelyDeathDelay 并在房间详情回读', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '设置房', maxPlayers: 4, mode: 'go',
    stonesPerTurn: 5, lonelyDeathDelay: 2,
  }, host.token);
  assert.equal(r.body.code, 0, '建房应成功');
  assert.equal(r.body.data.stonesPerTurn, 5, '响应应回显 stonesPerTurn=5');
  assert.equal(r.body.data.lonelyDeathDelay, 2, '响应应回显 lonelyDeathDelay=2');
  assert.equal(r.body.data.room.stonesPerTurn, 5, 'roomInfo 应含 stonesPerTurn=5');
  assert.equal(r.body.data.room.lonelyDeathDelay, 2, 'roomInfo 应含 lonelyDeathDelay=2');

  const code = r.body.data.code;
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, host.token);
  assert.equal(info.body.code, 0);
  assert.equal(info.body.data.stonesPerTurn, 5, '详情回读 stonesPerTurn=5');
  assert.equal(info.body.data.lonelyDeathDelay, 2, '详情回读 lonelyDeathDelay=2');
});

// ------------------------------------------------------------------ RS-02 默认值
test('RS-02 不传设置 → 默认 stonesPerTurn=3 / lonelyDeathDelay=0', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { name: '默认房', maxPlayers: 4 }, host.token);
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.stonesPerTurn, 3, '默认每回合落子数应为 3');
  assert.equal(r.body.data.lonelyDeathDelay, 0, '默认死亡宽限应为 0');

  // 独立建世界（不带设置）也应得默认值
  const w = await call(app, 'POST', '/api/worlds', { name: 'w默认', seed: 1, mode: 'go' }, host.token);
  assert.equal(w.body.code, 0);
  assert.equal(w.body.data.stonesPerTurn, 3, 'POST /worlds 默认 stonesPerTurn=3');
  assert.equal(w.body.data.lonelyDeathDelay, 0, 'POST /worlds 默认 lonelyDeathDelay=0');
});

// ------------------------------------------------------------------ RS-03 钳制不 5xx
test('RS-03 越界/非法值被钳制且不返回 5xx', async () => {
  const app = await setupApp();
  const host = newUser('host');
  // 越界：每回合 999 → 16；宽限 -5 → 0
  const r1 = await call(app, 'POST', '/api/rooms', {
    name: '越界房', maxPlayers: 4, mode: 'go',
    stonesPerTurn: 999, lonelyDeathDelay: -5,
  }, host.token);
  assert.equal(r1.status, 200, '越界不应 5xx');
  assert.equal(r1.body.code, 0);
  assert.equal(r1.body.data.stonesPerTurn, 16, '999 应被钳到上限 16');
  assert.equal(r1.body.data.lonelyDeathDelay, 0, '-5 应被钳到下限 0');

  // 非数字：应回退默认，不抛错
  const r2 = await call(app, 'POST', '/api/rooms', {
    name: '非法房', maxPlayers: 4, mode: 'go',
    stonesPerTurn: 'abc', lonelyDeathDelay: 'xyz',
  }, host.token);
  assert.equal(r2.status, 200, '非数字不应 5xx');
  assert.equal(r2.body.code, 0);
  assert.equal(r2.body.data.stonesPerTurn, 3, '非数字 stonesPerTurn → 默认 3');
  assert.equal(r2.body.data.lonelyDeathDelay, 0, '非数字 lonelyDeathDelay → 默认 0');

  // POST /worlds 同样钳制
  const r3 = await call(app, 'POST', '/api/worlds', {
    name: 'w越界', seed: 2, mode: 'go', stonesPerTurn: 100, lonelyDeathDelay: 50,
  }, host.token);
  assert.equal(r3.status, 200, 'POST /worlds 越界不应 5xx');
  assert.equal(r3.body.data.stonesPerTurn, 16, 'POST /worlds 钳到 16');
  assert.equal(r3.body.data.lonelyDeathDelay, 10, 'POST /worlds 钳到 10');

  // 字符串数字应被接受（'7' → 7）
  const r4 = await call(app, 'POST', '/api/rooms', {
    name: '字符串房', maxPlayers: 4, mode: 'go', stonesPerTurn: '7', lonelyDeathDelay: '3',
  }, host.token);
  assert.equal(r4.body.data.stonesPerTurn, 7, "字符串 '7' 应解析为 7");
  assert.equal(r4.body.data.lonelyDeathDelay, 3, "字符串 '3' 应解析为 3");
});

// ------------------------------------------------------------------ RS-04 独立建世界快照一致
test('RS-04 POST /worlds 后 snapshot().settings 与请求一致', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const w = await call(app, 'POST', '/api/worlds', {
    name: 'w设置', seed: 42, mode: 'go', stonesPerTurn: 8, lonelyDeathDelay: 4,
  }, host.token);
  assert.equal(w.body.code, 0);
  const worldId = w.body.data.worldId;
  const inst = activeWorlds.get(worldId);
  assert.ok(inst, '世界应挂到 activeWorlds');
  const snap = inst.snapshot();
  assert.deepEqual(pickSettings(snap.settings), { stonesPerTurn: 8, lonelyDeathDelay: 4 }, 'snapshot().settings 应与请求一致');
  assert.ok(Array.isArray(snap.lifeHits), 'snapshot().lifeHits 应为数组（契约）');
  // go 快照也应反映每回合可落子数
  assert.equal(snap.go.stonesPerTurn, 8, 'go.stonesPerTurn 应与设置一致');
  assert.ok(snap.go.stonesLeft <= 8 && snap.go.stonesLeft >= 0, 'go.stonesLeft 应在 0..8');
});

// ------------------------------------------------------------------ RS-05 房间建世界后一致
test('RS-05 房间建世界后 snapshot().settings 与房间设置一致', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '房设置', maxPlayers: 4, mode: 'go', stonesPerTurn: 6, lonelyDeathDelay: 3,
  }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 7 }, host.token);
  assert.equal(w.body.code, 0, '建世界应成功');
  const worldId = w.body.data.worldId;
  const inst = activeWorlds.get(worldId);
  assert.ok(inst, '世界应在 activeWorlds');
  assert.deepEqual(pickSettings(inst.snapshot().settings), { stonesPerTurn: 6, lonelyDeathDelay: 3 }, '快照设置应与房间一致');
  // 房间详情（世界为权威）也应为 6/3
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, host.token);
  assert.equal(info.body.data.stonesPerTurn, 6);
  assert.equal(info.body.data.lonelyDeathDelay, 3);
});

// ------------------------------------------------------------------ RS-06 重建不丢设置
test('RS-06 世界被移除后按 seed 重建，设置不丢', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '重建房', maxPlayers: 4, mode: 'go', stonesPerTurn: 9, lonelyDeathDelay: 5,
  }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 11 }, host.token);
  const worldId = w.body.data.worldId;

  // 模拟重启：从内存移除世界
  activeWorlds.delete(worldId);
  // 中途加入触发按房间设置重建
  const guest = newUser('guest');
  const j = await call(app, 'POST', `/api/rooms/${code}/join`, {}, guest.token);
  assert.equal(j.body.code, 0, '重启后应能加入并重建世界');
  assert.equal(j.body.data.worldId, worldId, '应恢复到同一个 worldId');
  const reborn = activeWorlds.get(worldId);
  assert.ok(reborn, '重建后的世界应在 activeWorlds');
  assert.deepEqual(pickSettings(reborn.snapshot().settings), { stonesPerTurn: 9, lonelyDeathDelay: 5 }, '重建后设置不丢');
});

// ------------------------------------------------------------------ RS-07 备用重建路径不丢设置/不污染
test('RS-07 GET /worlds/:id 不丢设置且不污染 activeWorlds（随后 /join 仍正确）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '备用重建房', maxPlayers: 4, mode: 'go', stonesPerTurn: 9, lonelyDeathDelay: 5,
  }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 21 }, host.token);
  const worldId = w.body.data.worldId;

  // 模拟重启：从内存移除世界，然后**先**走备用重建路径 GET /worlds/:id
  activeWorlds.delete(worldId);
  const snap = await call(app, 'GET', `/api/worlds/${worldId}`, null, host.token);
  assert.equal(snap.body.code, 0);
  assert.deepEqual(pickSettings(snap.body.data.settings), { stonesPerTurn: 9, lonelyDeathDelay: 5 },
    'GET /worlds/:id 重建必须带上房间设置 9/5（不得默认 3/0）');

  // 不得把默认设置的世界缓存进 activeWorlds
  const cached = activeWorlds.get(worldId);
  assert.ok(cached, '重建的世界应缓存进 activeWorlds');
  assert.deepEqual(pickSettings(cached.snapshot().settings), { stonesPerTurn: 9, lonelyDeathDelay: 5 },
    'activeWorlds 缓存不得被默认值污染');

  // 随后 /join 仍必须是 9/5（验证"先 GET /worlds/:id 再 join"不被默认值带偏）
  const guest = newUser('guest');
  const j = await call(app, 'POST', `/api/rooms/${code}/join`, {}, guest.token);
  assert.equal(j.body.code, 0, '重启后应能加入');
  assert.equal(j.body.data.worldId, worldId, '应恢复到同一世界');
  assert.deepEqual(pickSettings(activeWorlds.get(worldId).snapshot().settings), { stonesPerTurn: 9, lonelyDeathDelay: 5 },
    '/join 后设置仍为 9/5');
});

// ------------------------------------------------------------------ RS-08 四条路径一致
test('RS-08 settings 在四条路径一致（房间视图 / 大厅 / /worlds/:id / WS 快照）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', {
    name: '四路径房', maxPlayers: 4, mode: 'go', stonesPerTurn: 6, lonelyDeathDelay: 3,
  }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 31 }, host.token);
  const worldId = w.body.data.worldId;

  // ① 房间视图
  const info = await call(app, 'GET', `/api/rooms/${code}`, null, host.token);
  assert.equal(info.body.data.stonesPerTurn, 6, '① 房间视图 stonesPerTurn=6');
  assert.equal(info.body.data.lonelyDeathDelay, 3, '① 房间视图 lonelyDeathDelay=3');

  // ② 大厅列表
  const list = await call(app, 'GET', '/api/rooms', null, host.token);
  const inLobby = (list.body.data.rooms || []).find(x => x.code === code);
  assert.ok(inLobby, '② 房间应出现在大厅列表');
  assert.equal(inLobby.stonesPerTurn, 6, '② 大厅 stonesPerTurn=6');
  assert.equal(inLobby.lonelyDeathDelay, 3, '② 大厅 lonelyDeathDelay=3');

  // ③ /worlds/:id（HTTP 快照）
  const snap = await call(app, 'GET', `/api/worlds/${worldId}`, null, host.token);
  assert.deepEqual(pickSettings(snap.body.data.settings), { stonesPerTurn: 6, lonelyDeathDelay: 3 }, '③ /worlds/:id settings=6/3');

  // ④ WS 快照（WS snap 的 payload 就是 activeWorlds.snapshot()）
  assert.deepEqual(pickSettings(activeWorlds.get(worldId).snapshot().settings), { stonesPerTurn: 6, lonelyDeathDelay: 3 },
    '④ WS 快照 settings=6/3');
});
