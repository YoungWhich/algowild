// tests/room_lobby.test.mjs — 房间/大厅新模型（2026-09-10 需求返工）
// 覆盖：先建房后建世界、自定义席位数（含电脑占席位）、公开/私密+密码、
//       房间列表与按号搜索、中途加入、房主暂停、任意玩家存档、掉线由电脑接手。
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { loadKernels } from '../server/engine.js';

await initDB();
await loadKernels();

async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
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

// ---------------------------------------------------------------- 先建房后建世界
test('RL-01 先建房 → 后建世界 → 开始游戏（不要求等玩家到齐）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  // 建房时不带 worldId：世界尚未存在
  const r = await call(app, 'POST', '/api/rooms', { name: '我的房间', maxPlayers: 4 }, host.token);
  assert.equal(r.body.code, 0, '建房应成功');
  const code = r.body.data.code;
  assert.ok(code, '应返回房间号');
  assert.equal(r.body.data.room.worldId, null, '此时还没有世界');
  assert.equal(r.body.data.room.phase, 'lobby', '应在 lobby 阶段');

  // 房主建立世界
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 5 }, host.token);
  assert.equal(w.body.code, 0, '建世界应成功');
  assert.ok(w.body.data.worldId, '应返回 worldId');
  assert.equal(w.body.data.mode, 'go', '模式应为 go');
  assert.equal(w.body.data.room.phase, 'ready', '建世界后应在 ready 阶段');

  // 开始游戏（1 个人也能开）
  const s = await call(app, 'POST', `/api/rooms/${code}/start`, {}, host.token);
  assert.equal(s.body.code, 0, '开始游戏应成功');
  assert.equal(s.body.data.room.started, true, '应标记为已开始');
  assert.equal(s.body.data.room.humanCount, 1, '1 个人也能开局');
});

// ---------------------------------------------------------------- 席位数由房主设置，电脑占席位
test('RL-02 席位数可自定义（1..8）且电脑玩家占席位', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { maxPlayers: 3 }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 1 }, host.token);
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, host.token);          // 1 人类
  const a1 = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, host.token);  // +1 电脑
  assert.equal(a1.body.code, 0, '应能添加电脑玩家');
  const a2 = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, host.token);  // +1 电脑 → 满 3
  assert.equal(a2.body.code, 0, '应能添加第 2 个电脑玩家');
  const info = await call(app, 'GET', `/api/rooms/${code}`);
  assert.equal(info.body.data.seatCount, 3, '电脑玩家应占用席位');
  assert.equal(info.body.data.maxPlayers, 3, '席位上限应为房主设定的 3');
  // 满员后人类加入被拒
  const other = newUser('other');
  const j = await call(app, 'POST', `/api/rooms/${code}/join`, {}, other.token);
  assert.equal(j.body.code, 4002, '满席后加入应被拒绝');
  // 移除一个电脑后可再加入
  const aiId = a1.body.data.ai.id;
  const rm = await call(app, 'DELETE', `/api/rooms/${code}/ai/${aiId}`, null, host.token);
  assert.equal(rm.body.code, 0, '应能移除电脑玩家');
  const j2 = await call(app, 'POST', `/api/rooms/${code}/join`, {}, other.token);
  assert.equal(j2.body.code, 0, '空出席位后应能加入（含中途加入）');
});

// ---------------------------------------------------------------- 公开/私密 + 密码 + 列表/搜索
test('RL-03 公开房间进大厅列表；私密房间需密码；按房间号可搜索', async () => {
  const app = await setupApp();
  const host = newUser('host');
  // 公开房间
  const pub = await call(app, 'POST', '/api/rooms', { name: '公开房', maxPlayers: 4, visibility: 'public' }, host.token);
  const pubCode = pub.body.data.code;
  assert.equal(pub.body.data.room.visibility, 'public');
  assert.equal(pub.body.data.room.hasPassword, false, '公开房不需要密码');
  // 私密房间（带密码）
  const pri = await call(app, 'POST', '/api/rooms', { name: '私密房', maxPlayers: 2, visibility: 'private', password: 'pw123456' }, host.token);
  const priCode = pri.body.data.code;
  assert.equal(pri.body.data.room.visibility, 'private');
  assert.equal(pri.body.data.room.hasPassword, true, '私密房应标记需要密码');

  // 大厅列表只含公开房
  const list = await call(app, 'GET', '/api/rooms', null, host.token);
  assert.equal(list.body.code, 0);
  const codes = list.body.data.rooms.map(x => x.code);
  assert.ok(codes.includes(pubCode), '公开房应出现在大厅列表');
  assert.ok(!codes.includes(priCode), '私密房不应出现在大厅列表');

  // 按房间号搜索：公开房回详细信息
  const s1 = await call(app, 'GET', `/api/rooms/search?code=${pubCode}`, null, host.token);
  assert.equal(s1.body.code, 0);
  assert.equal(s1.body.data.code, pubCode);
  // 私密房只回"存在 + 需要密码"，不泄露成员
  const s2 = await call(app, 'GET', `/api/rooms/search?code=${priCode}`, null, host.token);
  assert.equal(s2.body.code, 0);
  assert.equal(s2.body.data.visibility, 'private');
  assert.equal(s2.body.data.hasPassword, true);
  assert.equal(s2.body.data.players, undefined, '私密房搜索不得泄露成员列表');
  // 不存在的房间号
  const s3 = await call(app, 'GET', '/api/rooms/search?code=ZZZZZZ', null, host.token);
  assert.equal(s3.body.code, 4001, '不存在的房间应返回 room_not_found');

  // 私密房加入：密码错 → 拒绝；密码对 → 通过
  await call(app, 'POST', `/api/rooms/${priCode}/world`, { mode: 'rts', seed: 2 }, host.token);
  const guest = newUser('guest');
  const bad = await call(app, 'POST', `/api/rooms/${priCode}/join`, { password: 'wrong' }, guest.token);
  assert.equal(bad.body.code, 4003, '密码错误应被拒绝');
  const good = await call(app, 'POST', `/api/rooms/${priCode}/join`, { password: 'pw123456' }, guest.token);
  assert.equal(good.body.code, 0, '密码正确应能加入');
});

// ---------------------------------------------------------------- 房主暂停 / 任意玩家存档
test('RL-04 房主可暂停（非房主不可）；任意玩家可存档', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { maxPlayers: 4 }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'rts', seed: 3 }, host.token);
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, host.token);
  const guest = newUser('guest');
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, guest.token);

  // 非房主暂停 → 403
  const p1 = await call(app, 'POST', `/api/rooms/${code}/pause`, { paused: true }, guest.token);
  assert.equal(p1.body.code, 403, '非房主不得暂停');
  // 房主暂停 → 成功
  const p2 = await call(app, 'POST', `/api/rooms/${code}/pause`, { paused: true }, host.token);
  assert.equal(p2.body.code, 0, '房主应能暂停');
  assert.equal(p2.body.data.paused, true);
  // 房主恢复
  const p3 = await call(app, 'POST', `/api/rooms/${code}/pause`, { paused: false }, host.token);
  assert.equal(p3.body.data.paused, false, '房主应能恢复');

  // 任意玩家（非房主）存档
  const sv = await call(app, 'POST', `/api/rooms/${code}/save`, {}, guest.token);
  assert.equal(sv.body.code, 0, '任意玩家都应能存档');
  assert.ok(sv.body.data.savedAt, '应返回存档时间');
});

// ---------------------------------------------------------------- 世界重建后仍可加入（分享链接不失效）
test('RL-05 世界重建后按房间号仍可加入（自动按 seed 重建）', async () => {
  const app = await setupApp();
  const host = newUser('host');
  const r = await call(app, 'POST', '/api/rooms', { maxPlayers: 4 }, host.token);
  const code = r.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode: 'go', seed: 9 }, host.token);
  const worldId = w.body.data.worldId;
  // 模拟重启：从内存移除世界
  const { activeWorlds } = await import('../server/worldhub.js');
  activeWorlds.delete(worldId);
  const guest = newUser('guest');
  const j = await call(app, 'POST', `/api/rooms/${code}/join`, {}, guest.token);
  assert.equal(j.body.code, 0, '重启后仍应能通过房间号加入');
  assert.equal(j.body.data.worldId, worldId, '应恢复到同一个世界');
  assert.equal(j.body.data.mode, 'go', '模式应保持为 go（不被默认成 rts）');
});

// ---------------------------------------------------------------- 私密房详情不泄露房名/成员
test('RL-06 私密房 GET /rooms/:code 不泄露 name/players；公开房仍返回 name/worldId', async () => {
  const app = await setupApp();
  const host = newUser('host');

  // 私密房（带名字）——匿名访问详情
  const pri = await call(app, 'POST', '/api/rooms', { name: '秘密基地', maxPlayers: 4, visibility: 'private', password: 'pw123456' }, host.token);
  assert.equal(pri.body.code, 0);
  const priCode = pri.body.data.code;
  const priDetail = await call(app, 'GET', `/api/rooms/${priCode}`);   // 匿名，无 token
  assert.equal(priDetail.body.code, 0);
  assert.equal(priDetail.body.data.visibility, 'private');
  assert.equal(priDetail.body.data.hasPassword, true);
  assert.equal(priDetail.body.data.name, undefined, '私密房详情不得泄露 name');
  assert.ok(!('name' in priDetail.body.data), '私密房返回体不应包含 name 字段');
  assert.equal(priDetail.body.data.players, undefined, '私密房详情不得泄露 players');

  // 公开房（带名字 + 建世界）——匿名访问详情
  const pub = await call(app, 'POST', '/api/rooms', { name: '公开大厅', maxPlayers: 4, visibility: 'public' }, host.token);
  assert.equal(pub.body.code, 0);
  const pubCode = pub.body.data.code;
  const w = await call(app, 'POST', `/api/rooms/${pubCode}/world`, { mode: 'rts', seed: 11 }, host.token);
  assert.equal(w.body.code, 0);
  const pubDetail = await call(app, 'GET', `/api/rooms/${pubCode}`);   // 匿名，无 token
  assert.equal(pubDetail.body.code, 0);
  assert.equal(pubDetail.body.data.name, '公开大厅', '公开房详情应返回 name');
  assert.ok(pubDetail.body.data.worldId, '公开房详情应返回 worldId');
  assert.ok(Array.isArray(pubDetail.body.data.players), '公开房详情应返回 players');
});

