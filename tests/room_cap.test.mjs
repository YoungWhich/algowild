// tests/room_cap.test.mjs — 席位上限由房主设置（电脑玩家同样占席位），满席后拒绝加入
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';

await initDB();

async function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}

function newUser(name) {
  usersRepo.create(name, name + '@t', 'fakehash');
  return usersRepo.byUsername(name);
}

function tokenFor(userId, username) {
  return signToken({ id: userId, username });
}

async function call(app, method, path, body, token) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.on('listening', async () => {
      const port = server.address().port;
      try {
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({
          method, hostname: '127.0.0.1', port, path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Authorization': 'Bearer ' + token,
          },
        }, (res) => {
          let chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        if (data) req.write(data);
        req.end();
      } catch (e) { server.close(); reject(e); }
    });
  });
}

test('L4-R-cap 房主设定的席位上限（4）拒绝第 5 个加入者', async () => {
  const app = await setupApp();
  // Create 4 humans + 1 owner
  const owner = newUser('owner' + Date.now());
  const ownerToken = tokenFor(owner.id, owner.username);
  // Create world
  const worldResp = await call(app, 'POST', '/api/worlds', { name: 'test' }, ownerToken);
  const { worldId } = JSON.parse(worldResp.body).data;
  // Create room —— 房主显式设定 4 个席位（人类 + 电脑共用）
  const roomResp = await call(app, 'POST', '/api/rooms', { worldId, maxPlayers: 4 }, ownerToken);
  const { code } = JSON.parse(roomResp.body).data;

  // Owner joins first (1 human)
  const ownerJoin = await call(app, 'POST', `/api/rooms/${code}/join`, {}, ownerToken);
  assert.equal(JSON.parse(ownerJoin.body).code, 0, 'owner should join');

  // 3 more humans join — fills up to 4 seats
  for (let i = 0; i < 3; i++) {
    const u = newUser('h' + Date.now() + '_' + i);
    const t = tokenFor(u.id, u.username);
    const r = await call(app, 'POST', `/api/rooms/${code}/join`, {}, t);
    assert.equal(JSON.parse(r.body).code, 0, 'human ' + i + ' should join');
  }
  // 5th human must be rejected
  const u5 = newUser('h5_' + Date.now());
  const t5 = tokenFor(u5.id, u5.username);
  const r5 = await call(app, 'POST', `/api/rooms/${code}/join`, {}, t5);
  assert.equal(JSON.parse(r5.body).code, 4002, '5th human should be rejected with room_full');
});
