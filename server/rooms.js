// server/rooms.js — 房间（大厅）模型
//
// 与旧实现的根本差异：
//   - **先建房，后建世界**：房间是玩家的集合点，worldId 可以是 ''（尚未建立世界）。
//   - **不需要等玩家到齐**：建世界即可开始，玩家可**中途加入**。
//   - **AI 由玩家手动添加**，AI 永不占用人类名额（人类加入不被 AI 挡住）。
//   - **公开 / 私密房间**：私密房间需密码才能加入；公开房间进大厅列表。
//   - **掉线由电脑接手**（见 engine.handOverToAI），不删除玩家。
//   - 房主可**暂停**、任意玩家可**存档**。
//
// 状态权威在内存（roomHub），DB 仅作尽力镜像（重启后可从 DB 水合）。
import crypto from 'node:crypto';
import { roomsRepo, settingsRepo } from './db/index.js';
import { hashPassword, verifyPassword } from './auth.js';
import { activeWorlds, worldModes, pendingIntents, tickCounters } from './worldhub.js';
import { World as WorldEngine } from './engine.js';

/** code -> room（内存为准，避免 DB 往返影响实时人数/状态） */
export const roomHub = new Map();

/** 人类席位上限：1..8（世界总席位上限同为 8，含 AI） */
export const MAX_PLAYERS = 8;

// ---- 房间玩法设置：单一事实源取 World 上的常量（引擎侧定义），缺失时回退字面量 ----
function stonesPerTurnDefault() {
  const v = WorldEngine && WorldEngine.STONES_PER_TURN_DEFAULT;
  return Number.isInteger(v) ? v : 3;
}
function lonelyDeathDelayDefault() {
  const v = WorldEngine && WorldEngine.LONELY_DEATH_DELAY_DEFAULT;
  return Number.isInteger(v) ? v : 0;
}

/** 每回合落子数：整数，钳制到 1..16；未提供/非法 → 默认。 */
export function normStonesPerTurn(v) {
  if (v === undefined || v === null || v === '') return stonesPerTurnDefault();
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return stonesPerTurnDefault();
  return Math.max(1, Math.min(16, n));
}

/** 死亡宽限回合：整数，钳制到 0..10；未提供/非法 → 默认。 */
export function normLonelyDeathDelay(v) {
  if (v === undefined || v === null || v === '') return lonelyDeathDelayDefault();
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lonelyDeathDelayDefault();
  return Math.max(0, Math.min(10, n));
}

export function normMaxPlayers(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return MAX_PLAYERS;
  return Math.max(1, Math.min(MAX_PLAYERS, Math.floor(n)));
}

// ---- 胜利条件归一：转发给引擎侧静态方法（避免重复实现，保证单一事实源）----
/**
 * 胜利线归一：非法输入回默认；go 模式下强制 economy/singularity/survival = false（防越权）。
 * @param {object|string|null|undefined} v
 * @param {('rts'|'go'|null)} mode
 * @returns {{territory:boolean, economy:boolean, singularity:boolean, survival:boolean}}
 */
export function normVictoryLines(v, mode) {
  if (WorldEngine && typeof WorldEngine.normVictoryLines === 'function') {
    return WorldEngine.normVictoryLines(v, mode);
  }
  // 兜底（engine.js 未加载）：与引擎侧同逻辑的最小实现。
  const dflt = { territory: true, economy: false, singularity: false, survival: false };
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
  const out = { ...dflt };
  if (o && typeof o === 'object') {
    for (const k of Object.keys(out)) if (typeof o[k] === 'boolean') out[k] = o[k];
  }
  if (mode === 'go') { out.economy = false; out.singularity = false; out.survival = false; }
  return out;
}

/**
 * rts 门槛归一：逐字段钳制到安全区间；非数字/空 → 默认（默认 = 原硬编码常量）。
 * @param {object|string|null|undefined} v
 * @returns {{territoryRegions:number, economyLead:number, economyHoldTicks:number,
 *            singularityThreshold:number, deathLimit:number}}
 */
export function normVictoryThresholds(v) {
  if (WorldEngine && typeof WorldEngine.normVictoryThresholds === 'function') {
    return WorldEngine.normVictoryThresholds(v);
  }
  // 兜底（engine.js 未加载）：与引擎侧同规则的钳制。
  const spec = {
    territoryRegions: { dflt: 16, lo: 6, hi: 40 },
    economyLead: { dflt: 600, lo: 200, hi: 2000 },
    economyHoldTicks: { dflt: 1800, lo: 300, hi: 6000 },
    singularityThreshold: { dflt: 30, lo: 6, hi: 200 },
    deathLimit: { dflt: 12, lo: 3, hi: 50 },
  };
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    const raw = (o && typeof o === 'object') ? o[k] : undefined;
    const n = (typeof raw === 'number' && Number.isFinite(raw)) ? Math.floor(raw)
      : (typeof raw === 'string' && Number.isFinite(Number(raw))) ? Math.floor(Number(raw)) : s.dflt;
    out[k] = Math.max(s.lo, Math.min(s.hi, n));
  }
  return out;
}

/** 该模式可用的胜利线键集（转发引擎侧；go 仅 territory）。 */
export function availableVictoryLines(mode) {
  if (WorldEngine && typeof WorldEngine.availableLines === 'function') return WorldEngine.availableLines(mode);
  return mode === 'go' ? ['territory'] : ['territory', 'economy', 'singularity', 'survival'];
}

/**
 * go 限制归一（手数上限 / 每手时限 / 超时判负次数）：转发引擎侧，保证单一事实源。
 * @param {object|string|null|undefined} v
 */
export function normGoLimits(v) {
  if (WorldEngine && typeof WorldEngine.normGoLimits === 'function') return WorldEngine.normGoLimits(v);
  // 兜底（engine.js 未加载）：与引擎侧同规则的钳制。
  const spec = {
    maxMoves: { dflt: 150, lo: 20, hi: 600 },
    turnMs: { dflt: 30000, lo: 5000, hi: 300000 },
    maxTimeouts: { dflt: 3, lo: 1, hi: 20 },
  };
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    const raw = (o && typeof o === 'object') ? o[k] : undefined;
    const n = (typeof raw === 'number' && Number.isFinite(raw)) ? Math.floor(raw)
      : (typeof raw === 'string' && Number.isFinite(Number(raw))) ? Math.floor(Number(raw)) : s.dflt;
    out[k] = Math.max(s.lo, Math.min(s.hi, n));
  }
  return out;
}

// ---- 棋盘形状归一：转发给引擎侧静态方法（避免重复实现，保证单一事实源）----
/**
 * 棋盘形状归一：非法/空/解析失败/行数或列数不符/全形状外 → null（回默认矩形）。
 * @param {object|string|null|undefined} v
 * @param {('rts'|'go'|null)} mode
 * @returns {{w:number,h:number,shape:string}|null}
 */
export function normBoard(v, mode) {
  if (WorldEngine && typeof WorldEngine.normBoard === 'function') return WorldEngine.normBoard(v, mode);
  return null;   // 兜底：引擎未加载 → 回默认矩形（不阻塞房间创建）
}

export function makeRoomCode() {
  let code;
  let guard = 0;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
    guard++;
  } while ((roomHub.has(code) || roomsRepo.get(code)) && guard < 50);
  return code;
}

/**
 * 建房。此时**不建世界**（先建房后建世界）。
 * @param {{ownerId:number, name?:string, maxPlayers?:number, visibility?:'public'|'private', password?:string, mode?:'rts'|'go'|null}} o
 */
export async function createRoom(o) {
  const code = makeRoomCode();
  const visibility = o.visibility === 'private' ? 'private' : 'public';
  const passhash = (visibility === 'private' && o.password) ? await hashPassword(String(o.password)) : null;
  const stonesPerTurn = normStonesPerTurn(o.stonesPerTurn);
  const lonelyDeathDelay = normLonelyDeathDelay(o.lonelyDeathDelay);
  const roomMode = o.mode === 'go' ? 'go' : (o.mode === 'rts' ? 'rts' : null);
  // 胜利条件（房主设定；归一后写入 → DB 镜像 → 重建时透传）
  const victoryLines = normVictoryLines(o.victoryLines, roomMode);
  const victoryThresholds = normVictoryThresholds(o.victoryThresholds);
  // 可编辑棋盘形状（房主设定；归一后写入 → DB 镜像 → 重建时透传）
  const board = normBoard(o.board, roomMode);
  // go 限制（房主设定；手数上限 / 每手时限 / 超时判负次数）
  const goLimits = normGoLimits(o.goLimits);
  const room = {
    code,
    ownerId: o.ownerId,
    name: String(o.name || '').slice(0, 32) || ('房间 ' + code),
    maxPlayers: normMaxPlayers(o.maxPlayers),
    visibility,
    passhash,
    mode: roomMode,
    // 玩法设置（房主设定；重建世界时透传，保证重启不丢）
    stonesPerTurn,
    lonelyDeathDelay,
    victoryLines,
    victoryThresholds,
    board,
    goLimits,
    worldId: '',
    // 大厅成员（世界尚未建立时也有人在房里等）——playerId -> { name }
    members: new Map(),
    createdAt: Date.now(),
    closed: false,
  };
  roomHub.set(code, room);
  try {
    roomsRepo.create(code, '', o.ownerId, room.maxPlayers, {
      visibility, passhash, name: room.name, mode: room.mode,
      stonesPerTurn, lonelyDeathDelay, victoryLines, victoryThresholds, board, goLimits,
    });
  } catch (e) { /* DB 镜像失败不影响内存房间 */ }
  return room;
}

/** 从 DB 水合一个房间到内存（服务重启后仍能按房间号找回）。 */
function hydrate(row) {
  const room = {
    code: row.code,
    ownerId: row.owner_id,
    name: row.name || ('房间 ' + row.code),
    maxPlayers: normMaxPlayers(row.max_players),
    visibility: row.visibility === 'private' ? 'private' : 'public',
    passhash: row.passhash || null,
    mode: row.mode || null,
    // 旧库缺列/为 NULL → 回退默认
    stonesPerTurn: normStonesPerTurn(row.stones_per_turn),
    lonelyDeathDelay: normLonelyDeathDelay(row.lonely_death_delay),
    victoryLines: normVictoryLines(row.victory_lines, row.mode || null),
    victoryThresholds: normVictoryThresholds(row.victory_thresholds),
    // 旧库缺列/为 NULL → null（回默认矩形）
    board: normBoard(row.board, row.mode || null),
    // 旧库缺列/为 NULL → 回默认（与旧硬编码常量一致）
    goLimits: normGoLimits(row.go_limits),
    worldId: row.world_id || '',
    members: new Map(),
    createdAt: row.created_at,
    closed: !!row.closed_at,
  };
  roomHub.set(room.code, room);
  return room;
}

export function getRoom(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  if (roomHub.has(c)) return roomHub.get(c);
  const row = roomsRepo.get(c);
  return row ? hydrate(row) : null;
}

/** 把已建立的世界挂到房间上（建世界 / 兼容旧路径时调用）。 */
export function attachWorld(room, worldId, mode) {
  room.worldId = worldId || '';
  if (mode) room.mode = mode;
  try { roomsRepo.setWorld(room.code, room.worldId, room.mode); } catch (e) { /* 忽略 */ }
}

export function closeRoom(code) {
  const room = getRoom(code);
  if (room) room.closed = true;
  try { roomsRepo.close(code); } catch (e) { /* 忽略 */ }
  return !!room;
}

/** 校验私密房间密码。公开房间恒 true。 */
export async function verifyRoomPass(room, password) {
  if (!room || room.visibility !== 'private') return true;
  if (!room.passhash) return true;   // 私密但没设密码 → 视为可进
  if (!password) return false;
  try { return await verifyPassword(String(password), room.passhash); } catch (e) { return false; }
}

/** 取房间的世界（活跃或按 room.worldId 重建）。 */
export function roomWorld(room) {
  if (!room || !room.worldId) return null;
  return activeWorlds.get(room.worldId) || null;
}

/** 对外安全的房间视图（不含 passhash）。 */
export function roomInfo(room, viewerId) {
  const w = roomWorld(room);
  const players = w ? Object.values(w.players).map(p => ({
    id: p.id, name: p.name, color: p.color,
    isAI: !!p.isAI, botControlled: !!p.botControlled,
    score: p.score, won: !!p.won, lost: !!p.lost,
  })) : [];
  const humans = players.filter(p => !p.isAI).length;
  const ais = players.filter(p => p.isAI).length;
  const cap = w ? w.seatCap() : room.maxPlayers;
  // 玩法设置：世界为权威（建好后），否则用房间记录；都没有则回退默认。
  const ws = (w && w.settings) || {};
  const stonesPerTurn = Number.isInteger(ws.stonesPerTurn) ? ws.stonesPerTurn
    : (Number.isInteger(room.stonesPerTurn) ? room.stonesPerTurn : stonesPerTurnDefault());
  const lonelyDeathDelay = Number.isInteger(ws.lonelyDeathDelay) ? ws.lonelyDeathDelay
    : (Number.isInteger(room.lonelyDeathDelay) ? room.lonelyDeathDelay : lonelyDeathDelayDefault());
  // 胜利条件：世界为权威（建好后），否则房间记录，都没有则回退默认。
  const modeNow = w ? w.mode : (room.mode || null);
  const victoryLines = (ws.victoryLines) ? ws.victoryLines
    : (room.victoryLines || normVictoryLines(null, modeNow));
  const victoryThresholds = (ws.victoryThresholds) ? ws.victoryThresholds
    : (room.victoryThresholds || normVictoryThresholds(null));
  // 棋盘形状：世界为权威（建好后），否则房间记录，都没有则 null（回默认矩形）。
  const board = (w && w.board !== undefined) ? w.board
    : (room.board !== undefined ? room.board : null);
  // go 限制：世界为权威（建好后），否则房间记录，都没有则回默认。
  const goLimits = (ws.goLimits) ? ws.goLimits
    : (room.goLimits || normGoLimits(null));
  return {
    code: room.code,
    name: room.name,
    mode: modeNow,
    visibility: room.visibility,
    hasPassword: room.visibility === 'private' && !!room.passhash,
    ownerId: room.ownerId,
    isOwner: viewerId != null && room.ownerId === viewerId,
    maxPlayers: cap,
    maxTotal: MAX_PLAYERS,
    // 玩法设置（供大厅与房内展示）
    stonesPerTurn,
    lonelyDeathDelay,
    // 胜利条件（房主可配置）+ 本模式可用开关集
    victoryLines,
    victoryThresholds,
    // 棋盘形状（房主可配置；{w,h,shape} 或 null=默认矩形）
    board,
    // go 限制（房主可配置；手数上限 / 每手时限 / 超时判负次数）
    goLimits,
    availableLines: availableVictoryLines(modeNow),
    humanCount: humans,
    aiCount: ais,
    seatCount: humans + ais,
    seatCap: cap,
    memberCount: room.members ? room.members.size : humans,
    hostId: w && w.hostId != null ? w.hostId : room.ownerId,
    // 未建世界 / 已建世界 / 已开始
    phase: room.closed ? 'closed' : (!room.worldId ? 'lobby' : (w && w.started ? 'playing' : 'ready')),
    started: !!(w && w.started),
    paused: !!(w && w.paused),
    worldId: room.worldId || null,
    players,
  };
}

/** 大厅列表：公开 + 未关闭 + 未满。 */
export function listPublicRooms() {
  const out = [];
  const seen = new Set();
  // 内存中的房间优先（含实时人数）
  for (const room of roomHub.values()) {
    seen.add(room.code);
    if (room.closed) continue;
    if (room.visibility !== 'public') continue;
    const info = roomInfo(room);
    const used = room.worldId ? info.seatCount : info.memberCount;
    if (used >= room.maxPlayers) continue;   // 满员不上榜
    out.push(info);
  }
  // DB 中尚未水合的历史房间
  let rows = [];
  try { rows = roomsRepo.publicOpen(); } catch (e) { rows = []; }
  for (const row of rows) {
    if (seen.has(row.code)) continue;
    if (row.passhash) continue;
    const room = hydrate(row);
    if (room.closed) continue;
    const info = roomInfo(room);
    const used = room.worldId ? info.seatCount : info.memberCount;
    if (used >= room.maxPlayers) continue;
    out.push(info);
  }
  out.sort((a, b) => (a.phase === 'lobby' ? -1 : 1) - (b.phase === 'lobby' ? -1 : 1));
  return out;
}

// ============== 房主中途改配置 ==============

/**
 * 房主中途修改房间的胜利条件（内存权威覆盖 + DB 镜像）。
 * 归一在调用方（routes）已完成；这里只负责写入 room 与（若世界已建）World。
 * @param {string} code 房间号
 * @param {{victoryLines?:object, victoryThresholds?:object}} patch 已归一化的设置
 * @returns {object|null} 更新后的房间（不存在则 null）
 */
export function setRoomSettings(code, patch) {
  const room = getRoom(code);
  if (!room) return null;
  if (patch && patch.victoryLines) room.victoryLines = normVictoryLines(patch.victoryLines, room.mode);
  if (patch && patch.victoryThresholds) room.victoryThresholds = normVictoryThresholds(patch.victoryThresholds);
  // 棋盘形状：显式传 board（含 null = 回默认矩形）才更新；未传则保留现状。
  const boardTouched = !!(patch && Object.prototype.hasOwnProperty.call(patch, 'board'));
  if (boardTouched) room.board = normBoard(patch.board, room.mode);
  // go 限制：显式传 goLimits 才更新（归一后写回）；未传则保留现状。
  const goLimitsTouched = !!(patch && Object.prototype.hasOwnProperty.call(patch, 'goLimits'));
  if (goLimitsTouched) room.goLimits = normGoLimits(patch.goLimits);
  // 世界已建成 → 内存权威同步覆盖（下一次快照即生效）
  const w = roomWorld(room);
  if (w) {
    if (patch && patch.victoryLines) w.victoryLines = normVictoryLines(patch.victoryLines, w.mode);
    if (patch && patch.victoryThresholds) w.victoryThresholds = normVictoryThresholds(patch.victoryThresholds);
    if (goLimitsTouched) w.goLimits = normGoLimits(room.goLimits);
    // 棋盘形状：重新编译世界内存位图（权威覆盖），下一次快照即见。
    if (boardTouched && typeof w._compileBoard === 'function') w._compileBoard(room.board);
  }
  try {
    const persist = { victoryLines: room.victoryLines, victoryThresholds: room.victoryThresholds };
    if (boardTouched) persist.board = room.board;
    if (goLimitsTouched) persist.goLimits = room.goLimits;
    roomsRepo.setSettings(room.code, persist);
  } catch (e) { /* DB 镜像失败不影响内存房间 */ }
  return room;
}

// ============== 自动清理空房间 ==============
// 「空房间」= 没有任何人类玩家：
//   - 大厅阶段：room.members 为空；
//   - 对局阶段：世界里的玩家全是 AI / 电脑代打（人类掉线会被电脑接手 → botControlled）。
// 给宽限期（默认 5 分钟）避免瞬间掉线误清；宽限内若有人回来则自动取消标记。
// 清理动作：软关闭（DB closed_at）+ 释放内存中的世界 + 移出 roomHub。与 DELETE /rooms 行为一致（不硬删）。
export const EMPTY_ROOM_GRACE_KEY = 'empty_room_grace_min';
export const DEFAULT_EMPTY_ROOM_GRACE_MIN = 5; // 0 = 立即清；上限 1440(24h)

/** 读取宽限（分钟）→ 毫秒。 */
export function emptyRoomGraceMs() {
  const v = settingsRepo.getInt(EMPTY_ROOM_GRACE_KEY, DEFAULT_EMPTY_ROOM_GRACE_MIN);
  return Math.max(0, Math.min(1440, v)) * 60 * 1000;
}

/** 房间是否还有人类玩家（大厅看 members，对局看世界里的非 AI / 非代打玩家）。 */
export function roomHasHuman(room) {
  if (room.members && room.members.size > 0) return true;
  const w = roomWorld(room);
  if (!w) return false; // 已建世界但世界不在内存：视为无人（宽限后清理）
  for (const p of Object.values(w.players)) {
    if (!p.isAI && !p.botControlled) return true;
  }
  return false;
}

/** 释放内存中的世界及其相关映射（tick 循环按 activeWorlds 迭代，删除后即停止推进）。 */
export function disposeRoomWorld(room) {
  const wid = room.worldId;
  if (!wid) return;
  activeWorlds.delete(wid);
  worldModes.delete(wid);
  pendingIntents.delete(wid);
  tickCounters.delete(wid);
}

/**
 * 执行一次空房间清理。
 * @returns {string[]} 本次清理的房间 code 列表
 */
export function cleanupEmptyRooms(now = Date.now()) {
  const grace = emptyRoomGraceMs();
  const removed = [];
  for (const room of roomHub.values()) {
    if (room.closed) continue;
    if (roomHasHuman(room)) {
      if (room._emptySince) room._emptySince = null; // 有人回来 → 取消空标记
      continue;
    }
    if (!room._emptySince) room._emptySince = now;
    if (now - room._emptySince < grace) continue;      // 宽限内，不动
    closeRoom(room.code);        // 软关闭（DB closed_at）
    disposeRoomWorld(room);      // 释放内存世界
    roomHub.delete(room.code);   // 移出内存大厅
    removed.push(room.code);
  }
  return removed;
}
