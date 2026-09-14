// scripts/qa_ban_guard_probe.mjs — 回归资产（勿删）：封禁守卫覆盖面验证
// 覆盖：requireActive 覆盖的全部业务路由在「未封禁」下零回归、在「已封禁」下全部 4004；
//       公开 GET /rooms/:code 不受影响且不泄露私密房信息；cannot_target_self / cannot_ban_admin 护栏；passhash 不泄漏。
// 用临时 DB（os.tmpdir），绝不碰 server/data。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 17912;
const TMP = path.join(os.tmpdir(), 'algowild_delta_' + Date.now() + '.db');
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}${e ? ' — ' + e : ''}`); } else { fail++; console.log(`  ❌ ${n}${e ? ' — ' + e : ''}`); } };

async function j(method, p, body, token) {
  const url = BASE + '/api' + p + (token ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { code: -1, message: 'non_json' }; }
}
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
async function mkUser(tag) {
  const u = tag + '_' + uniq();
  const r = await j('POST', '/auth/register', { username: u, password: 'password123' });
  if (r.code !== 0) throw new Error('register: ' + r.message);
  return { ...r.data.user, token: r.data.token };
}

const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), DB_PATH: TMP },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
srv.stdout.on('data', (d) => { bootLog += d.toString(); });
srv.stderr.on('data', (d) => { bootLog += d.toString(); });

const stop = () => { try { srv.kill('SIGKILL'); } catch {} try { fs.unlinkSync(TMP); } catch {} };

try {
  // 等启动
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/meta'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('DB 引擎:', (bootLog.match(/\[db\][^\n]*/) || ['(未捕获)'])[0]);
  console.log('');

  const admin = await mkUser('adm');
  const player = await mkUser('ply');
  ok('首个账号是 admin', admin.role === 'admin', 'role=' + admin.role);
  ok('第二个账号是 player', player.role === 'player', 'role=' + player.role);

  // 给 player 建一个自己的房间，便于测试存档/加电脑
  const room = await j('POST', '/rooms', { maxPlayers: 4, mode: 'go' }, player.token);
  const code = room.data && room.data.code;
  const world = await j('POST', `/rooms/${code}/world`, { mode: 'go' }, player.token);
  ok('玩家自己建房+建世界正常', room.code === 0 && world.code === 0, 'code=' + code);

  // 需要登录的路由全集（16 条可 GET/POST 的；join/pause 等需世界就绪）
  const authedRoutes = [
    ['GET', '/rooms'], ['GET', '/rooms/search?code=AAAAAA'],
    ['GET', `/worlds/${world.data && world.data.worldId}`], ['GET', `/worlds/${world.data && world.data.worldId}/saves`],
    ['GET', '/scores/me'], ['GET', '/me'],
  ];

  console.log('\n【A】未封禁玩家：这些路由不得出现 4004（零回归）');
  for (const [m, p] of authedRoutes) {
    const r = await j(m, p, null, player.token);
    ok(`未封禁 ${m} ${p} 非 4004`, r.code !== 4004, 'code=' + r.code + ' ' + r.message);
  }
  const postRoom = await j('POST', '/rooms', { maxPlayers: 4, mode: 'go' }, player.token);
  ok('未封禁 POST /rooms 非 4004', postRoom.code !== 4004, 'code=' + postRoom.code);
  const addAI = await j('POST', `/rooms/${code}/ai`, {}, player.token);
  ok('未封禁 POST /rooms/:code/ai 非 4004', addAI.code !== 4004, 'code=' + addAI.code);
  const save = await j('POST', `/rooms/${code}/save`, {}, player.token);
  ok('未封禁 POST /rooms/:code/save 非 4004', save.code !== 4004, 'code=' + save.code);

  console.log('\n【B】封禁后：同样的路由必须全部 4004');
  const ban = await j('POST', `/admin/users/${player.id}/ban`, { reason: '增量验证', durationHours: 0 }, admin.token);
  ok('管理员封禁玩家成功', ban.code === 0, JSON.stringify(ban.data));
  for (const [m, p] of authedRoutes) {
    const r = await j(m, p, null, player.token);
    ok(`封禁后 ${m} ${p} → 4004`, r.code === 4004 && r.message === 'account_banned', 'code=' + r.code + ' ' + r.message);
  }
  for (const [m, p, b] of [['POST', '/rooms', { maxPlayers: 4 }], ['POST', `/rooms/${code}/ai`, {}], ['POST', `/rooms/${code}/save`, {}], ['POST', `/rooms/${code}/pause`, {}]]) {
    const r = await j(m, p, b, player.token);
    ok(`封禁后 ${m} ${p} → 4004`, r.code === 4004, 'code=' + r.code + ' ' + r.message);
  }
  const loginBan = await j('POST', '/auth/login', { username: player.username, password: 'password123' });
  ok('封禁后登录 → 4004', loginBan.code === 4004, 'code=' + loginBan.code);

  console.log('\n【C】公开接口与护栏');
  const anon = await fetch(`${BASE}/api/rooms/ZZZZZZ`);
  const anonBody = await anon.json();
  ok('公开 GET /rooms/:code 匿名可用（未被守卫波及）', anon.status === 200 && anonBody.code === 404, 'code=' + anonBody.code);
  // 设计契约：GET /rooms/:code 是匿名"邀请落地页"，无 authMiddleware；封禁态也不应被拦（它不是登录态资源）
  const pubBanned = await j('GET', `/rooms/${code}`, null, player.token);
  ok('公开 GET /rooms/:code 封禁态仍可用（设计如此，非泄漏）', pubBanned.code === 0, 'code=' + pubBanned.code);
  const privCode = await (async () => {
    const r = await j('POST', '/rooms', { maxPlayers: 4, visibility: 'private', password: 'pw123456' }, admin.token);
    return r.data && r.data.code;
  })();
  const anonPriv = await (await fetch(`${BASE}/api/rooms/${privCode}`)).json();
  ok('匿名访问私密房不泄露房间名与成员', anonPriv.code === 0 && !anonPriv.data.name && !anonPriv.data.players, JSON.stringify(anonPriv.data));
  const selfBan = await j('POST', `/admin/users/${admin.id}/ban`, { reason: 'x' }, admin.token);
  ok('封禁自己 → cannot_target_self', selfBan.message === 'cannot_target_self', selfBan.message);
  const adm2 = await mkUser('adm2');
  await j('POST', `/admin/users/${adm2.id}/role`, { role: 'admin' }, admin.token);
  const banAdmin = await j('POST', `/admin/users/${adm2.id}/ban`, { reason: 'x' }, admin.token);
  ok('封禁管理员 → cannot_ban_admin', banAdmin.message === 'cannot_ban_admin', banAdmin.message);
  const adm2Login = await j('POST', '/auth/login', { username: adm2.username, password: 'password123' });
  ok('该管理员仍可登录（未被锁死）', adm2Login.code === 0, 'code=' + adm2Login.code);
  const adm2Rights = await j('GET', '/admin/overview', null, adm2Login.data && adm2Login.data.token);
  ok('该管理员仍可访问后台', adm2Rights.code === 0, 'code=' + adm2Rights.code);

  console.log('\n【D】passhash 不再泄漏（抽查）');
  const dump = JSON.stringify([room, world, await j('GET', '/admin/users', null, admin.token), await j('GET', '/admin/actions', null, admin.token)]);
  ok('响应体不含 passhash / bcrypt 前缀', !/passhash|\$2[aby]\$/.test(dump));
} catch (e) {
  console.error('探针异常:', e);
  fail++;
} finally {
  stop();
}

console.log('\n──────────────────────────────');
console.log(`增量验证：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
