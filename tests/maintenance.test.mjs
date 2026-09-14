// tests/maintenance.test.mjs — 账号维护：不活跃清理 + 管理员来源限制
// 覆盖：
//   1) settingsRepo 读写；阈值默认 30、归一化钳制、0=关闭
//   2) usersRepo.listInactive / purgeInactive：删超期非管理员、保留管理员与近期账号、级联
//   3) HTTP：GET /admin/maintenance、POST inactive-days、POST purge（含审计）
//   4) 来源限制：ADMIN_ALLOWED_IPS 不含回环 → admin_restricted；ADMIN_ACCESS_KEY 缺/对
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createRouter } from '../server/routes.js';
import { initDB, db, usersRepo, settingsRepo, adminRepo } from '../server/db/index.js';
import { loadKernels } from '../server/engine.js';
import {
  getInactiveDays, setInactiveDays, previewInactive, runInactivePurge,
  DEFAULT_INACTIVE_DAYS, MAX_INACTIVE_DAYS, DAY_MS,
} from '../server/maintenance.js';

await initDB();
await loadKernels();

let server, baseUrl;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', createRouter());
  server = http.createServer(app);
  await new Promise((res) => { server.listen(0, '127.0.0.1', () => res()); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { if (server) server.close(); });

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers['Authorization'] = 'Bearer ' + token; headers['x-auth-token'] = token; }
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

let seq = 0;
const uName = (p) => `${p}_${Date.now()}_${seq++}`;

// ---------------------------------------------------------------- 1) 设置读写
test('MAINT-01 settingsRepo 读写 + 阈值默认/归一化', () => {
  settingsRepo.set('__t_k', 'hello');
  assert.equal(settingsRepo.get('__t_k'), 'hello');
  assert.equal(settingsRepo.getInt('__t_missing', 7), 7);

  assert.equal(getInactiveDays(), DEFAULT_INACTIVE_DAYS, '默认阈值应为 30 天');

  assert.equal(setInactiveDays(-5), 0, '负数 → 0');
  assert.equal(setInactiveDays(999999), MAX_INACTIVE_DAYS, '超大 → 上限');
  assert.equal(setInactiveDays('abc'), DEFAULT_INACTIVE_DAYS, '非数字 → 默认');
  assert.equal(setInactiveDays(45), 45);
  assert.equal(getInactiveDays(), 45);
  setInactiveDays(DEFAULT_INACTIVE_DAYS); // 复原
});

// ---------------------------------------------------------------- 2) 关闭态
test('MAINT-02 阈值 0=关闭：preview/purge 均不动作', () => {
  setInactiveDays(0);
  const pv = previewInactive();
  assert.equal(pv.disabled, true);
  assert.deepEqual(pv.candidates, []);
  const r = runInactivePurge();
  assert.equal(r.disabled, true);
  assert.deepEqual(r.removed, []);
  setInactiveDays(DEFAULT_INACTIVE_DAYS);
});

// ---------------------------------------------------------------- 3) 纯仓储清理
test('MAINT-03 purgeInactive：删超期非管理员，保留管理员与近期账号', () => {
  const now = Date.now();
  const old = now - 100 * DAY_MS;
  const op = uName('oldplayer'), oa = uName('oldadmin'), np = uName('newplayer');
  usersRepo.create(op, null, 'x');
  usersRepo.create(oa, null, 'x');
  usersRepo.create(np, null, 'x');
  // 老玩家 / 老管理员 → 100 天前
  db().run('UPDATE users SET created_at=?, last_login=? WHERE username=?', [old, old, op]);
  db().run('UPDATE users SET created_at=?, last_login=? WHERE username=?', [old, old, oa]);
  usersRepo.setRole(usersRepo.byUsername(oa).id, 'admin');

  const before = now - 30 * DAY_MS;
  const cands = usersRepo.listInactive(before).map((r) => r.username);
  assert.ok(cands.includes(op), '老玩家应在候选');
  assert.ok(!cands.includes(oa), '管理员不应在候选（默认保留）');
  assert.ok(!cands.includes(np), '新玩家不应在候选');

  const removed = usersRepo.purgeInactive(before).map((r) => r.username);
  assert.ok(removed.includes(op), '老玩家应被删除');
  assert.ok(!removed.includes(oa), '老管理员应保留');
  assert.ok(!removed.includes(np), '新玩家应保留');
  assert.ok(!usersRepo.byUsername(op), '老玩家确实不在库中');
  assert.ok(usersRepo.byUsername(oa), '老管理员仍在库中');
});

// ---------------------------------------------------------------- 4) HTTP
let adminTok = null;
test('MAINT-04 HTTP：读取设置 / 改阈值 / 立即清理（含审计）', async () => {
  // 强制该用户名成为管理员（不依赖"首账号"）
  const name = uName('maintadmin');
  process.env.ADMIN_USERNAMES = name;
  const reg = await call('POST', '/auth/register', { username: name, password: 'password123' });
  assert.equal(reg.body.code, 0);
  assert.equal(reg.body.data.user.role, 'admin');
  adminTok = reg.body.data.token;

  // 造一个 100 天不活跃的用户
  const ghost = uName('ghost');
  usersRepo.create(ghost, null, 'x');
  const old = Date.now() - 100 * DAY_MS;
  db().run('UPDATE users SET created_at=?, last_login=? WHERE username=?', [old, old, ghost]);

  const g = await call('GET', '/admin/maintenance', null, adminTok);
  assert.equal(g.body.code, 0);
  assert.equal(typeof g.body.data.inactiveDays, 'number');
  assert.ok(g.body.data.preview.count >= 1, '应至少有 1 个待清理');

  const s = await call('POST', '/admin/maintenance/inactive-days', { days: 15 }, adminTok);
  assert.equal(s.body.code, 0);
  assert.equal(s.body.data.inactiveDays, 15);

  const p = await call('POST', '/admin/maintenance/purge', {}, adminTok);
  assert.equal(p.body.code, 0);
  assert.ok(p.body.data.removedCount >= 1, '应至少删除 1 个');
  assert.ok(p.body.data.removed.some((r) => r.username === ghost), 'ghost 应被删除');

  // 审计写入
  const acts = adminRepo.list(20).map((a) => a.action);
  assert.ok(acts.includes('purge_inactive'), '应写入 purge_inactive 审计');
  assert.ok(acts.includes('set_inactive_days'), '应写入 set_inactive_days 审计');

  // 非管理员访问 → 403 forbidden
  const p2 = uName('plain');
  const reg2 = await call('POST', '/auth/register', { username: p2, password: 'password123' });
  const bad = await call('GET', '/admin/maintenance', null, reg2.body.data.token);
  assert.equal(bad.body.code, 403);
  setInactiveDays(DEFAULT_INACTIVE_DAYS);
  delete process.env.ADMIN_USERNAMES;
});

// ---------------------------------------------------------------- 5) 来源限制：IP
test('MAINT-05 ADMIN_ALLOWED_IPS 不含本机 → admin_restricted', async () => {
  assert.ok(adminTok, '前置用例应已取得管理员 token');
  process.env.ADMIN_ALLOWED_IPS = '10.0.0.0/8';
  const r = await call('GET', '/admin/maintenance', null, adminTok);
  assert.equal(r.body.code, 403);
  assert.equal(r.body.message, 'admin_restricted');
  assert.equal(r.body.data.reason, 'ip');
  // 放开后恢复
  delete process.env.ADMIN_ALLOWED_IPS;
  const ok = await call('GET', '/admin/maintenance', null, adminTok);
  assert.equal(ok.body.code, 0, '默认（仅本机）应放行回环请求');
});

// ---------------------------------------------------------------- 6) 来源限制：密钥
test('MAINT-06 ADMIN_ACCESS_KEY：缺失 → 拒绝；带对 → 放行', async () => {
  assert.ok(adminTok);
  process.env.ADMIN_ACCESS_KEY = 's3cr3t-key';
  const miss = await call('GET', '/admin/maintenance', null, adminTok);
  assert.equal(miss.body.code, 403);
  assert.equal(miss.body.data.reason, 'key');
  const ok = await call('GET', '/admin/maintenance?adminKey=s3cr3t-key', null, adminTok);
  assert.equal(ok.body.code, 0);
  const okHdr = await fetch(`${baseUrl}/admin/maintenance`, { headers: { 'x-auth-token': adminTok, 'x-admin-key': 's3cr3t-key' } });
  assert.equal((await okHdr.json()).code, 0);
  delete process.env.ADMIN_ACCESS_KEY;
});

// ---------------------------------------------------------------- 7) 来源限制：DB 配置的密钥（随部署生效）
test('MAINT-07 DB 里配置的密钥生效（env 未设时）', async () => {
  assert.ok(adminTok);
  const k = 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  settingsRepo.set('admin_access_key', k);
  const miss = await call('GET', '/admin/maintenance', null, adminTok);
  assert.equal(miss.body.code, 403);
  assert.equal(miss.body.data.reason, 'key');
  const ok = await call('GET', '/admin/maintenance?adminKey=' + encodeURIComponent(k), null, adminTok);
  assert.equal(ok.body.code, 0);
  settingsRepo.set('admin_access_key', '');   // 复原（空值 → 回落 IP 白名单）
  const after = await call('GET', '/admin/maintenance', null, adminTok);
  assert.equal(after.body.code, 0, '清空密钥后应回到仅本机放行');
});
