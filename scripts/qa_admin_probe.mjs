// scripts/qa_admin_probe.mjs
// 独立验证：玩家管理后台（管理员控制台）——攻击者 + 运维双视角。
//
// 铁律：
//   - 不修改任何实现代码；本文件是唯一的产出。
//   - 起**真实服务**（PORT=17911），DB_PATH → 临时文件库；跑完清理。
//   - REST 一律用 ?token= 查询参数带 token（部署反代会劫持 Authorization）。
//   - 每项输出 ✅/❌ + 实测证据。
//
// 运行： node scripts/qa_admin_probe.mjs

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admin-'));
const DBPATH = path.join(TMP, 'qa_admin.db');
const DATA_DIR = path.join(ROOT, 'server', 'data');
const PORT_MAIN = 17911;
const PORT_ENV = 17912;
const PORT_ENGINE = 17913;

const results = [];
const findings = [];
let hardFail = 0;

function rec(ok, id, label, evidence = '') {
  const line = `${ok ? '✅' : '❌'} [${id}] ${label}${evidence ? ' — ' + evidence : ''}`;
  console.log(line);
  results.push({ ok, id, label, evidence });
  if (!ok) hardFail++;
}
function finding(sev, title, repro, expected, actual, impact) {
  findings.push({ sev, title, repro, expected, actual, impact });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP
const BASE = `http://127.0.0.1:${PORT_MAIN}`;
async function api(method, p, { token, body, headers, raw } = {}) {
  let url = BASE + '/api' + p;
  if (token && !raw) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  const r = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let text = '';
  try { text = await r.text(); } catch { text = ''; }
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}

// ------------------------------------------------------------------ SQL 直查
async function sqlAll(sql, params = []) {
  for (let i = 0; i < 60; i++) {
    let d;
    try { d = new DatabaseSync(DBPATH); const rows = [...d.prepare(sql).all(...params)]; d.close(); return rows; }
    catch (e) { try { d && d.close(); } catch {} if (/busy|locked/i.test(String(e.message)) && i < 59) { await sleep(50); continue; } throw e; }
  }
}
async function sqlGet(sql, params = []) { const r = await sqlAll(sql, params); return r[0] || null; }
async function sqlRun(sql, params = []) {
  for (let i = 0; i < 60; i++) {
    let d;
    try { d = new DatabaseSync(DBPATH); d.prepare(sql).run(...params); d.close(); return true; }
    catch (e) { try { d && d.close(); } catch {} if (/busy|locked/i.test(String(e.message)) && i < 59) { await sleep(50); continue; } throw e; }
  }
}

// ------------------------------------------------------------------ server 进程
function startServer({ port, dbPath, adminUsernames, label }) {
  return new Promise(async (resolve, reject) => {
    const env = { ...process.env, PORT: String(port), JWT_SECRET: 'qa-probe-secret' };
    if (dbPath) env.DB_PATH = dbPath; else delete env.DB_PATH;
    if (adminUsernames) env.ADMIN_USERNAMES = adminUsernames; else delete env.ADMIN_USERNAMES;
    const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    proc.stdout.on('data', (d) => { logs += d.toString(); });
    proc.stderr.on('data', (d) => { logs += d.toString(); });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) { reject(new Error(`[${label}] exited ${proc.exitCode}:\n${logs}`)); return; }
      try { const r = await fetch(base + '/healthz'); if (r.ok) { const j = await r.json(); resolve({ proc, base, logs: () => logs, health: j }); return; } } catch {}
      await sleep(250);
    }
    reject(new Error(`[${label}] not reachable in time:\n${logs}`));
  });
}
async function stopServer(s) {
  if (!s || !s.proc || s.proc.exitCode != null) return;
  await new Promise((res) => {
    s.proc.once('exit', res);
    try { s.proc.kill(); } catch {}
    setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch {} res(); }, 3000);
  });
}

// ------------------------------------------------------------------ WS
function wsHello(port, token, worldId, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = []; let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', data: { token, worldId } })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      msgs.push(m);
      if (m.type === 'snap') done({ ws, msgs, gotSnap: true });
    });
    ws.on('error', () => done({ ws, msgs, gotSnap: false }));
    ws.on('close', () => done({ ws, msgs, gotSnap: false }));
    setTimeout(() => done({ ws, msgs, gotSnap: false }), timeoutMs);
  });
}
function waitClose(ws, ms) {
  return new Promise((resolve) => {
    let done = false;
    const f = (code, reason) => { if (!done) { done = true; resolve({ code, reason: String(reason || '') }); } };
    ws.on('close', f);
    ws.on('error', () => f(-1, 'error'));
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
  });
}

// ------------------------------------------------------------------ 账号
let seq = 0;
const uniq = Date.now().toString(36);
function nm(tag) { return `${tag}_${uniq}_${seq++}`; }
async function register(tag) {
  const username = nm(tag);
  const r = await api('POST', '/auth/register', { body: { username, password: 'password123' } });
  if (!r.json || r.json.code !== 0) throw new Error('register failed: ' + r.text);
  return { id: r.json.data.user.id, username, role: r.json.data.user.role, token: r.json.data.token };
}
async function login(username, password = 'password123') {
  return api('POST', '/auth/login', { body: { username, password } });
}

// ==================================================================
// 主流程
// ==================================================================
let mainSrv = null;
let envSrv = null;
const cleanupFns = [];
let P = null; // 主要账号上下文

async function section1_permissions() {
  console.log('\n========== 1) 权限边界 ==========');
  const admin = P.admin, player = P.player;
  const pid = player.id;
  const endpoints = [
    ['GET', '/admin/overview'],
    ['GET', '/admin/users'],
    ['GET', `/admin/users/${pid}`],
    ['GET', '/admin/rooms'],
    ['GET', '/admin/actions'],
    ['POST', `/admin/users/${pid}/ban`],
    ['POST', `/admin/users/${pid}/unban`],
    ['POST', `/admin/users/${pid}/role`],
    ['POST', `/admin/users/${pid}/kick`],
    ['DELETE', `/admin/users/${pid}`],
    ['POST', '/admin/rooms/AAAAAA/close'],
  ];
  // player token → 403
  let all403 = true, ev = [];
  for (const [m, p] of endpoints) {
    const r = await api(m, p, { token: player.token, body: m === 'GET' ? undefined : {} });
    if (!(r.status === 403 && r.json && r.json.code === 403)) { all403 = false; ev.push(`${m} ${p}→${r.status}/${r.json && r.json.code}`); }
  }
  rec(all403, 'P1.1', `player token 访问全部 ${endpoints.length} 个 /api/admin/* 端点 → 全部 403`, ev.length ? ev.join('; ') : `all ${endpoints.length} = 403`);

  // 无 token → 401
  let all401 = true; ev = [];
  for (const [m, p] of endpoints) {
    const r = await api(m, p, { body: m === 'GET' ? undefined : {} });
    if (!(r.status === 401 && r.json && r.json.code === 401)) { all401 = false; ev.push(`${m} ${p}→${r.status}`); }
  }
  rec(all401, 'P1.2', '无 token → 全部 401', ev.length ? ev.join('; ') : `all ${endpoints.length} = 401`);

  // 无效 token → 401
  let all401b = true; ev = [];
  for (const [m, p] of endpoints) {
    const r = await api(m, p, { token: 'this.is.not.a.jwt', body: m === 'GET' ? undefined : {} });
    if (!(r.status === 401 && r.json && r.json.code === 401)) { all401b = false; ev.push(`${m} ${p}→${r.status}`); }
  }
  rec(all401b, 'P1.3', '无效 token → 全部 401', ev.length ? ev.join('; ') : `all ${endpoints.length} = 401`);

  // 被删除用户的旧 token（曾是 player）→ 403，不得 500
  const ghost = await register('ghost');
  const del = await api('DELETE', `/admin/users/${ghost.id}`, { token: admin.token, body: { confirmUsername: ghost.username } });
  rec(del.json && del.json.code === 0, 'P1.4a', '管理员删除普通用户 ghost 成功', `code=${del.json && del.json.code}`);
  const gr = await api('GET', '/admin/users', { token: ghost.token });
  rec(gr.status === 403, 'P1.4b', '已删除用户的旧 token 访问 /admin/users → 403（非 500）', `status=${gr.status} code=${gr.json && gr.json.code}`);
  if (!(gr.status === 403)) finding('MEDIUM', '已删除用户旧 token 访问管理端点未返回 403',
    'register→admin delete→用旧 token GET /admin/users', '403', `实际 ${gr.status}`, '异常路径可能泄漏信息或 500');

  // 管理员 token 正常工作（正例对照）
  const ov = await api('GET', '/admin/overview', { token: admin.token });
  rec(ov.json && ov.json.code === 0, 'P1.5', 'admin token 正常访问 /admin/overview', `code=${ov.json && ov.json.code}`);

  // 多通道取 token（anti-hijack）：三通道各自可用，且 ?token= 优先于 Authorization
  const cQ = await api('GET', '/admin/overview', { token: admin.token });
  rec(cQ.json && cQ.json.code === 0, 'P1.6', '仅 ?token= 通道可用', `code=${cQ.json && cQ.json.code}`);
  const cH = await api('GET', '/admin/overview', { raw: true, headers: { 'x-auth-token': admin.token } });
  rec(cH.json && cH.json.code === 0, 'P1.7', '仅 x-auth-token 通道可用', `code=${cH.json && cH.json.code}`);
  const cA = await api('GET', '/admin/overview', { raw: true, headers: { Authorization: 'Bearer ' + admin.token } });
  rec(cA.json && cA.json.code === 0, 'P1.8', '仅 Authorization 通道可用（回退）', `code=${cA.json && cA.json.code}`);
  // 关键：?token= 有效 + Authorization 被反代注入无效值 → 必须仍成功
  const cMix = await api('GET', '/admin/overview?token=' + encodeURIComponent(admin.token), { raw: true, headers: { Authorization: 'Bearer HIJACKED_BY_PROXY' } });
  rec(cMix.json && cMix.json.code === 0, 'P1.9', '?token= 有效 + Authorization 被劫持 → 仍成功（查询参数优先，反代劫持免疫）', `code=${cMix.json && cMix.json.code}`);
  if (!(cMix.json && cMix.json.code === 0)) finding('HIGH', '多通道取 token 未让查询参数优先', 'Authorization 注入无效值 + 有效 ?token=', 'code 0', '被拒', '反代劫持 Authorization 时管理员无法使用后台');
}

async function section2_bootstrap() {
  console.log('\n========== 2) 引导路径 ==========');
  rec(P.admin.role === 'admin', 'P2.1', '空库第一个注册账号 role===admin', `role=${P.admin.role} id=${P.admin.id}`);
  rec(P.player.role === 'player', 'P2.2', '空库第二个注册账号 role===player', `role=${P.player.role}`);
  // 登录带回 role
  const lg = await login(P.admin.username);
  rec(lg.json && lg.json.data && lg.json.data.user.role === 'admin', 'P2.3', '登录响应携带正确 role', `role=${lg.json && lg.json.data && lg.json.data.user.role}`);

  // server B: ADMIN_USERNAMES 强制（非第一个）
  const b1 = await registerOn(PORT_ENV, 'firstone');   // 第一个 → bootstrap admin
  const b2 = await registerOn(PORT_ENV, 'forced_admin', 'forced_admin'); // 第二个，用户名与 env 完全一致 → 靠 ADMIN_USERNAMES 命中
  rec(b1.role === 'admin', 'P2.4', '[ADMIN_USERNAMES] 第一个账号仍是 admin（bootstrap）', `role=${b1.role}`);
  rec(b2.role === 'admin', 'P2.5', '[ADMIN_USERNAMES] 第二个账号命中环境变量 → admin（尽管不是第一个）', `role=${b2.role}`);
  if (b2.role !== 'admin') finding('HIGH', 'ADMIN_USERNAMES 引导失效', 'ADMIN_USERNAMES=forced_admin 启动，注册 forced_admin 为第二个账号', 'role=admin', `role=${b2.role}`, '无法按环境变量授予管理员');
}

async function registerOn(port, tag, exactUsername) {
  const username = exactUsername || nm(tag);
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }),
  });
  const j = await r.json();
  if (!j || j.code !== 0) throw new Error('registerOn failed: ' + JSON.stringify(j));
  return { id: j.data.user.id, username, role: j.data.user.role, token: j.data.token };
}
async function apiOn(port, method, p, { token, body, headers } = {}) {
  let url = `http://127.0.0.1:${port}/api` + p;
  if (token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let text = ''; try { text = await r.text(); } catch {}
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function section3_ban_chain() {
  console.log('\n========== 3) 封禁全链路 ==========');
  const admin = P.admin;
  // 目标：自己建房建世界并 WS 连上
  const victim = await register('banned_target');
  const room = await api('POST', '/rooms', { token: victim.token, body: { name: 'qa-ban-room', maxPlayers: 4, mode: 'rts' } });
  const code = room.json.data.code;
  const wr = await api('POST', `/rooms/${code}/world`, { token: victim.token, body: {} });
  const worldId = wr.json.data.worldId;
  const jn = await api('POST', `/rooms/${code}/join`, { token: victim.token, body: {} });
  rec(jn.json && jn.json.code === 0, 'P3.1', '目标用户成功加入世界（建房→建世界→join）', `worldId=${worldId}`);

  const conn = await wsHello(PORT_MAIN, victim.token, worldId);
  rec(conn.gotSnap, 'P3.2', '目标用户真实 WS 连接 hello 并收到 snap', `msgs=${conn.msgs.map((m) => m.type).join(',')}`);
  if (!conn.gotSnap) { finding('HIGH', '目标用户无法建立 WS 会话（封禁测试前置失败）', 'hello', 'snap', conn.msgs.map((m) => m.type).join(','), '无法验证实时踢下线'); return; }

  // overview 在线包含该用户
  const ov = await api('GET', '/admin/overview', { token: admin.token });
  const onlineIds = (ov.json.data.onlineUsers || []).map((u) => u.id);
  rec(onlineIds.includes(victim.id), 'P3.3', 'overview.onlineUsers 包含已连接目标用户', `onlineIds=[${onlineIds.join(',')}] victim=${victim.id}`);

  // 封禁 —— 断言活跃 WS 被真实关闭（4004）
  const closeP = waitClose(conn.ws, 4000);
  const ban = await api('POST', `/admin/users/${victim.id}/ban`, { token: admin.token, body: { reason: 'QA 封禁', durationHours: 0 } });
  rec(ban.json && ban.json.code === 0 && ban.json.data.banned === true, 'P3.4', '管理员封禁成功', `kicked=${ban.json && ban.json.data && ban.json.data.kicked}`);
  const cc = await closeP;
  rec(!!cc && cc.code === 4004, 'P3.5', '封禁后该 WS 会话被真实关闭且 close code=4004', cc ? `code=${cc.code} reason="${cc.reason}"` : '超时未关闭（仅新连接被拒 ≠ 踢下线）');
  if (!cc || cc.code !== 4004) finding('CRITICAL', '封禁未真正踢断在线 WS 会话', '先 WS 连上→admin POST ban', 'close code 4004', cc ? `code=${cc.code}` : '未关闭', '被封禁玩家可继续在线游玩');
  rec(ban.json && ban.json.data && ban.json.data.kicked >= 1, 'P3.6', '封禁返回 kicked>=1（真实关闭连接数）', `kicked=${ban.json && ban.json.data && ban.json.data.kicked}`);

  // 封禁后旧 token 打受保护端点
  const me = await api('GET', '/me', { token: victim.token });
  rec(me.json && me.json.code === 4004, 'P3.7', '封禁后旧 token GET /api/me → 4004', `code=${me.json && me.json.code}`);
  const join2 = await api('POST', `/rooms/${code}/join`, { token: victim.token, body: {} });
  rec(join2.json && join2.json.code === 4004, 'P3.8', '封禁后旧 token POST /api/rooms/:code/join → 4004', `code=${join2.json && join2.json.code}`);
  const mkWorld = await api('POST', '/worlds', { token: victim.token, body: { name: 'nope' } });
  rec(mkWorld.json && mkWorld.json.code === 4004, 'P3.9', '封禁后旧 token POST /api/worlds → 4004', `code=${mkWorld.json && mkWorld.json.code}`);
  if (!(me.json && me.json.code === 4004) || !(join2.json && join2.json.code === 4004) || !(mkWorld.json && mkWorld.json.code === 4004))
    finding('HIGH', '封禁未在旧 token 的受保护端点上生效', 'ban 后旧 token 调 me/join/worlds', '4004', `${me.json && me.json.code}/${join2.json && join2.json.code}/${mkWorld.json && mkWorld.json.code}`, '被封禁玩家用旧 token 继续游戏');
  // 登录也被拒
  const lg = await login(victim.username);
  rec(lg.json && lg.json.code === 4004, 'P3.10', '封禁后登录 → 4004 account_banned', `code=${lg.json && lg.json.code} msg=${lg.json && lg.json.message}`);

  // 落库字段
  const row = await sqlGet('SELECT banned, ban_reason, banned_at, banned_until FROM users WHERE id=?', [victim.id]);
  rec(row.banned === 1 && row.ban_reason === 'QA 封禁' && row.banned_until === 0 && row.banned_at > 0,
    'P3.11', '封禁记录落库正确（banned=1/reason/banned_until=0 永久）', JSON.stringify(row));
  if (!(row.banned === 1 && row.ban_reason === 'QA 封禁'))
    finding('MEDIUM', '封禁字段未正确落库', 'POST ban reason=QA 封禁', 'banned=1 ban_reason=QA 封禁', JSON.stringify(row), '审计/展示失真');

  // 封禁守卫覆盖面扫描（非必需但重要）
  // 说明：GET /api/rooms/:code 是**公开**房间号查询（服务端该路由无鉴权，见 routes.js 定义），
  //       封禁态仍可读属设计取舍（与 qa_ban_guard_probe 结论一致），不参与"缺口"判定。
  const PUBLIC_BY_DESIGN = new Set(['GET /api/rooms/:code']);
  const others = {
    'GET /api/rooms': ['GET', '/rooms'],
    'GET /api/rooms/:code': ['GET', `/rooms/${code}`],
    'GET /api/scores/me': ['GET', '/scores/me'],
    'GET /api/worlds/:id': ['GET', `/worlds/${worldId}`],
    'POST /api/rooms/:code/save': ['POST', `/rooms/${code}/save`],
    'POST /api/rooms/:code/ai': ['POST', `/rooms/${code}/ai`],
  };
  const gapList = [];
  for (const [label, [m, p]] of Object.entries(others)) {
    if (PUBLIC_BY_DESIGN.has(label)) continue;   // 公开端点：封禁态可读，属设计
    const r = await api(m, p, { token: victim.token, body: m === 'GET' ? undefined : {} });
    if (!(r.json && r.json.code === 4004)) gapList.push(`${label}→${r.json && r.json.code}`);
  }
  console.log(`   [info] 封禁守卫缺口扫描（未被 ban 拦截的私密/写端点）: ${gapList.length ? gapList.join('; ') : '无'}`);
  console.log(`   [info] 公开端点（设计允许封禁态读取）: ${[...PUBLIC_BY_DESIGN].join(', ')}`);
  if (gapList.length) finding('LOW', '部分 /api 端点未做封禁守卫（不影响进入游戏，但封禁语义不彻底）',
    'ban 后用旧 token 调这些端点', '4004', gapList.join('; '), '被封禁用户仍可读写大厅/快照/存档');

  // unban 后恢复
  await api('POST', `/admin/users/${victim.id}/unban`, { token: admin.token, body: {} });
  const me2 = await api('GET', '/me', { token: victim.token });
  rec(me2.json && me2.json.code === 0, 'P3.12', '解封后旧 token GET /api/me 恢复 code 0', `code=${me2.json && me2.json.code}`);
  P.banVictim = { ...victim, roomCode: code, worldId };
  return victim.id;
}

async function section4_timed_ban() {
  console.log('\n========== 4) 定时封禁语义 ==========');
  const admin = P.admin;
  const u = await register('timed');
  const before = Date.now();
  const ban = await api('POST', `/admin/users/${u.id}/ban`, { token: admin.token, body: { reason: '1h', durationHours: 1 } });
  const row = await sqlGet('SELECT banned, banned_until FROM users WHERE id=?', [u.id]);
  const delta = row.banned_until - before;
  rec(row.banned === 1 && delta > 3500 * 1000 && delta < 3700 * 1000,
    'P4.1', 'durationHours=1 → banned_until 为未来 ~1 小时', `banned_until-now=${Math.round(delta / 1000)}s`);
  if (!(delta > 3500 * 1000 && delta < 3700 * 1000))
    finding('HIGH', '定时封禁 banned_until 计算错误', 'durationHours=1', '≈+3600s', `${Math.round(delta / 1000)}s`, '封禁时长错误');

  // 直接把库中 banned_until 改成过去 → 应自动放行（证明判定不只看标志位）
  await sqlRun('UPDATE users SET banned_until=? WHERE id=?', [Date.now() - 5000, u.id]);
  const stillFlag = await sqlGet('SELECT banned, banned_until FROM users WHERE id=?', [u.id]);
  const me = await api('GET', '/me', { token: u.token });
  const lg = await login(u.username);
  rec(stillFlag.banned === 1 && me.json && me.json.code === 0 && lg.json && lg.json.code === 0,
    'P4.2', '到期后自动放行（banned 标志仍为 1，但 banned_until 已过）', `banned=${stillFlag.banned} me=${me.json && me.json.code} login=${lg.json && lg.json.code}`);
  if (!(me.json && me.json.code === 0))
    finding('HIGH', 'banned_until 到期后未自动放行（疑似只看 banned 标志位）', 'SQL 把 banned_until 改为过去', 'code 0', `code=${me.json && me.json.code}`, '定时封禁无法自动解封');
}

async function section5_cascade() {
  console.log('\n========== 5) 硬删除级联 ==========');
  const admin = P.admin;
  const victim = await register('cascade_victim');
  const bystander = await register('bystander');
  // victim 建世界 + 房 + 存盘 + 上报分数
  const w = await api('POST', '/worlds', { token: victim.token, body: { name: 'victim_world', seed: 123 } });
  const worldId = w.json.data.worldId;
  const sv = await api('POST', `/worlds/${worldId}/save`, { token: victim.token, body: {} });
  const sc = await api('POST', '/scores', { token: victim.token, body: { worldId, score: 77 } });
  const rm = await api('POST', '/rooms', { token: victim.token, body: { name: 'victim_room', maxPlayers: 4 } });
  const roomCode = rm.json.data.code;
  // bystander 的世界（用于验证 world_players 的 world 级联 & 不误删他人）
  const bw = await api('POST', '/worlds', { token: bystander.token, body: { name: 'bystander_world', seed: 9 } });
  const bWorldId = bw.json.data.worldId;
  const brm = await api('POST', '/rooms', { token: bystander.token, body: { name: 'bystander_room', maxPlayers: 4 } });
  // world_players 表 app 从不写入 → 直接 SQL 造 3 行覆盖两种删除条件
  await sqlRun('INSERT INTO world_players(world_id,player_id,joined_at) VALUES (?,?,?)', [worldId, victim.id, Date.now()]);
  await sqlRun('INSERT INTO world_players(world_id,player_id,joined_at) VALUES (?,?,?)', [bWorldId, victim.id, Date.now()]);
  await sqlRun('INSERT INTO world_players(world_id,player_id,joined_at) VALUES (?,?,?)', [worldId, bystander.id, Date.now()]);

  const cnt = async (label) => ({
    label,
    users: (await sqlGet('SELECT COUNT(*) n FROM users WHERE id=?', [victim.id])).n,
    worlds: (await sqlGet('SELECT COUNT(*) n FROM worlds WHERE owner_id=?', [victim.id])).n,
    rooms: (await sqlGet('SELECT COUNT(*) n FROM rooms WHERE owner_id=?', [victim.id])).n,
    saves: (await sqlGet('SELECT COUNT(*) n FROM saves WHERE world_id=?', [worldId])).n,
    scores: (await sqlGet('SELECT COUNT(*) n FROM scores WHERE user_id=?', [victim.id])).n,
    wp: (await sqlGet('SELECT COUNT(*) n FROM world_players WHERE player_id=? OR world_id IN (SELECT id FROM worlds WHERE owner_id=?)', [victim.id, victim.id])).n,
  });
  const before = await cnt('before');
  console.log('   [info] 删除前残留计数:', JSON.stringify(before));

  const del = await api('DELETE', `/admin/users/${victim.id}`, { token: admin.token, body: { confirmUsername: victim.username } });
  rec(del.json && del.json.code === 0, 'P5.1', 'DELETE 硬删除成功', `removed=${del.json && del.json.data && del.json.data.removed}`);
  const after = await cnt('after');
  const allZero = after.users === 0 && after.worlds === 0 && after.rooms === 0 && after.saves === 0 && after.scores === 0 && after.wp === 0;
  rec(allZero, 'P5.2', 'SQL 直查：users/worlds/rooms/saves/scores/world_players 残留全为 0',
    JSON.stringify(after));
  rec(before.saves >= 1 && before.scores >= 1 && before.rooms >= 1 && before.worlds >= 1 && before.wp === 3,
    'P5.3', '删除前确认数据确实存在（避免空断言）', JSON.stringify(before));
  if (!allZero) finding('HIGH', '硬删除未完整级联清理', 'DELETE /admin/users/:id (confirm 正确)', '所有关联表残留=0', JSON.stringify(after), '隐私数据残留、孤儿数据');

  // bystander 数据不受伤
  const bAfter = {
    worlds: (await sqlGet('SELECT COUNT(*) n FROM worlds WHERE owner_id=?', [bystander.id])).n,
    rooms: (await sqlGet('SELECT COUNT(*) n FROM rooms WHERE owner_id=?', [bystander.id])).n,
  };
  rec(bAfter.worlds === 1 && bAfter.rooms === 1, 'P5.4', '删除 victim 不影响旁观者的 worlds/rooms', JSON.stringify(bAfter));
}

async function section6_guardrails() {
  console.log('\n========== 6) 护栏 ==========');
  const admin = P.admin;
  const banSelf = await api('POST', `/admin/users/${admin.id}/ban`, { token: admin.token, body: { reason: 'x' } });
  rec(banSelf.json && banSelf.json.code === 400 && banSelf.json.message === 'cannot_target_self', 'P6.1', '封禁自己 → 拒绝 cannot_target_self', `code=${banSelf.json && banSelf.json.code} msg=${banSelf.json && banSelf.json.message}`);
  const banSelfRow = await sqlGet('SELECT banned FROM users WHERE id=?', [admin.id]);
  rec(banSelfRow.banned === 0, 'P6.2', '封禁自己被拒后本人未被写入封禁', `banned=${banSelfRow.banned}`);

  const delSelf = await api('DELETE', `/admin/users/${admin.id}`, { token: admin.token, body: { confirmUsername: admin.username } });
  rec(delSelf.json && delSelf.json.code === 400 && delSelf.json.message === 'cannot_target_self', 'P6.3', '删除自己 → 拒绝 cannot_target_self', `code=${delSelf.json && delSelf.json.code} msg=${delSelf.json && delSelf.json.message}`);

  const demoteSelf = await api('POST', `/admin/users/${admin.id}/role`, { token: admin.token, body: { role: 'player' } });
  rec(demoteSelf.json && demoteSelf.json.code === 400 && demoteSelf.json.message === 'last_admin_protected', 'P6.4', '唯一管理员降级自己 → last_admin_protected', `code=${demoteSelf.json && demoteSelf.json.code} msg=${demoteSelf.json && demoteSelf.json.message}`);

  const delLastAdminByOther = await api('DELETE', `/admin/users/${admin.id}`, { token: admin.token, body: { confirmUsername: admin.username } });
  rec(delLastAdminByOther.json && delLastAdminByOther.json.code === 400, 'P6.5', '删除最后一个管理员 → 被拒（last_admin_protected 或 cannot_target_self）', `code=${delLastAdminByOther.json && delLastAdminByOther.json.code} msg=${delLastAdminByOther.json && delLastAdminByOther.json.message}`);

  // 两管理员 → 降级其一必须允许
  const admin2 = await register('second_admin');
  const promote = await api('POST', `/admin/users/${admin2.id}/role`, { token: admin.token, body: { role: 'admin' } });
  rec(promote.json && promote.json.code === 0, 'P6.6', '提升第二个用户为管理员', `code=${promote.json && promote.json.code}`);
  const cnt = await sqlGet("SELECT COUNT(*) n FROM users WHERE role='admin'");
  const demote2 = await api('POST', `/admin/users/${admin2.id}/role`, { token: admin.token, body: { role: 'player' } });
  rec(cnt.n === 2 && demote2.json && demote2.json.code === 0, 'P6.7', '库中有两个管理员时降级其一 → 允许', `admins=${cnt.n} code=${demote2.json && demote2.json.code}`);
  if (!(demote2.json && demote2.json.code === 0)) finding('MEDIUM', '有两个管理员时无法降级其中一个', 'promote B→demote B', 'code 0', `code=${demote2.json && demote2.json.code}`, '权限无法回收');

  // bad role
  const badRole = await api('POST', `/admin/users/${admin2.id}/role`, { token: admin.token, body: { role: 'superuser' } });
  rec(badRole.json && badRole.json.code === 400 && badRole.json.message === 'bad_role', 'P6.8', '非法 role 值 → bad_role', `code=${badRole.json && badRole.json.code} msg=${badRole.json && badRole.json.message}`);
}

async function section7_leak() {
  console.log('\n========== 7) passhash 泄漏扫描 ==========');
  const admin = P.admin;
  const room = await api('POST', '/rooms', { token: admin.token, body: { name: 'leak_room', maxPlayers: 4 } });
  const rc = room.json.data.code;
  await api('POST', `/rooms/${rc}/world`, { token: admin.token, body: {} });
  const samples = [];
  const add = (label, r) => samples.push({ label, text: r.text });
  add('POST /auth/register', await api('POST', '/auth/register', { body: { username: nm('leakuser'), password: 'password123' } }));
  add('POST /auth/login', await api('POST', '/auth/login', { body: { username: admin.username, password: 'password123' } }));
  add('GET /me', await api('GET', '/me', { token: admin.token }));
  add('GET /admin/users', await api('GET', '/admin/users', { token: admin.token }));
  add('GET /admin/users/:id', await api('GET', `/admin/users/${admin.id}`, { token: admin.token }));
  add('GET /admin/actions', await api('GET', '/admin/actions', { token: admin.token }));
  add('GET /admin/rooms', await api('GET', '/admin/rooms', { token: admin.token }));
  add('GET /admin/overview', await api('GET', '/admin/overview', { token: admin.token }));
  add('GET /rooms', await api('GET', '/rooms', { token: admin.token }));
  add('GET /rooms/:code', await api('GET', `/rooms/${rc}`));
  add('GET /rooms/search', await api('GET', `/rooms/search?code=${rc}`, { token: admin.token }));

  const hits = [];
  for (const s of samples) {
    if (/passhash/i.test(s.text)) hits.push(s.label + ':passhash');
    if (/\$2[aby]\$/.test(s.text)) hits.push(s.label + ':bcrypt');
  }
  rec(hits.length === 0, 'P7.1', `扫描 ${samples.length} 个响应体 → passhash/bcrypt 0 命中`, hits.length ? hits.join('; ') : '0 hits');
  if (hits.length) finding('CRITICAL', 'passhash 泄漏到 HTTP 响应', '见 hits', '0 命中', hits.join('; '), '密码哈希外泄，可离线爆破');
}

async function section8_pagination() {
  console.log('\n========== 8) 分页/搜索边界 ==========');
  const admin = P.admin;
  const cases = [
    'page=1&pageSize=0', 'page=1&pageSize=-1', 'page=1&pageSize=10000', 'page=99999&pageSize=20',
    'q=', 'q=' + admin.id, 'filter=banned', 'filter=admin', 'filter=bogus',
    'q=%25', 'q=%27', "q=%27%20OR%201%3D1%20--", 'pageSize=abc&page=xyz',
  ];
  const bad = [];
  for (const c of cases) {
    const r = await api('GET', `/admin/users?${c}`, { token: admin.token });
    const isJsonOk = r.status === 200 && r.json && r.json.code === 0;
    const hasStack = /at Object\.|at async|node:internal|Error:/i.test(r.text);
    const hasHash = /passhash|\$2[aby]\$/i.test(r.text);
    if (!isJsonOk || hasStack || hasHash) bad.push(`${c} → status=${r.status} code=${r.json && r.json.code} stack=${hasStack} hash=${hasHash}`);
  }
  rec(bad.length === 0, 'P8.1', `分页/搜索/${cases.length} 个边界用例 → 无 500、无错误栈、无泄漏`, bad.length ? bad.join(' | ') : 'all 200/code0');
  if (bad.length) finding('MEDIUM', '分页/搜索边界返回异常或泄漏', '见详情', '均 200 且 code 0、无栈', bad.join(' | '), '注入面/健壮性');

  // pageSize 夹取验证
  const big = await api('GET', '/admin/users?pageSize=10000', { token: admin.token });
  rec(big.json && big.json.data.pageSize <= 100, 'P8.2', 'pageSize=10000 被夹取到 ≤100', `pageSize=${big.json && big.json.data.pageSize}`);
  const zero = await api('GET', '/admin/users?pageSize=0', { token: admin.token });
  rec(zero.json && zero.json.code === 0 && zero.json.data.rows.length >= 1, 'P8.3', 'pageSize=0 不应返回 0 行或报错（回退默认）', `rows=${zero.json && zero.json.data.rows.length} pageSize=${zero.json && zero.json.data.pageSize}`);
  const inj = await api('GET', `/admin/users?q=${encodeURIComponent("' OR 1=1 --")}`, { token: admin.token });
  rec(inj.json && inj.json.code === 0 && inj.json.data.rows.length === 0, 'P8.4', 'SQL 注入串作为搜索词 → 参数化安全（0 命中而非全表）', `rows=${inj.json && inj.json.data.rows.length}`);
}

async function section9_confirm() {
  console.log('\n========== 9) confirmUsername ==========');
  const admin = P.admin;
  const u = await register('confirm_target');
  const cases = [
    ['', 'empty', '空字符串'],
    ['someone_else', 'wrong', '别的用户名'],
    [u.username.toUpperCase(), 'upper', '大小写不一致（大写）'],
    [u.username + 'x', 'suffix', '多一个字符'],
  ];
  let allRejected = true; const ev = [];
  for (const [val, key, label] of cases) {
    const r = await api('DELETE', `/admin/users/${u.id}`, { token: admin.token, body: { confirmUsername: val } });
    if (!(r.json && r.json.code === 400 && r.json.message === 'confirm_username_mismatch')) { allRejected = false; ev.push(`${label}→code=${r.json && r.json.code}`); }
    const still = await sqlGet('SELECT COUNT(*) n FROM users WHERE id=?', [u.id]);
    if (still.n !== 1) { allRejected = false; ev.push(`${label}:用户被误删`); }
  }
  rec(allRejected, 'P9.1', 'confirmUsername 空/错误/大小写不一致/多字符 → 全部拒绝且不误删', ev.length ? ev.join('; ') : '4 cases rejected');
  const ok = await api('DELETE', `/admin/users/${u.id}`, { token: admin.token, body: { confirmUsername: u.username } });
  rec(ok.json && ok.json.code === 0, 'P9.2', 'confirmUsername 完全一致 → 删除成功', `code=${ok.json && ok.json.code}`);
  if (!allRejected) finding('HIGH', 'confirmUsername 校验可绕过/不严格', 'DELETE with bad confirm', '全部拒绝', ev.join('; '), '误删用户风险');
}

async function section10_audit() {
  console.log('\n========== 10) 审计完整性 ==========');
  const admin = P.admin;
  const T = await register('audit_target');
  const countN = async (action, tid) => (await sqlGet('SELECT COUNT(*) n FROM admin_actions WHERE action=? AND target_id=?', [action, tid])).n;

  const totalBefore = (await sqlGet('SELECT COUNT(*) n FROM admin_actions')).n;

  await api('POST', `/admin/users/${T.id}/ban`, { token: admin.token, body: { reason: 'a', durationHours: 0 } });
  await api('POST', `/admin/users/${T.id}/unban`, { token: admin.token, body: {} });
  await api('POST', `/admin/users/${T.id}/kick`, { token: admin.token, body: {} });
  await api('POST', `/admin/users/${T.id}/role`, { token: admin.token, body: { role: 'admin' } });
  await api('POST', `/admin/users/${T.id}/role`, { token: admin.token, body: { role: 'player' } });

  const cb = await countN('ban', T.id), cu = await countN('unban', T.id), ck = await countN('kick', T.id), cr = await countN('set_role', T.id);
  rec(cb === 1 && cu === 1 && ck === 1 && cr === 2, 'P10.1', '每个成功动作恰好一条审计（ban1/unban1/kick1/set_role2）', `ban=${cb} unban=${cu} kick=${ck} set_role=${cr}`);

  const lastBan = await sqlGet("SELECT actor_id, actor_name FROM admin_actions WHERE action='ban' AND target_id=? ORDER BY id DESC LIMIT 1", [T.id]);
  rec(lastBan.actor_id === admin.id && lastBan.actor_name === admin.username, 'P10.2', '审计 actor_id/actor_name 正确', JSON.stringify(lastBan));

  // 被拒绝的动作不留记录
  const totalMid = (await sqlGet('SELECT COUNT(*) n FROM admin_actions')).n;
  await api('POST', `/admin/users/${admin.id}/ban`, { token: admin.token, body: { reason: 'self' } });          // 拒绝
  await api('DELETE', `/admin/users/${T.id}`, { token: admin.token, body: { confirmUsername: 'WRONG' } });     // 拒绝
  await api('POST', `/admin/users/${T.id}/role`, { token: admin.token, body: { role: 'nope' } });              // 拒绝
  const totalAfter = (await sqlGet('SELECT COUNT(*) n FROM admin_actions')).n;
  rec(totalAfter === totalMid, 'P10.3', '被拒绝的动作不写审计（0 新增）', `before=${totalMid} after=${totalAfter}`);
  if (totalAfter !== totalMid) finding('LOW', '被拒绝的管理动作写入了审计记录', 'self-ban / bad-confirm delete / bad-role', '不写记录', `新增 ${totalAfter - totalMid} 条`, '审计噪声，需确认是否有意');

  // 审计只增不改
  const totalFinal = (await sqlGet('SELECT COUNT(*) n FROM admin_actions')).n;
  rec(totalFinal >= totalBefore + 5, 'P10.4', '审计表为 append-only（总数随动作增长）', `before=${totalBefore} final=${totalFinal}`);
}

async function section13_ui() {
  console.log('\n========== 13) UI 侧（读代码） ==========');
  const html = await fetch(BASE + '/admin.html');
  const htmlText = await html.text();
  rec(html.status === 200 && /<title>|admin/i.test(htmlText), 'P13.1', 'GET /admin.html → 200', `status=${html.status} bytes=${htmlText.length}`);

  const adminJs = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const hasQ = adminJs.includes('?token=') || adminJs.includes('token=' + "'");
  const hasX = adminJs.includes('x-auth-token');
  const hasAuth = adminJs.includes('Authorization');
  rec(hasQ && hasX && hasAuth, 'P13.2', 'public/admin.js 请求三通道带 token（?token= / x-auth-token / Authorization）', `q=${hasQ} x=${hasX} auth=${hasAuth}`);

  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const hidden = /id="admin-entry"[^>]*display:\s*none/.test(idx) || /id="admin-entry"[^>]*style="[^"]*display:\s*none/.test(idx);
  rec(hidden, 'P13.3', '#admin-entry 默认隐藏（display:none）', `matched=${hidden}`);
  const clientJs = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
  const roleGuard = /adminEntry[\s\S]{0,200}role === 'admin'/.test(clientJs);
  rec(roleGuard, 'P13.4', 'client.js 仅在 role===admin 时显示 #admin-entry', `matched=${roleGuard}`);
  const ver = /client\.js\?v=\d{8}[a-z]/.test(idx);
  rec(ver, 'P13.5', 'index.html 含有效缓存版本号（防旧缓存）', `matched=${ver}`);
}

async function section11_engine() {
  console.log('\n========== 11) DB 持久化与引擎 ==========');
  // 安全策略：**拷贝** server/data 到快照（不 move），删除后再用快照还原。
  // 任何一步失败都要显式报错，绝不静默吞掉（避免误删原始数据）。
  const SNAP = path.join(TMP, 'server-data-snapshot');
  let snapOk = false;
  try {
    if (fs.existsSync(DATA_DIR)) { fs.cpSync(DATA_DIR, SNAP, { recursive: true }); snapOk = fs.existsSync(SNAP); }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });

    let s = await startServer({ port: PORT_ENGINE, label: 'engine' });   // 无 DB_PATH → 默认 ./server/data/game.db
    cleanupFns.push(() => stopServer(s));
    const dbType = s.health && s.health.data && s.health.data.db;
    rec(dbType === 'node:sqlite', 'P11.1', '删掉 server/data 后启动 → 引擎为 node:sqlite（不是 sql.js）', `healthz.db=${dbType}`);
    if (dbType !== 'node:sqlite') finding('CRITICAL', '全新文件系统首启引擎不是 node:sqlite', 'rm -rf server/data && node server/index.js', 'node:sqlite', String(dbType), 'sql.js 为 5s 落盘的内存库，首启丢写/引擎不确定');
    rec(fs.existsSync(path.join(DATA_DIR, 'game.db')), 'P11.2', 'game.db 文件被创建', `path=server/data/game.db exists=${fs.existsSync(path.join(DATA_DIR, 'game.db'))}`);

    const u = await registerOn(PORT_ENGINE, 'persist');
    rec(u.role === 'admin', 'P11.3', '持久库首个账号为 admin（bootstrap）', `role=${u.role}`);

    await stopServer(s);
    s = await startServer({ port: PORT_ENGINE, label: 'engine-restart' });
    cleanupFns.push(() => stopServer(s));
    const lg = await apiOn(PORT_ENGINE, 'POST', '/auth/login', { body: { username: u.username, password: 'password123' } });
    rec(lg.json && lg.json.code === 0, 'P11.4', '重启后账号仍在（登录成功，文件库持久化）', `code=${lg.json && lg.json.code}`);
    await stopServer(s);
  } finally {
    // 还原：先清掉测试期间生成的 server/data，再用快照拷贝回来
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { console.error('[restore] rm DATA_DIR failed:', e && e.message); }
    if (snapOk && fs.existsSync(SNAP)) {
      try { fs.cpSync(SNAP, DATA_DIR, { recursive: true }); } catch (e) { console.error('[restore] restore snapshot failed:', e && e.message); }
    }
    const ok = fs.existsSync(path.join(DATA_DIR, 'game.db'));
    console.log(`   [restore] server/data 还原: ${ok ? '✅ game.db 存在' : '⚠️ 未还原（原始快照缺失，下次启动会自动重建）'}`);
  }
}

// ==================================================================
async function main() {
  console.log('QA 管理员后台独立探针');
  console.log('临时库:', DBPATH);
  console.log('Node:', process.version);

  mainSrv = await startServer({ port: PORT_MAIN, dbPath: DBPATH, label: 'main' });
  cleanupFns.push(() => stopServer(mainSrv));
  console.log('[db]', mainSrv.health && mainSrv.health.data && mainSrv.health.data.db);

  envSrv = await startServer({ port: PORT_ENV, dbPath: path.join(TMP, 'qa_env.db'), adminUsernames: 'forced_admin', label: 'env' });
  cleanupFns.push(() => stopServer(envSrv));

  // 主要账号
  P = { admin: await register('admin'), player: await register('player') };

  await section1_permissions();
  await section2_bootstrap();
  await section3_ban_chain();
  await section4_timed_ban();
  await section5_cascade();
  await section6_guardrails();
  await section7_leak();
  await section8_pagination();
  await section9_confirm();
  await section10_audit();
  await section13_ui();
  await section11_engine();

  // ---------------- summary ----------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==================================================');
  console.log(`子项: ${passed} 通过 / ${failed} 失败（共 ${results.length}）`);
  if (findings.length) {
    console.log('\n发现的问题（分级）:');
    for (const f of findings) {
      console.log(`\n[${f.sev}] ${f.title}`);
      console.log(`  复现: ${f.repro}`);
      console.log(`  期望: ${f.expected}`);
      console.log(`  实际: ${f.actual}`);
      console.log(`  影响: ${f.impact}`);
    }
  } else {
    console.log('未发现 CRITICAL/HIGH/MEDIUM/LOW 级问题。');
  }
  const severe = findings.filter((f) => f.sev === 'CRITICAL' || f.sev === 'HIGH');
  console.log('\nVERDICT: ' + (severe.length === 0 && failed === 0 ? 'PASS' : 'FAIL'));
  return { passed, failed, findings };
}

let exitCode = 1;
try {
  const r = await main();
  exitCode = (r.findings.some((f) => f.sev === 'CRITICAL' || f.sev === 'HIGH') || r.failed > 0) ? 1 : 0;
} catch (e) {
  console.error('\n探针异常:', e && (e.stack || e.message));
  exitCode = 2;
} finally {
  for (const fn of cleanupFns.reverse()) { try { await fn(); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('\n[cleanup] 临时库与后台服务已清理');
  process.exit(exitCode);
}
