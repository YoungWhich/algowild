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
  const room = {
    code,
    ownerId: o.ownerId,
    name: String(o.name || '').slice(0, 32) || ('房间 ' + code),
    maxPlayers: normMaxPlayers(o.maxPlayers),
    visibility,
    passhash,
    mode: o.mode === 'go' ? 'go' : (o.mode === 'rts' ? 'rts' : null),
    // 玩法设置（房主设定；重建世界时透传，保证重启不丢）
    stonesPerTurn,
    lonelyDeathDelay,
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
      stonesPerTurn, lonelyDeathDelay,
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
  return {
    code: room.code,
    name: room.name,
    mode: w ? w.mode : (room.mode || null),
    visibility: room.visibility,
    hasPassword: room.visibility === 'private' && !!room.passhash,
    ownerId: room.ownerId,
    isOwner: viewerId != null && room.ownerId === viewerId,
    maxPlayers: cap,
    maxTotal: MAX_PLAYERS,
    // 玩法设置（供大厅与房内展示）
    stonesPerTurn,
    lonelyDeathDelay,
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
