// tests/bughunt2.sec.test.mjs — 第二轮排查 BUG-6 / BUG-7 的回归测试（防回归）
//
// BUG-6：管理员来源 IP 白名单原无条件信任 X-Forwarded-For（可伪造绕过）；
//        现默认 TRUST_PROXY=false → 忽略 XFF，伪造失效；设置 TRUST_PROXY=1 才信任。
// BUG-7：增删电脑玩家原为"在座即可"（非房主也能占满席位）；
//        现收紧为仅房主（hostId）专属。
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
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
let seq = 0;
function newUser(prefix) {
  const name = prefix + '_' + Date.now() + '_' + (seq++);
  usersRepo.create(name, name + '@t', 'fakehash');
  const u = usersRepo.byUsername(name);
  return { id: u.id, username: u.username, token: signToken({ id: u.id, username: u.username }) };
}
function call(app, method, path, body, token, extraHeaders) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        method, hostname: '127.0.0.1', port: srv.address().port, path,
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(extraHeaders || {}),
        },
      }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; });
        res.on('end', () => { srv.close(); let j; try { j = JSON.parse(d); } catch { j = { raw: d.slice(0, 200) }; } resolve({ status: res.statusCode, body: j }); });
      });
      req.on('error', (e) => { srv.close(); resolve({ err: String(e) }); });
      if (data) req.write(data);
      req.end();
    });
  });
}

// ============================================================ BUG-7：增删电脑仅房主
test('BH2SEC-AUTH-01 添加电脑玩家：仅房主可，在座非房主成员 403', async () => {
  const app = await setupApp();
  const host = newUser('bh2s_h');
  const member = newUser('bh2s_m');
  const r = await call(app, 'POST', '/api/rooms', { name: 'x', maxPlayers: 4, visibility: 'public' }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, {}, host.token);
  await call(app, 'POST', `/api/rooms/${code}/join`, {}, member.token);
  const addHost = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, host.token);
  assert.equal(addHost.body.code, 0, '房主可添加电脑');
  const addMember = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, member.token);
  assert.equal(addMember.body.code, 403, '在座非房主成员不应能添加电脑');
  assert.equal(addMember.body.message, 'not_host');
});

test('BH2SEC-AUTH-02 移除电脑玩家：仅房主可，非房主 403', async () => {
  const app = await setupApp();
  const host = newUser('bh2s_h2');
  const other = newUser('bh2s_o2');
  const r = await call(app, 'POST', '/api/rooms', { name: 'x', maxPlayers: 4, visibility: 'public' }, host.token);
  const code = r.body.data.code;
  await call(app, 'POST', `/api/rooms/${code}/world`, {}, host.token);
  const add = await call(app, 'POST', `/api/rooms/${code}/ai`, {}, host.token);
  const aiId = add.body.data.ai.id;
  const delOther = await call(app, 'DELETE', `/api/rooms/${code}/ai/${aiId}`, null, other.token);
  assert.equal(delOther.body.code, 403, '非房主不应能移除电脑');
  const delHost = await call(app, 'DELETE', `/api/rooms/${code}/ai/${aiId}`, null, host.token);
  assert.equal(delHost.body.code, 0, '房主可移除电脑');
});

// ============================================================ BUG-6：XFF 伪造绕过
test('BH2SEC-ADMIN-01 伪造 XFF 默认(TRUST_PROXY=false)不能绕过 IP 白名单', async () => {
  const app = await setupApp();
  const admin = newUser('bh2s_adm');
  usersRepo.setRole(admin.id, 'admin');
  const prevIps = process.env.ADMIN_ALLOWED_IPS;
  const prevKey = process.env.ADMIN_ACCESS_KEY;
  const prevTrust = process.env.TRUST_PROXY;
  process.env.ADMIN_ALLOWED_IPS = '10.0.0.0/8';
  delete process.env.ADMIN_ACCESS_KEY;
  process.env.TRUST_PROXY = '0';
  try {
    const noXff = await call(app, 'GET', '/api/admin/overview', null, admin.token);
    assert.equal(noXff.body.code, 403, '真实来源 127.0.0.1 不在白名单 → 403');
    const spoof = await call(app, 'GET', '/api/admin/overview', null, admin.token, { 'X-Forwarded-For': '10.9.9.9' });
    assert.equal(spoof.body.code, 403, '伪造 XFF 不应让非白名单来源进入后台');
  } finally {
    if (prevIps === undefined) delete process.env.ADMIN_ALLOWED_IPS; else process.env.ADMIN_ALLOWED_IPS = prevIps;
    if (prevKey === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = prevKey;
    if (prevTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prevTrust;
    usersRepo.setRole(admin.id, 'player');
  }
});

test('BH2SEC-ADMIN-02 TRUST_PROXY=1 时可信反代场景下 XFF 才会被采信', async () => {
  const app = await setupApp();
  const admin = newUser('bh2s_adm2');
  usersRepo.setRole(admin.id, 'admin');
  const prevIps = process.env.ADMIN_ALLOWED_IPS;
  const prevKey = process.env.ADMIN_ACCESS_KEY;
  const prevTrust = process.env.TRUST_PROXY;
  process.env.ADMIN_ALLOWED_IPS = '10.0.0.0/8';
  delete process.env.ADMIN_ACCESS_KEY;
  process.env.TRUST_PROXY = '1';
  try {
    const spoof = await call(app, 'GET', '/api/admin/overview', null, admin.token, { 'X-Forwarded-For': '10.9.9.9' });
    assert.equal(spoof.body.code, 0, 'TRUST_PROXY=1 时，反代注入的可信 XFF 应被采信');
  } finally {
    if (prevIps === undefined) delete process.env.ADMIN_ALLOWED_IPS; else process.env.ADMIN_ALLOWED_IPS = prevIps;
    if (prevKey === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = prevKey;
    if (prevTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prevTrust;
    usersRepo.setRole(admin.id, 'player');
  }
});
