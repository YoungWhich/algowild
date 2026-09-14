// tests/api.test.mjs — L4 REST + Auth 测试（启 in-process server）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initDB, dbType_ } from '../server/db/index.js';
import { loadKernels } from '../server/engine.js';
import { createRouter } from '../server/routes.js';
import express from 'express';

let baseUrl, server;

test.before(async () => {
  await initDB();
  await loadKernels();
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', createRouter());
  await new Promise((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api`;
      res();
    });
  });
});

test.after(() => {
  if (server) server.close();
});

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

test('L4-A-01 注册新用户', async () => {
  const u = `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const r = await call('POST', '/auth/register', { username: u, password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 0);
  assert.ok(r.body.data.token);
  assert.equal(r.body.data.user.username, u);
});

test('L4-A-02 重复名 409', async () => {
  const u = `dup_${Date.now()}`;
  await call('POST', '/auth/register', { username: u, password: 'password123' });
  const r = await call('POST', '/auth/register', { username: u, password: 'password123' });
  assert.equal(r.body.code, 409);
});

test('L4-A-03 弱口令 400', async () => {
  const r = await call('POST', '/auth/register', { username: 'weak', password: '1' });
  assert.equal(r.body.code, 400);
});

test('L4-A-04 登录 + 错误密码', async () => {
  const u = `lg_${Date.now()}`;
  await call('POST', '/auth/register', { username: u, password: 'password123' });
  const ok1 = await call('POST', '/auth/login', { username: u, password: 'password123' });
  assert.equal(ok1.body.code, 0);
  const ok2 = await call('POST', '/auth/login', { username: u, password: 'wrong' });
  assert.equal(ok2.body.code, 401);
});

test('L4-A-05 me 鉴权', async () => {
  const u = `me_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const me = await call('GET', '/me', null, reg.body.data.token);
  assert.equal(me.body.code, 0);
  assert.equal(me.body.data.username, u);
  const me2 = await call('GET', '/me');
  assert.equal(me2.body.code, 401);
});

test('L4-A-06 logout', async () => {
  const r = await call('POST', '/auth/logout');
  assert.equal(r.body.code, 0);
});

test('L4-W-07 建世界', async () => {
  const u = `w_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const r = await call('POST', '/worlds', { name: 'test', seed: 42 }, reg.body.data.token);
  assert.equal(r.body.code, 0);
  assert.ok(r.body.data.worldId);
});

test('L4-W-08 拿世界摘要', async () => {
  const u = `g_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const w = await call('POST', '/worlds', { name: 't', seed: 1 }, reg.body.data.token);
  const r = await call('GET', `/worlds/${w.body.data.worldId}`, null, reg.body.data.token);
  assert.equal(r.body.code, 0);
  assert.ok(r.body.data.tick >= 0);
});

test('L4-S-09 存档', async () => {
  const u = `s_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const w = await call('POST', '/worlds', { name: 't', seed: 1 }, reg.body.data.token);
  const r = await call('POST', `/worlds/${w.body.data.worldId}/save`, null, reg.body.data.token);
  assert.equal(r.body.code, 0);
  const list = await call('GET', `/worlds/${w.body.data.worldId}/saves`, null, reg.body.data.token);
  assert.equal(list.body.code, 0);
});

test('L4-Sc-11 分数', async () => {
  const u = `sc_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const w = await call('POST', '/worlds', { name: 't', seed: 1 }, reg.body.data.token);
  const r = await call('POST', '/scores', { worldId: w.body.data.worldId, score: 100 }, reg.body.data.token);
  assert.equal(r.body.code, 0);
  const list = await call('GET', '/scores/me', null, reg.body.data.token);
  assert.equal(list.body.code, 0);
});

test('L4-R-13 建房间', async () => {
  const u = `r_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const w = await call('POST', '/worlds', { name: 't', seed: 1 }, reg.body.data.token);
  const r = await call('POST', '/rooms', { worldId: w.body.data.worldId }, reg.body.data.token);
  assert.equal(r.body.code, 0);
  assert.ok(r.body.data.code);
  const room = await call('GET', `/rooms/${r.body.data.code}`);
  assert.equal(room.body.code, 0);
});

test('L4-META meta', async () => {
  const r = await call('GET', '/meta');
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.kernels, 46);
  assert.equal(r.body.data.emergents, 14);
});

test('L4-R-14 房间可分享永久链接：按码查询+加入+重启后仍可重连', async () => {
  const u = `rl_${Date.now()}`;
  const reg = await call('POST', '/auth/register', { username: u, password: 'password123' });
  const w = await call('POST', '/worlds', { name: 't', seed: 7 }, reg.body.data.token);
  const r = await call('POST', '/rooms', { worldId: w.body.data.worldId }, reg.body.data.token);
  assert.equal(r.body.code, 0);
  const code = r.body.data.code;
  assert.ok(r.body.data.invitePath && r.body.data.invitePath.includes('?room=' + code), '应返回可分享链接路径');
  // 公开按码查询
  const info = await call('GET', `/rooms/${code}`);
  assert.equal(info.body.code, 0);
  assert.equal(info.body.data.worldId, w.body.data.worldId);
  // 加入
  const join = await call('POST', `/rooms/${code}/join`, null, reg.body.data.token);
  assert.equal(join.body.code, 0);
  assert.equal(join.body.data.worldId, w.body.data.worldId);
  // 模拟重启：从内存清掉世界，再用同一链接加入应自动按 seed 重建
  const { activeWorlds } = await import('../server/worldhub.js');
  activeWorlds.delete(w.body.data.worldId);
  const rejoin = await call('POST', `/rooms/${code}/join`, null, reg.body.data.token);
  assert.equal(rejoin.body.code, 0, '重启后仍应能通过链接进入（自动重建世界）');
  assert.equal(rejoin.body.data.worldId, w.body.data.worldId);
});

test('L4-DB db 回退路径', () => {
  assert.ok(['better', 'node:sqlite'].includes(dbType_()));
});