// server/routes.js — 16 个 REST 端点，统一响应 { code, message, data }
import express from 'express';
import crypto from 'node:crypto';
import { usersRepo, worldsRepo, roomsRepo, savesRepo, scoresRepo, adminRepo, settingsRepo, dbType_ } from './db/index.js';
import {
  hashPassword, verifyPassword, signToken, authMiddleware, requireAdmin,
  isBanActive, passwordOk, usernameOk,
} from './auth.js';
import { World as WorldEngine } from './engine.js';
import { activeWorlds, worldModes } from './worldhub.js';
import { kickUser, onlineUserIds } from './net.js';
import {
  createRoom, getRoom, attachWorld, closeRoom, roomInfo, listPublicRooms,
  verifyRoomPass, roomHub, MAX_PLAYERS, normStonesPerTurn, normLonelyDeathDelay,
  normVictoryLines, normVictoryThresholds, normBoard, normGoLimits, setRoomSettings,
} from './rooms.js';
import { normalizeMode } from './modes/index.js';
import {
  getInactiveDays, setInactiveDays, previewInactive, runInactivePurge, lastPurgeAt,
  DEFAULT_INACTIVE_DAYS, MAX_INACTIVE_DAYS,
} from './maintenance.js';

/** 引导用：ADMIN_USERNAMES 环境变量（逗号分隔，大小写不敏感）。 */
function adminUsernames() {
  return String(process.env.ADMIN_USERNAMES || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ============== 管理员来源限制 ==============
// 目标：管理员（账号与后台）默认「只能在这台跑服务的电脑上使用」。
//   - 默认允许：127.0.0.1 / ::1（本机回环）。
//   - ADMIN_ALLOWED_IPS：逗号分隔的 IP / CIDR / *（* = 不限制）。存在 X-Forwarded-For 时按其首个地址判定。
//   - ADMIN_ACCESS_KEY：设置后，管理员登录与所有 /admin/* 请求必须带匹配的密钥
//     （可写在 body.adminKey、请求头 x-admin-key 或 ?adminKey=）。用于线上动态 IP 场景。
//   以上两项都可写在 DB 设置里（meta 表：admin_allowed_ips / admin_access_key），便于随部署生效；环境变量优先。
function clientIp(req) {
  // 默认**不信任** X-Forwarded-For：防伪造来源 IP 绕过管理员白名单 / IP 限制。
  // 仅当显式设置 TRUST_PROXY=1（部署在可信反代之后）时才采信首个 XFF 地址。
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
  const xff = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  let ip = xff || (req.socket && req.socket.remoteAddress) || req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}
function ipv4ToInt(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const seg of p) {
    const v = Number(seg);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}
function ipMatch(ip, pat) {
  pat = String(pat).trim();
  if (!pat) return false;
  if (pat === '*') return true;
  if (pat === ip) return true;
  if (pat.includes('/')) {
    const [base, bitsStr] = pat.split('/');
    const bits = Number(bitsStr);
    const a = ipv4ToInt(ip), b = ipv4ToInt(base);
    if (a == null || b == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
    return (a & mask) === (b & mask);
  }
  return false;
}
// 配置来源：环境变量优先，其次 DB 设置（meta 表），最后内置默认。
// 用 DB 存是为了让密钥能"随部署走"，而测试跑在 :memory: 库上、天然读不到 → 不受影响。
function cfgGet(k) { try { return settingsRepo.get(k, ''); } catch (e) { return ''; } }
function adminAllowedIps() {
  const raw = String(process.env.ADMIN_ALLOWED_IPS || cfgGet('admin_allowed_ips') || '').trim();
  if (raw === '*') return null;                                  // null = 不限制 IP
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['127.0.0.1'];                                          // 默认：仅本机
}
function adminAccessKey() { return String(process.env.ADMIN_ACCESS_KEY || cfgGet('admin_access_key') || ''); }
function providedAdminKey(req) {
  return String(
    (req.body && req.body.adminKey) || req.headers['x-admin-key'] || (req.query && req.query.adminKey) || ''
  );
}
/**
 * @returns {{ok:boolean, reason?:'ip'|'key', ip:string}}
 * 语义：设了访问密钥 → 一律要求密钥（本机与远程一致，实现"只有你知道"）；
 *       没设密钥 → 退回 IP 白名单（默认仅本机）。
 */
function checkAdminSource(req) {
  const ip = clientIp(req);
  const key = adminAccessKey();
  if (key) {
    if (providedAdminKey(req) === key) return { ok: true, ip };
    return { ok: false, reason: 'key', ip };
  }
  const list = adminAllowedIps();
  if (list && !list.some((p) => ipMatch(ip, p))) return { ok: false, reason: 'ip', ip };
  return { ok: true, ip };
}

export function createRouter() {
  const router = express.Router();

  // Lazily recreate a world from its stored seed so a shared room link keeps working after a restart.
  function ensureWorld(worldId, roomOpts) {
    if (activeWorlds.has(worldId)) return activeWorlds.get(worldId);
    const row = worldsRepo.get(worldId);
    if (!row) return null;
    // DB 无 mode 列（避免迁移）；世界模式在内存 worldModes 里记住，重启后回退 rts。
    const md = (roomOpts && roomOpts.mode) || worldModes.get(worldId) || 'rts';
    const w = new WorldEngine(row.id, row.owner_id, row.seed, {
      mode: md,
      maxPlayers: roomOpts && roomOpts.maxPlayers,
      hostId: roomOpts && roomOpts.ownerId,
      // 玩法设置透传（重建路径也不能丢；roomOpts 已由 roomForRoom 归一化）
      stonesPerTurn: roomOpts && roomOpts.stonesPerTurn,
      lonelyDeathDelay: roomOpts && roomOpts.lonelyDeathDelay,
      // 胜利条件透传（重建路径同样不能丢）
      victoryLines: roomOpts && roomOpts.victoryLines,
      victoryThresholds: roomOpts && roomOpts.victoryThresholds,
      // 棋盘形状透传（重建路径同样不能丢）
      board: roomOpts && roomOpts.board,
      goLimits: roomOpts && roomOpts.goLimits,
    });
    activeWorlds.set(row.id, w);
    worldModes.set(row.id, md);
    // 重启后按房间成员恢复席位（"中途离开由电脑接手"的对偶：重启不丢人）
    if (roomOpts && roomOpts.members) {
      for (const [uid, info] of roomOpts.members) {
        if (!w.players[uid]) w.addPlayer(uid, (info && info.name) || ('玩家' + uid));
      }
    }
    return w;
  }
  // 房间 → 世界：优先内存，其次按 seed 重建（保证分享链接在重启后仍可用）
  function worldForRoom(room) {
    if (!room || !room.worldId) return null;
    return activeWorlds.get(room.worldId) || ensureWorld(room.worldId, {
      mode: room.mode, maxPlayers: room.maxPlayers, ownerId: room.ownerId, members: room.members,
      // 重启重建也要带上房间设置，否则设置会丢失
      stonesPerTurn: room.stonesPerTurn, lonelyDeathDelay: room.lonelyDeathDelay,
      victoryLines: room.victoryLines, victoryThresholds: room.victoryThresholds,
      board: room.board,
      goLimits: room.goLimits,
    });
  }

  // 统一"活跃账号"守卫（置于 authMiddleware 之后）：
  //   - 用户不存在（令牌指向已删除账号）→ 403 user_not_found
  //   - 已生效封禁 → 4004 account_banned（带原因/到期）
  //   - 否则放行
  // 目的：让"封禁"名副其实——被封禁后即便持有旧 token，也不能再读大厅/房间/快照或触发任何写操作。
  function requireActive(req, res, next) {
    const u = usersRepo.byIdFull(req.user && req.user.id);
    if (!u) return res.status(403).json({ code: 403, message: 'user_not_found', data: null });
    if (isBanActive(u)) {
      return res.json({ code: 4004, message: 'account_banned', data: { reason: u.ban_reason || null, until: u.banned_until || 0 } });
    }
    next();
  }
  // 需要登录且未被封禁的业务接口统一使用此中间件数组。
  const authed = [authMiddleware, requireActive];

  // ============== AUTH ==============
  router.post('/auth/register', async (req, res) => {
    const { username, password, email } = req.body || {};
    if (!usernameOk(username)) return res.json({ code: 400, message: 'username_invalid', data: null });
    if (!passwordOk(password)) return res.json({ code: 400, message: 'password_too_weak', data: null });
    if (usersRepo.byUsername(username)) return res.json({ code: 409, message: 'username_taken', data: null });
    const passhash = await hashPassword(password);
    try {
      usersRepo.create(username, email || null, passhash);
    } catch (e) {
      return res.json({ code: 409, message: 'user_create_failed', data: null });
    }
    let u = usersRepo.byUsername(username);
    // ---- 管理员引导 ----
    // 1) 空库首个账号自动成为管理员（部署沙箱 DB 为内存态、无法改环境变量，这是唯一引导路径）
    // 2) ADMIN_USERNAMES 命中的用户名强制管理员
    try {
      const isFirst = usersRepo.count().total === 1;
      const forced = adminUsernames().includes(String(u.username).toLowerCase());
      if (isFirst || forced) {
        usersRepo.setRole(u.id, 'admin');
        u = usersRepo.byUsername(username);
        if (isFirst) console.log('[admin] bootstrap: first account "' + u.username + '" (id=' + u.id + ') granted admin');
        if (forced && !isFirst) console.log('[admin] bootstrap: ADMIN_USERNAMES matched "' + u.username + '" granted admin');
      }
    } catch (e) { /* 引导失败不影响注册 */ }
    try { usersRepo.touchLogin(u.id); } catch (e) { /* 忽略 */ }
    const token = signToken({ id: u.id, username: u.username });
    return res.json({ code: 0, message: 'ok', data: { token, user: { id: u.id, username: u.username, role: u.role } } });
  });

  router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.json({ code: 400, message: 'missing_fields', data: null });
    const u = usersRepo.byUsername(username);
    if (!u) return res.json({ code: 401, message: 'invalid_credentials', data: null });
    const ok = await verifyPassword(password, u.passhash);
    if (!ok) return res.json({ code: 401, message: 'invalid_credentials', data: null });
    // 封禁拦截：密码正确后再判（不泄露账号是否存在）
    if (isBanActive(u)) {
      return res.json({ code: 4004, message: 'account_banned', data: { reason: u.ban_reason || null, until: u.banned_until || 0 } });
    }
    // 引导：ADMIN_USERNAMES 命中 → 登录时也强制为管理员
    if (adminUsernames().includes(String(u.username).toLowerCase()) && u.role !== 'admin') {
      try { usersRepo.setRole(u.id, 'admin'); u.role = 'admin'; } catch (e) { /* 忽略 */ }
    }
    // 注意：管理员来源限制**不在登录处拦截**（登录表单没有密钥输入框，拦了会把管理员锁死）；
    //       统一在 /admin/* 的 adminSourceGuard 上把关。admin 账号仍可正常登录（当普通玩家用）。
    try { usersRepo.touchLogin(u.id); } catch (e) { /* 忽略 */ }
    const token = signToken({ id: u.id, username: u.username });
    return res.json({ code: 0, message: 'ok', data: { token, user: { id: u.id, username: u.username, role: u.role } } });
  });

  router.post('/auth/logout', (req, res) => {
    // JWT 无状态；客户端丢弃 token 即可
    return res.json({ code: 0, message: 'ok', data: null });
  });

  router.get('/me', authMiddleware, (req, res) => {
    const u = usersRepo.byIdFull(req.user.id);
    if (!u) return res.json({ code: 404, message: 'user_not_found', data: null });
    if (isBanActive(u)) {
      return res.json({ code: 4004, message: 'account_banned', data: { reason: u.ban_reason || null, until: u.banned_until || 0 } });
    }
    return res.json({ code: 0, message: 'ok', data: { id: u.id, username: u.username, email: u.email, role: u.role } });
  });

  // ============== WORLDS ==============
  router.post('/worlds', authed, (req, res) => {
    const b = req.body || {};
    const { name, seed, mode } = b;
    if (!name || typeof name !== 'string') return res.json({ code: 400, message: 'name_required', data: null });
    const id = crypto.randomBytes(8).toString('hex');
    const sd = Number.isInteger(seed) ? seed : (Math.random() * 1e9) | 0;
    // 模式：归一为已注册模式 id（默认 'rts'；'go' / 未来 gomoku 等由注册表决定，无需改此处）。
    const md = normalizeMode(mode);
    worldsRepo.create(id, req.user.id, name, sd);
    const stonesPerTurn = normStonesPerTurn(b.stonesPerTurn);
    const lonelyDeathDelay = normLonelyDeathDelay(b.lonelyDeathDelay);
    // 胜利条件：按模式归一（go 强制只留 territory）
    const victoryLines = normVictoryLines(b.victoryLines, md);
    const victoryThresholds = normVictoryThresholds(b.victoryThresholds);
    const board = normBoard(b.board, md);
    const goLimits = normGoLimits(b.goLimits);   // go 限制（手数上限 / 每手时限 / 超时判负次数）
    const w = new WorldEngine(id, req.user.id, sd, {
      mode: md,
      maxPlayers: b.maxPlayers,
      hostId: req.user.id,
      stonesPerTurn,
      lonelyDeathDelay,
      victoryLines,
      victoryThresholds,
      board,
      goLimits,
      // rts 出生点（自选 / 随机）；go 无出生点概念，此项对其无影响
      spawnMode: b.spawnMode,
      spawnXY: b.spawnXY,
    });
    activeWorlds.set(id, w);
    worldModes.set(id, md);
    return res.json({ code: 0, message: 'ok', data: { worldId: id, seed: sd, mode: md, maxPlayers: w.maxPlayers, stonesPerTurn, lonelyDeathDelay, victoryLines, victoryThresholds, board, goLimits } });
  });

  router.get('/worlds/:id', authed, (req, res) => {
    // 备用重建路径（重启后先走该路径时）：先按 worldId 反查房间，带上完整房间设置
    // （mode/席位数/房主/成员/玩法设置）再建世界。否则 ensureWorld 会用默认设置重建，
    // 不仅本次返回错设置，还会把默认世界**缓存进 activeWorlds**，连累之后 /join 的玩家。
    let roomOpts = null;
    try {
      const row = roomsRepo.byWorld(req.params.id);
      const room = row ? getRoom(row.code) : null;
      if (room) {
        roomOpts = {
          mode: room.mode,
          maxPlayers: room.maxPlayers,
          ownerId: room.ownerId,
          members: room.members,
          stonesPerTurn: room.stonesPerTurn,
          lonelyDeathDelay: room.lonelyDeathDelay,
          victoryLines: room.victoryLines,
          victoryThresholds: room.victoryThresholds,
          board: room.board,
          goLimits: room.goLimits,
        };
      }
    } catch (e) { roomOpts = null; }
    const w = ensureWorld(req.params.id, roomOpts);
    if (!w) return res.json({ code: 404, message: 'world_not_found', data: null });
    return res.json({ code: 0, message: 'ok', data: w.snapshot(true) });
  });

  // ============== SAVES ==============
  router.post('/worlds/:id/save', authed, (req, res) => {
    const w = activeWorlds.get(req.params.id);
    if (!w) return res.json({ code: 404, message: 'world_not_active', data: null });
    const snap = w.snapshot(true);
    savesRepo.create(req.params.id, snap);
    worldsRepo.touch(req.params.id);
    return res.json({ code: 0, message: 'ok', data: { savedAt: Date.now() } });
  });

  router.get('/worlds/:id/saves', authed, (req, res) => {
    const list = savesRepo.list(req.params.id);
    return res.json({ code: 0, message: 'ok', data: list });
  });

  // ============== SCORES ==============
  router.post('/scores', authed, (req, res) => {
    const { worldId, score } = req.body || {};
    if (!worldId || typeof score !== 'number') return res.json({ code: 400, message: 'bad_fields', data: null });
    scoresRepo.create(req.user.id, worldId, Math.max(0, Math.floor(score)));
    const best = scoresRepo.best(req.user.id, worldId);
    return res.json({ code: 0, message: 'ok', data: { best: best ? best.best : score } });
  });

  router.get('/scores/me', authed, (req, res) => {
    const list = scoresRepo.byUser(req.user.id);
    return res.json({ code: 0, message: 'ok', data: list });
  });

  // ============== ROOMS（大厅） ==============
  // 模型：**先建房 → 后建世界 → 开始游戏**。玩家可中途加入；不要求等到齐。
  //   - 人类席位上限 = 房间的 maxPlayers（1..8），由房主设定；
  //   - AI 只由玩家**手动**添加，绝不占人类名额（人类加入永不被 AI 挡住）；
  //   - 公开房间进大厅列表；私密房间需密码；
  //   - 掉线由电脑接手（engine.handOverToAI），不删除玩家；
  //   - 房主可暂停；任意玩家可存档。

  // 建房间（此时还没有世界）。兼容旧路径：带 worldId 则直接绑定一个已存在的世界。
  router.post('/rooms', authed, async (req, res) => {
    const b = req.body || {};
    // ---- 兼容旧行为：POST /rooms { worldId } → 立刻绑定既有世界 ----
    if (b.worldId) {
      const w = ensureWorld(b.worldId);
      if (!w) return res.json({ code: 404, message: 'world_not_found', data: null });
      // 归属校验（防越权）：仅世界归属者（房主）可用 worldId 绑定既有世界并改写其设置。
      // 否则任意登录用户仅凭公开房里暴露的 worldId 即可篡改他人世界的 maxPlayers 等设置。
      if (w.ownerId !== req.user.id) return res.json({ code: 403, message: 'not_owner', data: null });
      const room = await createRoom({
        ownerId: req.user.id, name: b.name, maxPlayers: b.maxPlayers || w.maxPlayers,
        visibility: b.visibility, password: b.password, mode: w.mode,
        stonesPerTurn: b.stonesPerTurn, lonelyDeathDelay: b.lonelyDeathDelay,
        victoryLines: b.victoryLines, victoryThresholds: b.victoryThresholds,
        board: b.board,
        goLimits: b.goLimits,
      });
      attachWorld(room, w.worldId, w.mode);
      // 房主已通过归属校验，可按房间设定同步席位数（电脑玩家同样占席位）
      if (b.maxPlayers) w.maxPlayers = room.maxPlayers;
      if (w.hostId == null) w.hostId = req.user.id;
      return res.json({ code: 0, message: 'ok', data: {
        code: room.code, worldId: w.worldId, mode: w.mode,
        maxPlayers: room.maxPlayers,
        stonesPerTurn: room.stonesPerTurn, lonelyDeathDelay: room.lonelyDeathDelay,
        victoryLines: room.victoryLines, victoryThresholds: room.victoryThresholds,
        board: room.board,
        goLimits: room.goLimits,
        room: roomInfo(room, req.user.id),
        invitePath: '/?room=' + room.code,
      } });
    }
    // ---- 新流程：只建房，世界稍后由房主建立 ----
    const room = await createRoom({
      ownerId: req.user.id, name: b.name, maxPlayers: b.maxPlayers,
      visibility: b.visibility, password: b.password, mode: b.mode,
      stonesPerTurn: b.stonesPerTurn, lonelyDeathDelay: b.lonelyDeathDelay,
      victoryLines: b.victoryLines, victoryThresholds: b.victoryThresholds,
      board: b.board,
      goLimits: b.goLimits,
    });
    room.members.set(req.user.id, { name: req.user.username });
    return res.json({ code: 0, message: 'ok', data: {
      code: room.code, maxPlayers: room.maxPlayers, mode: room.mode,
      stonesPerTurn: room.stonesPerTurn, lonelyDeathDelay: room.lonelyDeathDelay,
      victoryLines: room.victoryLines, victoryThresholds: room.victoryThresholds,
      board: room.board,
      goLimits: room.goLimits,
      room: roomInfo(room, req.user.id), invitePath: '/?room=' + room.code,
    } });
  });

  // 房间大厅：公开房间列表（未满、未关闭）
  router.get('/rooms', authed, (req, res) => {
    return res.json({ code: 0, message: 'ok', data: { rooms: listPublicRooms(), maxPlayers: MAX_PLAYERS } });
  });

  // 按房间号搜索（必须在 /rooms/:code 之前声明，否则 'search' 会被当成房间号）
  router.get('/rooms/search', authed, (req, res) => {
    const code = String(req.query.code || req.query.q || '').toUpperCase().trim();
    if (!code) return res.json({ code: 400, message: 'code_required', data: null });
    const room = getRoom(code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    // 私密房间只回"存在 + 需要密码"，不泄露成员与房间名
    if (room.visibility === 'private') {
      return res.json({ code: 0, message: 'ok', data: {
        code: room.code, visibility: 'private', hasPassword: !!room.passhash,
        mode: room.mode || null, phase: room.worldId ? 'ready' : 'lobby',
      } });
    }
    return res.json({ code: 0, message: 'ok', data: roomInfo(room, req.user.id) });
  });

  // 房主建立世界（先建房后建世界）
  router.post('/rooms/:code/world', authed, async (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    if (room.ownerId !== req.user.id) return res.json({ code: 403, message: 'not_owner', data: null });
    if (room.worldId) {
      // 世界已存在：用 worldForRoom 重建（带房间设置），避免走 ensureWorld() 默认设置而静默重置。
      const w0 = worldForRoom(room);
      if (w0) return res.json({ code: 0, message: 'ok', data: { worldId: room.worldId, mode: w0.mode, room: roomInfo(room, req.user.id) } });
    }
    const b = req.body || {};
    // 模式优先级：请求体显式指定 > 房间已设模式 > 'rts'。三者均为注册表归一后的模式 id。
    const md = normalizeMode(b.mode, null) || normalizeMode(room.mode, null) || 'rts';
    const id = crypto.randomBytes(8).toString('hex');
    const sd = Number.isInteger(b.seed) ? b.seed : (Math.random() * 1e9) | 0;
    worldsRepo.create(id, req.user.id, String(b.name || room.name).slice(0, 32), sd);
    const w = new WorldEngine(id, req.user.id, sd, {
      mode: md, maxPlayers: room.maxPlayers, hostId: req.user.id,
      // 房间玩法设置透传到世界
      stonesPerTurn: room.stonesPerTurn, lonelyDeathDelay: room.lonelyDeathDelay,
      // 胜利条件透传到世界（房间记录为权威；go 下由引擎再强制 gate）
      victoryLines: room.victoryLines, victoryThresholds: room.victoryThresholds,
      // 棋盘形状透传到世界（房间记录为权威）
      board: room.board,
      goLimits: room.goLimits,
      // rts 出生点（自选 / 随机）；go 无出生点概念
      spawnMode: b.spawnMode, spawnXY: b.spawnXY,
    });
    activeWorlds.set(id, w);
    attachWorld(room, id, md);
    // 开局默认暂停：世界建立后冻结，房主点「开始游戏」再取消暂停。
    // 这样"未开始不可动"用现成的房主暂停机制实现（rts 不 tick、go 落子被拦），
    // 而不是新加 started 拦截。构造器默认 paused=false 不变，单元测试 new World() 不受影响。
    w.paused = true;
    // 大厅里已经等待的成员，一次性带到新世界
    for (const [uid, info] of room.members) {
      if (!w.players[uid]) w.addPlayer(uid, (info && info.name) || ('玩家' + uid));
    }
    w.hostId = req.user.id;
    return res.json({ code: 0, message: 'ok', data: {
      worldId: id, seed: sd, mode: md, room: roomInfo(room, req.user.id),
    } });
  });

  // 房主开始游戏（不需要等玩家到齐）
  router.post('/rooms/:code/start', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    const w = worldForRoom(room);
    if (!w) return res.json({ code: 4004, message: 'world_not_ready', data: null });
    if (w.hostId !== req.user.id) return res.json({ code: 403, message: 'not_host', data: null });
    w.started = true;
    w.paused = false;        // 开始游戏 = 解冻（世界默认 paused=true，不取消暂停的话点了开始也冻着）
    return res.json({ code: 0, message: 'ok', data: { room: roomInfo(room, req.user.id) } });
  });

  // 加入房间（可中途加入；私密房间需密码；世界未建时先入大厅等待）
  router.post('/rooms/:code/join', authed, async (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    const pass = (req.body || {}).password;
    if (!(await verifyRoomPass(room, pass))) return res.json({ code: 4003, message: 'bad_password', data: null });
    room.members.set(req.user.id, { name: req.user.username });
    const w = worldForRoom(room);
    if (!w) {
      // 世界尚未建立：留在大厅等房主建房
      return res.json({ code: 0, message: 'ok', data: {
        worldId: null, mode: room.mode || null, waiting: true, room: roomInfo(room, req.user.id),
      } });
    }
    const already = !!w.players[req.user.id];
    if (!already && !w.canAcceptHuman()) return res.json({ code: 4002, message: 'room_full', data: null });
    const p = w.addPlayer(req.user.id, req.user.username);
    if (p && p.rejected) return res.json({ code: 4002, message: p.rejected, data: null });
    return res.json({ code: 0, message: 'ok', data: {
      worldId: room.worldId, mode: w.mode, snap: w.snapshot(true), you: p,
      room: roomInfo(room, req.user.id), invitePath: '/?room=' + room.code,
    } });
  });

  // 房主暂停 / 恢复（两种模式通用）
  router.post('/rooms/:code/pause', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    const w = worldForRoom(room);
    if (!w) return res.json({ code: 4004, message: 'world_not_ready', data: null });
    if (w.hostId !== req.user.id) return res.json({ code: 403, message: 'not_host', data: null });
    const b = req.body || {};
    w.paused = (typeof b.paused === 'boolean') ? b.paused : !w.paused;
    return res.json({ code: 0, message: 'ok', data: { paused: w.paused, room: roomInfo(room, req.user.id) } });
  });

  // 房主中途修改胜利条件 / 棋盘形状（仅房主；改后写回房间 + World + DB，下一次快照即生效）
  router.patch('/rooms/:code/settings', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    // 房主判定：世界已建则以世界 hostId 为准，否则用房间 ownerId（与 pause 路由同款范式）
    const w = worldForRoom(room);
    const hostId = w ? w.hostId : room.ownerId;
    if (hostId !== req.user.id) return res.json({ code: 403, message: 'not_host', data: null });
    const b = req.body || {};
    const mode = w ? w.mode : room.mode;
    // ★Q3=a 服务端强制：已开局（started）禁止改棋盘形状（不依赖前端置灰）。
    const boardTouched = Object.prototype.hasOwnProperty.call(b, 'board');
    if (boardTouched && w && w.started) {
      return res.json({ code: 403, message: 'board_locked', data: { reason: 'started' } });
    }
    const patch = {};
    if (b.victoryLines !== undefined) patch.victoryLines = normVictoryLines(b.victoryLines, mode);
    if (b.victoryThresholds !== undefined) patch.victoryThresholds = normVictoryThresholds(b.victoryThresholds);
    if (boardTouched) patch.board = normBoard(b.board, mode);   // 显式传（含 null=回默认矩形）
    // go 限制（显式传才更新；已开局后仍可改 —— 它不影响盘面合法性，只影响终局条件）
    if (b.goLimits !== undefined) patch.goLimits = normGoLimits(b.goLimits);
    const updated = setRoomSettings(room.code, patch);
    return res.json({ code: 0, message: 'ok', data: {
      victoryLines: updated.victoryLines,
      victoryThresholds: updated.victoryThresholds,
      board: updated.board,
      goLimits: updated.goLimits,
      availableLines: roomInfo(updated, req.user.id).availableLines,
      room: roomInfo(updated, req.user.id),
    } });
  });

  // 添加电脑玩家（手动；不占人类名额）
  router.post('/rooms/:code/ai', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    const w = worldForRoom(room);
    if (!w) return res.json({ code: 4004, message: 'world_not_ready', data: null });
    // 增删电脑玩家为房主专属：收紧"在座即可"的旧宽松策略，防止非房主占满席位。
    if (w.hostId !== req.user.id) return res.json({ code: 403, message: 'not_host', data: null });
    const ai = w.addAI();
    if (ai && ai.rejected) return res.json({ code: 4002, message: ai.rejected, data: null });
    return res.json({ code: 0, message: 'ok', data: { ai: { id: ai.id, name: ai.name }, room: roomInfo(room, req.user.id) } });
  });

  // 移除电脑玩家
  router.delete('/rooms/:code/ai/:aiId', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    const w = worldForRoom(room);
    if (!w) return res.json({ code: 4004, message: 'world_not_ready', data: null });
    if (w.hostId !== req.user.id) return res.json({ code: 403, message: 'not_host', data: null });
    const ok = w.removeAI(req.params.aiId);
    if (!ok) return res.json({ code: 404, message: 'ai_not_found', data: null });
    return res.json({ code: 0, message: 'ok', data: { room: roomInfo(room, req.user.id) } });
  });

  // 任意玩家存档（不限于房主）
  router.post('/rooms/:code/save', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room || room.closed) return res.json({ code: 4001, message: 'room_not_found', data: null });
    const w = worldForRoom(room);
    if (!w) return res.json({ code: 4004, message: 'world_not_ready', data: null });
    if (!w.players[req.user.id]) return res.json({ code: 403, message: 'not_in_room', data: null });
    savesRepo.create(room.worldId, w.snapshot(true));
    worldsRepo.touch(room.worldId);
    return res.json({ code: 0, message: 'ok', data: { savedAt: Date.now(), by: req.user.id } });
  });

  // 房间详情（公开可读，用于邀请链接落地页；私密房间只回存在性与是否需密码，**不泄露房名/成员**）
  router.get('/rooms/:code', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) return res.json({ code: 404, message: 'room_not_found', data: null });
    if (room.visibility === 'private') {
      // 与 GET /rooms/search 对私密房的策略保持一致：只回存在性 + 是否需密码，不回 name / players。
      return res.json({ code: 0, message: 'ok', data: {
        code: room.code, visibility: 'private', hasPassword: !!room.passhash,
        mode: room.mode || null, phase: room.worldId ? 'ready' : 'lobby',
      } });
    }
    return res.json({ code: 0, message: 'ok', data: roomInfo(room, null) });
  });

  router.delete('/rooms/:code', authed, (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) return res.json({ code: 404, message: 'room_not_found', data: null });
    if (room.ownerId !== req.user.id) return res.json({ code: 403, message: 'not_owner', data: null });
    closeRoom(req.params.code);
    return res.json({ code: 0, message: 'ok', data: null });
  });

  // ============== ADMIN（管理员 / 开发者控制台） ==============
  // 所有端点都需 authMiddleware + requireAdmin（库里 role==='admin' 才放行）
  // + adminSourceGuard（来源限制：默认仅本机，见文件顶部「管理员来源限制」说明）。
  function adminSourceGuard(req, res, next) {
    const chk = checkAdminSource(req);
    if (!chk.ok) return res.json({ code: 403, message: 'admin_restricted', data: chk });
    next();
  }
  const admin = [authMiddleware, requireAdmin, adminSourceGuard];

  function logAdmin(req, action, targetId, targetName, detail) {
    adminRepo.log({
      actorId: req.user && req.user.id,
      actorName: req.user && req.user.username,
      action,
      targetId: targetId == null ? null : targetId,
      targetName: targetName == null ? null : targetName,
      detail: detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    });
  }
  function nameOf(id) {
    if (id == null) return null;
    const u = usersRepo.byId(id);
    return u ? u.username : ('#' + id);
  }
  // 对外安全用户视图（**不含 passhash**）
  function publicUserView(u) {
    return {
      id: u.id, username: u.username, email: u.email || null, role: u.role || 'player',
      banned: !!u.banned, ban_reason: u.ban_reason || null,
      banned_at: u.banned_at || null, banned_until: u.banned_until || 0,
      created_at: u.created_at, last_login: u.last_login || null,
    };
  }
  // 收集所有未关闭房间（内存为准 + DB 中尚未水合的）
  function allRooms() {
    const seen = new Set();
    const out = [];
    for (const room of roomHub.values()) { seen.add(room.code); if (!room.closed) out.push(room); }
    let rows = [];
    try { rows = roomsRepo.active(); } catch (e) { rows = []; }
    for (const row of rows) {
      if (seen.has(row.code)) continue;
      const r = getRoom(row.code);
      if (r && !r.closed) out.push(r);
    }
    return out;
  }

  // D1 总览
  router.get('/admin/overview', admin, (req, res) => {
    const uc = usersRepo.count();
    const onlineIds = onlineUserIds();
    // 在线玩家（附用户名/封禁态），供"在线"分区直接展示与踢人
    const onlineUsers = onlineIds.map((id) => {
      const u = usersRepo.byId(id);
      return { id, username: u ? u.username : ('#' + id), banned: !!(u && u.banned) };
    });
    const rooms = allRooms();
    let pub = 0, pri = 0;
    for (const r of rooms) { if (r.visibility === 'private') pri++; else pub++; }
    let worlds = 0;
    try { worlds = worldsRepo.count(); } catch (e) { worlds = 0; }
    return res.json({ code: 0, message: 'ok', data: {
      users: uc,
      online: onlineIds.length,
      onlineUsers,
      rooms: { total: rooms.length, public: pub, private: pri },
      worlds,
      uptimeMs: Math.floor(process.uptime() * 1000),
      dbType: dbType_(),
      version: 'v4.0',
    } });
  });

  // D2 用户列表（分页 + 搜索 + 过滤）
  router.get('/admin/users', admin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize || '20', 10) || 20));
    const rawFilter = String(req.query.filter || 'all');
    const filter = ['all', 'banned', 'admin'].includes(rawFilter) ? rawFilter : 'all';
    const q = String(req.query.q || '');
    const { rows, total } = usersRepo.listAll({ q, filter, limit: pageSize, offset: (page - 1) * pageSize });
    return res.json({ code: 0, message: 'ok', data: {
      rows: rows.map(publicUserView), total, page, pageSize, filter, q,
    } });
  });

  // D3 用户详情 + worlds/rooms/scores 摘要
  router.get('/admin/users/:id', admin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.json({ code: 400, message: 'bad_id', data: null });
    const u = usersRepo.byId(id);
    if (!u) return res.json({ code: 404, message: 'user_not_found', data: null });
    let worlds = [], rooms = [], scores = [];
    try { worlds = worldsRepo.listByOwner(id).map((w) => ({ id: w.id, name: w.name, seed: w.seed, created_at: w.created_at, updated_at: w.updated_at })); } catch (e) { worlds = []; }
    try { rooms = roomsRepo.byOwner(id).map((r) => ({ code: r.code, name: r.name, visibility: r.visibility, mode: r.mode, closed: !!r.closed_at })); } catch (e) { rooms = []; }
    try { scores = scoresRepo.byUser(id); } catch (e) { scores = []; }
    return res.json({ code: 0, message: 'ok', data: { user: publicUserView(u), worlds, rooms, scores } });
  });

  // D4 封禁（并立即踢下线所有在线会话）
  router.post('/admin/users/:id/ban', admin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = usersRepo.byId(id);
    if (!target) return res.json({ code: 404, message: 'user_not_found', data: null });
    if (req.user.id === id) return res.json({ code: 400, message: 'cannot_target_self', data: null });
    // 管理员不可直接被封禁：必须先降级（否则会出现"被封管理员自救不能"的死结，
    // 也正因为 /admin/* 不叠加 requireActive，被封管理员才仍能自救——故此处从源头禁止）。
    if (target.role === 'admin') return res.json({ code: 400, message: 'cannot_ban_admin', data: null });
    const b = req.body || {};
    const hours = Number(b.durationHours);
    const dur = (Number.isFinite(hours) && hours > 0) ? hours : 0;
    const until = dur > 0 ? Date.now() + dur * 3600 * 1000 : 0;
    const reason = (typeof b.reason === 'string' && b.reason.trim()) ? b.reason.trim().slice(0, 200) : '管理员封禁';
    usersRepo.setBan(id, { banned: true, reason, until });
    const kicked = kickUser(id, 'banned', 4004);
    logAdmin(req, 'ban', id, target.username, { reason, durationHours: dur, until, kicked });
    return res.json({ code: 0, message: 'ok', data: { id, banned: true, reason, until, kicked } });
  });

  // D5 解封
  router.post('/admin/users/:id/unban', admin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = usersRepo.byId(id);
    if (!target) return res.json({ code: 404, message: 'user_not_found', data: null });
    usersRepo.setBan(id, { banned: false });
    logAdmin(req, 'unban', id, target.username, null);
    return res.json({ code: 0, message: 'ok', data: { id, banned: false } });
  });

  // D6 改角色
  router.post('/admin/users/:id/role', admin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = usersRepo.byId(id);
    if (!target) return res.json({ code: 404, message: 'user_not_found', data: null });
    const role = (req.body || {}).role;
    if (role !== 'admin' && role !== 'player') return res.json({ code: 400, message: 'bad_role', data: null });
    if (role === 'player') {
      // 先保护"最后一个管理员"，再保护"不能操作自己"：
      // 唯一管理员降级自己 → last_admin_protected（明确告知是"系统唯一管理员"这一更关键的原因）。
      if (target.role === 'admin' && usersRepo.count().admins <= 1) {
        return res.json({ code: 400, message: 'last_admin_protected', data: null });
      }
      if (req.user.id === id) return res.json({ code: 400, message: 'cannot_target_self', data: null });
    }
    usersRepo.setRole(id, role);
    logAdmin(req, 'set_role', id, target.username, { role });
    return res.json({ code: 0, message: 'ok', data: { id, role } });
  });

  // D7 仅踢下线（不封禁）
  router.post('/admin/users/:id/kick', admin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = usersRepo.byId(id);
    if (!target) return res.json({ code: 404, message: 'user_not_found', data: null });
    const kicked = kickUser(id, 'kicked_by_admin', 4004);
    logAdmin(req, 'kick', id, target.username, { kicked });
    return res.json({ code: 0, message: 'ok', data: { id, kicked } });
  });

  // D8 硬删除（需 confirmUsername 完全一致）+ 级联清理
  router.delete('/admin/users/:id', admin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = usersRepo.byId(id);
    if (!target) return res.json({ code: 404, message: 'user_not_found', data: null });
    if (req.user.id === id) return res.json({ code: 400, message: 'cannot_target_self', data: null });
    if (target.role === 'admin' && usersRepo.count().admins <= 1) {
      return res.json({ code: 400, message: 'last_admin_protected', data: null });
    }
    const confirm = (req.body || {}).confirmUsername;
    if (confirm !== target.username) return res.json({ code: 400, message: 'confirm_username_mismatch', data: null });
    try { kickUser(id, 'deleted', 4004); } catch (e) { /* 忽略 */ }
    const r = usersRepo.remove(id);
    logAdmin(req, 'delete', id, target.username, { cleaned: r.cleaned });
    return res.json({ code: 0, message: 'ok', data: { id, removed: r.removed, cleaned: r.cleaned } });
  });

  // D9 房间列表（含私密房）
  router.get('/admin/rooms', admin, (req, res) => {
    const nameCache = new Map();
    const cachedName = (uid) => {
      if (uid == null) return null;
      if (!nameCache.has(uid)) nameCache.set(uid, nameOf(uid));
      return nameCache.get(uid);
    };
    const rooms = allRooms().map((room) => {
      const info = roomInfo(room, null);
      return {
        code: room.code,
        name: room.name,
        mode: info.mode,
        visibility: room.visibility,
        maxPlayers: info.maxPlayers,
        seatCount: info.seatCount,
        humanCount: info.humanCount,
        aiCount: info.aiCount,
        phase: info.phase,
        ownerId: room.ownerId,
        ownerName: cachedName(room.ownerId),
        worldId: room.worldId || null,
      };
    });
    return res.json({ code: 0, message: 'ok', data: { rooms, total: rooms.length } });
  });

  // D10 强制关房（断开该房世界的人类成员）
  router.post('/admin/rooms/:code/close', admin, (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    const room = getRoom(code);
    if (!room) return res.json({ code: 404, message: 'room_not_found', data: null });
    let kicked = 0;
    try {
      if (room.members) {
        for (const uid of room.members.keys()) {
          if (uid !== req.user.id) kicked += kickUser(uid, 'room_closed_by_admin', 4004);
        }
      }
    } catch (e) { /* 忽略 */ }
    closeRoom(code);
    logAdmin(req, 'close_room', null, code, { kicked });
    return res.json({ code: 0, message: 'ok', data: { code, closed: true, kicked } });
  });

  // D11 审计日志（倒序）
  router.get('/admin/actions', admin, (req, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10) || 100));
    const rows = adminRepo.list(limit);
    return res.json({ code: 0, message: 'ok', data: { rows, total: rows.length } });
  });

  // ============== META ==============
  router.get('/meta', (req, res) => {
    return res.json({ code: 0, message: 'ok', data: { db: dbType_(), version: 'v4.0', kernels: 46, emergents: 14 } });
  });

  // ============== AI MOVES（用于测试） ==============
  router.get('/worlds/:id/emergents', authed, (req, res) => {
    const w = activeWorlds.get(req.params.id);
    if (!w) return res.json({ code: 404, message: 'world_not_active', data: null });
    return res.json({ code: 0, message: 'ok', data: w.entities.map(e => ({ id: e.id, type: e.type, name: e.name, x: e.x, y: e.y, hp: e.hp, color: e.color, mass: e.mass, speed: e.speed })) });
  });

  // ============== MAINTENANCE（账号维护：不活跃清理） ==============
  // 读取当前设置 + 预演将被清理的账号（不删）
  router.get('/admin/maintenance', admin, (req, res) => {
    const days = getInactiveDays();
    const pv = previewInactive();
    return res.json({
      code: 0, message: 'ok',
      data: {
        inactiveDays: days,
        defaultDays: DEFAULT_INACTIVE_DAYS,
        maxDays: MAX_INACTIVE_DAYS,
        lastPurgeAt: lastPurgeAt(),
        preview: { disabled: pv.disabled, count: pv.candidates.length, candidates: pv.candidates.slice(0, 50) },
      },
    });
  });

  // 修改阈值（天）。0 = 关闭自动清理。
  router.post('/admin/maintenance/inactive-days', admin, (req, res) => {
    const days = setInactiveDays(req.body && req.body.days);
    logAdmin(req, 'set_inactive_days', null, null, { days });
    return res.json({ code: 0, message: 'ok', data: { inactiveDays: days } });
  });

  // 立即执行一次清理
  router.post('/admin/maintenance/purge', admin, (req, res) => {
    const r = runInactivePurge(Date.now(), { id: req.user && req.user.id, username: req.user && req.user.username });
    return res.json({
      code: 0, message: 'ok',
      data: { disabled: r.disabled, days: r.days, removedCount: r.removed.length, removed: r.removed },
    });
  });

  return router;
}