// server/db/index.js — DB 适配层（better-sqlite3 → node:sqlite 自动回退）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbType = null, dbApi = null;

// 部署时走文件型 SQLite（DB_PATH 指定文件），本地测试默认内存。
// 默认值恒为 ':memory:'（tests 依赖它做隔离）。运行时可通过 setDbPath() 覆盖
// （仅 server/index.js 使用：默认切到文件库、失败时回退内存）。
let DB_PATH = process.env.DB_PATH || ':memory:';

/** 运行时改写数据库路径。传空/假值则回退内存库。仅 server/index.js 需要调用。 */
export function setDbPath(p) { DB_PATH = p || ':memory:'; }

async function loadBetter() {
  try {
    // ESM 动态 import CJS 包（仅作为可选依赖，可能未安装）
    const mod = await import('better-sqlite3').catch(() => null);
    if (!mod || !mod.default) return null;
    const Better = mod.default;
    const d = new Better(DB_PATH);
    return { type: 'better', api: makeBetterApi(d) };
  } catch { return null; }
}

async function loadNodeSqlite() {
  try {
    const sql = await import('node:sqlite');
    const d = new sql.DatabaseSync(DB_PATH);
    return { type: 'node:sqlite', api: makeNodeSqliteApi(d) };
  } catch { return null; }
}

// 纯 WASM 兜底：不依赖原生编译、不依赖实验 flag，任何 Node 沙箱都能跑
async function loadSqlJs() {
  try {
    const mod = await import('sql.js').catch(() => null);
    if (!mod) return null;
    const initSqlJs = mod.default || mod;
    const SQL = await initSqlJs();
    const resolved = DB_PATH === ':memory:' ? null : (path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH));
    let d;
    if (resolved && fs.existsSync(resolved)) {
      d = new SQL.Database(new Uint8Array(fs.readFileSync(resolved)));
    } else {
      d = new SQL.Database();
    }
    // 文件型：每 5s 落盘一次（unref：不阻止进程退出；线上由 http server 保活）
    if (resolved) {
      const flushTimer = setInterval(() => {
        try { fs.writeFileSync(resolved, Buffer.from(d.export())); } catch {}
      }, 5000);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
    return { type: 'sql.js', api: makeSqlJsApi(d) };
  } catch { return null; }
}

function makeSqlJsApi(d) {
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, params = []) => { const ps = d.prepare(sql); ps.bind(Array.isArray(params) ? params : [params]); ps.step(); ps.free(); const changes = (typeof d.getRowsModified === 'function') ? d.getRowsModified() : 0; return { changes }; },
    get: (sql, params = []) => { const ps = d.prepare(sql); ps.bind(Array.isArray(params) ? params : [params]); const ok = ps.step(); const o = ok ? ps.getAsObject() : null; ps.free(); return o; },
    all: (sql, params = []) => { const ps = d.prepare(sql); ps.bind(Array.isArray(params) ? params : [params]); const rows = []; while (ps.step()) rows.push(ps.getAsObject()); ps.free(); return rows; },
    close: () => d.close(),
  };
}

function makeBetterApi(d) {
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, params = []) => d.prepare(sql).run(...(Array.isArray(params) ? params : [params])),
    get: (sql, params = []) => d.prepare(sql).get(...(Array.isArray(params) ? params : [params])),
    all: (sql, params = []) => d.prepare(sql).all(...(Array.isArray(params) ? params : [params])),
    close: () => d.close(),
  };
}
function makeNodeSqliteApi(d) {
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, params = []) => { const stmt = d.prepare(sql); const r = stmt.run(...(Array.isArray(params) ? params : [params])); return { changes: (r && Number(r.changes)) || 0, lastInsertRowid: r && r.lastInsertRowid }; },
    get: (sql, params = []) => { const stmt = d.prepare(sql); return stmt.get(...(Array.isArray(params) ? params : [params])) || null; },
    all: (sql, params = []) => { const stmt = d.prepare(sql); return [...stmt.all(...(Array.isArray(params) ? params : [params]))]; },
    close: () => d.close(),
  };
}

export async function initDB() {
  // ⚠️ 顺序关键：文件型 DB 必须在"打开"之前先确保父目录存在。
  // 否则全新文件系统上（./server/data 不存在）node:sqlite 的 DatabaseSync 打开会抛错 →
  // 误回退到 sql.js（WASM 内存库、5s 才落盘一次），导致线上首启引擎不确定且可能丢写。
  if (DB_PATH !== ':memory:') {
    const dir = path.dirname(path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const b = await loadBetter();
  if (b) { dbApi = b.api; dbType = b.type; }
  else {
    const n = await loadNodeSqlite();
    if (n) { dbApi = n.api; dbType = n.type; }
    else {
      const s = await loadSqlJs();
      if (s) { dbApi = s.api; dbType = s.type; }
    }
  }
  if (!dbApi) throw new Error('NO_SQLITE_AVAILABLE');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  dbApi.exec(sql);
  migrate();
  return { type: dbType, api: dbApi };
}

// 轻量迁移：对已存在的文件型 DB 补列（CREATE TABLE IF NOT EXISTS 不会补列）。
// 每条独立 try/catch —— 列已存在时各引擎报错文案不同，忽略即可。
function migrate() {
  const alters = [
    "ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'",
    'ALTER TABLE rooms ADD COLUMN passhash TEXT',
    'ALTER TABLE rooms ADD COLUMN name TEXT',
    'ALTER TABLE rooms ADD COLUMN mode TEXT',
    // 房间玩法设置（旧库补列；新库已在 schema.sql 内含，重复执行报错被忽略）
    'ALTER TABLE rooms ADD COLUMN stones_per_turn INTEGER',
    'ALTER TABLE rooms ADD COLUMN lonely_death_delay INTEGER',
    // 胜利条件（房主可配置；JSON 串；旧库补列）
    'ALTER TABLE rooms ADD COLUMN victory_lines TEXT',
    'ALTER TABLE rooms ADD COLUMN victory_thresholds TEXT',
    // 可编辑棋盘形状（房主可配置；JSON 串 {w,h,shape}；旧库补列）
    'ALTER TABLE rooms ADD COLUMN board TEXT',
    'ALTER TABLE rooms ADD COLUMN go_limits TEXT',
    // 管理员控制台：users 新列（旧文件库补列；新库已在 schema.sql 内含，重复执行报错被忽略）
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'player'",
    'ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN ban_reason TEXT',
    'ALTER TABLE users ADD COLUMN banned_at INTEGER',
    'ALTER TABLE users ADD COLUMN banned_until INTEGER',
    'ALTER TABLE users ADD COLUMN last_login INTEGER',
  ];
  for (const s of alters) { try { dbApi.exec(s); } catch (e) { /* 已存在 → 忽略 */ } }
}

export function db() {
  if (!dbApi) throw new Error('DB_NOT_INITIALIZED');
  return dbApi;
}

export function dbType_() { return dbType; }

// repositories
// 对外可安全返回的 users 列（**绝不含 passhash**）。所有 HTTP 响应都用它。
const USER_PUBLIC_COLS = 'id, username, email, role, banned, ban_reason, banned_at, banned_until, created_at, last_login';

export const usersRepo = {
  /** 建号。role 缺省 'player'（引导场景由调用方随后 setRole('admin')）。 */
  create: (username, email, passhash) => db().run(
    'INSERT INTO users(username,email,passhash,created_at,role,banned) VALUES (?,?,?,?,?,?)',
    [username, email, passhash, Date.now(), 'player', 0]
  ),
  /** 登录用：需要 passhash。**不得直接作为 HTTP 响应体**。 */
  byUsername: (u) => db().get('SELECT * FROM users WHERE username=?', [u]),
  /** 对外安全视图（不含 passhash）。 */
  byId: (id) => db().get(`SELECT ${USER_PUBLIC_COLS} FROM users WHERE id=?`, [id]),
  /** 内部鉴权用：含 passhash。**绝不出现在任何 HTTP 响应里**。 */
  byIdFull: (id) => db().get('SELECT * FROM users WHERE id=?', [id]),

  /**
   * 分页 + 搜索 + 过滤的用户列表。
   * @param {{q?:string, filter?:'all'|'banned'|'admin', limit?:number, offset?:number}} o
   * @returns {{rows:Array, total:number}}
   */
  listAll: (o = {}) => {
    const filter = o.filter || 'all';
    const q = (o.q == null ? '' : String(o.q)).trim();
    const limit = Number.isFinite(o.limit) ? Math.max(1, Math.min(200, Math.floor(o.limit))) : 20;
    const offset = Number.isFinite(o.offset) ? Math.max(0, Math.floor(o.offset)) : 0;
    const where = [];
    const params = [];
    if (filter === 'banned') where.push('banned=1');
    else if (filter === 'admin') where.push("role='admin'");
    if (q) {
      if (/^\d+$/.test(q)) { where.push('id=?'); params.push(Number(q)); }
      else { where.push('username LIKE ?'); params.push('%' + q + '%'); }
    }
    const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
    const totalRow = db().get(`SELECT COUNT(*) AS n FROM users${whereSql}`, params);
    const rows = db().all(
      `SELECT ${USER_PUBLIC_COLS} FROM users${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { rows, total: totalRow ? Number(totalRow.n) : 0 };
  },

  /** 汇总计数：{ total, banned, admins }。 */
  count: () => {
    const r = db().get(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN banned=1 THEN 1 ELSE 0 END),0) AS banned, " +
      "COALESCE(SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END),0) AS admins FROM users"
    );
    return r ? { total: Number(r.total) || 0, banned: Number(r.banned) || 0, admins: Number(r.admins) || 0 }
             : { total: 0, banned: 0, admins: 0 };
  },

  setRole: (id, role) => db().run('UPDATE users SET role=? WHERE id=?', [role === 'admin' ? 'admin' : 'player', id]),

  /** 设置/清除封禁。until 为 0/NULL 时表示永久。 */
  setBan: (id, o = {}) => {
    const banned = o.banned ? 1 : 0;
    if (!banned) {
      return db().run('UPDATE users SET banned=0, ban_reason=NULL, banned_at=NULL, banned_until=NULL WHERE id=?', [id]);
    }
    const until = (Number.isFinite(o.until) && o.until > 0) ? Math.floor(o.until) : 0;
    return db().run(
      'UPDATE users SET banned=1, ban_reason=?, banned_at=?, banned_until=? WHERE id=?',
      [o.reason || null, Date.now(), until, id]
    );
  },

  touchLogin: (id) => db().run('UPDATE users SET last_login=? WHERE id=?', [Date.now(), id]),

  /**
   * 预演「不活跃账号」候选（不删）。以「最近登录时间」（从未登录则用注册时间）判定。
   * @param {number} beforeMs 早于此时间的算不活跃
   * @param {{keepAdmins?:boolean}} o 默认保留管理员
   */
  listInactive: (beforeMs, o = {}) => {
    const keepAdmins = o.keepAdmins !== false;
    const sql =
      'SELECT id, username, role, last_login, created_at FROM users WHERE ' +
      (keepAdmins ? "role!='admin' AND " : '') +
      'COALESCE(last_login, created_at) < ? ORDER BY COALESCE(last_login, created_at) ASC';
    return db().all(sql, [beforeMs]);
  },

  /**
   * 清理不活跃账号：逐个走 remove() 级联清理（worlds/saves/rooms/scores）。
   * 默认保留管理员，避免误删唯一的逃生账号。
   * @returns {Array<{id:number, username:string}>} 实际删除的用户
   */
  purgeInactive: (beforeMs, o = {}) => {
    const rows = usersRepo.listInactive(beforeMs, o);
    const removed = [];
    for (const r of rows) {
      let res = { removed: 0 };
      try { res = usersRepo.remove(r.id); } catch (e) { res = { removed: 0 }; }
      if (res && res.removed) removed.push({ id: r.id, username: r.username });
    }
    return removed;
  },

  /**
   * 硬删除用户并**级联清理**其所有关联数据（worlds / saves / world_players / rooms / scores）。
   * 每条语句独立 try/catch，保证部分失败也不炸整个流程。
   * @returns {{removed:number, cleaned:object}}
   */
  remove: (id) => {
    const cleaned = {};
    const step = (key, sql, params) => {
      try { db().run(sql, params); cleaned[key] = true; } catch (e) { cleaned[key] = false; }
    };
    // 先删子表（scores 同时按 user 与"该用户拥有的世界"清理）
    step('scores_by_user', 'DELETE FROM scores WHERE user_id=?', [id]);
    step('scores_by_world', 'DELETE FROM scores WHERE world_id IN (SELECT id FROM worlds WHERE owner_id=?)', [id]);
    step('saves_by_world', 'DELETE FROM saves WHERE world_id IN (SELECT id FROM worlds WHERE owner_id=?)', [id]);
    step('world_players_self', 'DELETE FROM world_players WHERE player_id=?', [id]);
    step('world_players_in_worlds', 'DELETE FROM world_players WHERE world_id IN (SELECT id FROM worlds WHERE owner_id=?)', [id]);
    step('rooms_by_owner', 'DELETE FROM rooms WHERE owner_id=?', [id]);
    step('worlds_by_owner', 'DELETE FROM worlds WHERE owner_id=?', [id]);
    let removed = 0;
    try { const r = db().run('DELETE FROM users WHERE id=?', [id]); removed = (r && r.changes) ? r.changes : 0; }
    catch (e) { removed = 0; }
    return { removed, cleaned };
  },
};

export const adminRepo = {
  /** 写一条审计记录（失败不抛，避免审计失败阻断业务）。 */
  log: ({ actorId = null, actorName = null, action, targetId = null, targetName = null, detail = null } = {}) => {
    try {
      // detail 列是 TEXT：对象/数组一律 JSON 序列化（否则 node:sqlite / better-sqlite3 绑定非原始值会抛错）。
      const d = (detail == null) ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail));
      db().run(
        'INSERT INTO admin_actions(actor_id,actor_name,action,target_id,target_name,detail,created_at) VALUES (?,?,?,?,?,?,?)',
        [actorId, actorName, String(action), targetId, targetName, d, Date.now()]
      );
      return true;
    } catch (e) { return false; }
  },
  /** 倒序审计日志。 */
  list: (limit = 100) => {
    const lim = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return db().all('SELECT * FROM admin_actions ORDER BY id DESC LIMIT ?', [lim]);
  },
};

// 轻量键值设置存储：复用已有的 meta(k,v) 表（此前无人使用），避免再加一张表。
export const settingsRepo = {
  get: (k, def = null) => {
    try { const r = db().get('SELECT v FROM meta WHERE k=?', [k]); return r ? r.v : def; }
    catch (e) { return def; }
  },
  getInt: (k, def) => {
    const v = settingsRepo.get(k, null);
    if (v == null) return def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  },
  set: (k, v) => db().run('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', [String(k), String(v)]),
  all: () => {
    const out = {};
    try { for (const r of db().all('SELECT k,v FROM meta')) out[r.k] = r.v; } catch (e) { /* 忽略 */ }
    return out;
  },
};

export const worldsRepo = {
  create: (id, ownerId, name, seed) => db().run(
    'INSERT INTO worlds(id,owner_id,name,seed,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [id, ownerId, name, seed, Date.now(), Date.now()]
  ),
  get: (id) => db().get('SELECT * FROM worlds WHERE id=?', [id]),
  listByOwner: (ownerId) => db().all('SELECT * FROM worlds WHERE owner_id=? ORDER BY updated_at DESC LIMIT 10', [ownerId]),
  count: () => { const r = db().get('SELECT COUNT(*) AS n FROM worlds'); return r ? Number(r.n) : 0; },
  touch: (id) => db().run('UPDATE worlds SET updated_at=? WHERE id=?', [Date.now(), id]),
};

export const roomsRepo = {
  // 建房：world_id 用 '' 占位表示"尚未建立世界"（先建房后建世界）。
  create: (code, worldId, ownerId, maxPlayers, opts) => db().run(
    'INSERT INTO rooms(code,world_id,owner_id,max_players,visibility,passhash,name,mode,stones_per_turn,lonely_death_delay,victory_lines,victory_thresholds,board,go_limits,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      code, worldId || '', ownerId, maxPlayers,
      (opts && opts.visibility) || 'public',
      (opts && opts.passhash) || null,
      (opts && opts.name) || null,
      (opts && opts.mode) || null,
      // 设置列：调用方已做范围钳制；缺失存 NULL（读取时回退默认）
      (opts && Number.isInteger(opts.stonesPerTurn)) ? opts.stonesPerTurn : null,
      (opts && Number.isInteger(opts.lonelyDeathDelay)) ? opts.lonelyDeathDelay : null,
      // 胜利条件：对象 → JSON 串；缺失存 NULL（hydrate 时回默认）
      (opts && opts.victoryLines) ? JSON.stringify(opts.victoryLines) : null,
      (opts && opts.victoryThresholds) ? JSON.stringify(opts.victoryThresholds) : null,
      // 棋盘形状：对象 → JSON 串；缺失存 NULL（hydrate 时回默认矩形）
      (opts && opts.board) ? JSON.stringify(opts.board) : null,
      // go 限制：对象 → JSON 串；缺失存 NULL（hydrate 时回默认）
      (opts && opts.goLimits) ? JSON.stringify(opts.goLimits) : null,
      Date.now(),
    ]
  ),
  get: (code) => db().get('SELECT * FROM rooms WHERE code=?', [code]),
  byOwner: (ownerId) => db().all('SELECT code,name,visibility,mode,world_id,created_at,closed_at FROM rooms WHERE owner_id=? ORDER BY created_at DESC LIMIT 20', [ownerId]),
  // 按 worldId 反查房间（未关闭的最新一间）：供 ensureWorld 重建时带上房间设置，避免静默重置。
  byWorld: (worldId) => db().get('SELECT * FROM rooms WHERE world_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1', [worldId]),
  setWorld: (code, worldId, mode) => db().run('UPDATE rooms SET world_id=?, mode=? WHERE code=?', [worldId, mode || null, code]),
  // 中途改配置（仅房主；调用方已归一化）：写胜利条件两列（JSON 串）+ 棋盘形状列 + go 限制列。
  // board / goLimits 需保留：未在本次 patch 中给出时，沿用该房当前 DB 值（避免"只改胜利条件把形状/限制清空"）。
  setSettings: (code, s) => {
    const hasBoard = !!(s && Object.prototype.hasOwnProperty.call(s, 'board'));
    const hasGoLimits = !!(s && Object.prototype.hasOwnProperty.call(s, 'goLimits'));
    const cur = (hasBoard && hasGoLimits) ? null : db().get('SELECT board, go_limits FROM rooms WHERE code=?', [code]);
    const boardVal = hasBoard
      ? ((s.board) ? JSON.stringify(s.board) : null)
      : ((cur && cur.board != null) ? cur.board : null);
    const goLimitsVal = hasGoLimits
      ? ((s.goLimits) ? JSON.stringify(s.goLimits) : null)
      : ((cur && cur.go_limits != null) ? cur.go_limits : null);
    return db().run(
      'UPDATE rooms SET victory_lines=?, victory_thresholds=?, board=?, go_limits=? WHERE code=?',
      [
        (s && s.victoryLines) ? JSON.stringify(s.victoryLines) : null,
        (s && s.victoryThresholds) ? JSON.stringify(s.victoryThresholds) : null,
        boardVal,
        goLimitsVal,
        code,
      ]
    );
  },
  close: (code) => db().run('UPDATE rooms SET closed_at=? WHERE code=?', [Date.now(), code]),
  active: () => db().all('SELECT * FROM rooms WHERE closed_at IS NULL ORDER BY created_at DESC LIMIT 50'),
  publicOpen: () => db().all("SELECT * FROM rooms WHERE closed_at IS NULL AND visibility='public' ORDER BY created_at DESC LIMIT 50"),
};

export const savesRepo = {
  create: (worldId, payload) => db().run(
    'INSERT INTO saves(world_id,payload,created_at) VALUES (?,?,?)',
    [worldId, JSON.stringify(payload), Date.now()]
  ),
  list: (worldId) => db().all('SELECT id,world_id,created_at FROM saves WHERE world_id=? ORDER BY created_at DESC LIMIT 10', [worldId]),
  recent: (worldId) => db().get('SELECT payload FROM saves WHERE world_id=? ORDER BY created_at DESC LIMIT 1', [worldId]),
};

export const scoresRepo = {
  create: (userId, worldId, score) => db().run(
    'INSERT INTO scores(user_id,world_id,score,created_at) VALUES (?,?,?,?)',
    [userId, worldId, score, Date.now()]
  ),
  byUser: (userId) => db().all('SELECT * FROM scores WHERE user_id=? ORDER BY score DESC LIMIT 10', [userId]),
  best: (userId, worldId) => db().get('SELECT MAX(score) AS best FROM scores WHERE user_id=? AND world_id=?', [userId, worldId]),
};