// server/maintenance.js — 账号维护：定期清理不活跃账号
// 设计要点：
//   - 阈值是一个**可调设置**（存 meta 表，键 inactive_purge_days）；默认 30 天。
//   - 0 表示关闭自动清理（仍可手动执行）。
//   - 默认保留管理员；级联清理走 usersRepo.remove（worlds/saves/rooms/scores 一并清）。
//   - 纯基础设施，不在模拟层内，允许用 Date.now()。
import { usersRepo, settingsRepo, adminRepo } from './db/index.js';
import { cleanupEmptyRooms } from './rooms.js';

export const KEY_DAYS = 'inactive_purge_days';
export const KEY_LAST = 'inactive_purge_last_at';
export const DEFAULT_INACTIVE_DAYS = 30;
export const MAX_INACTIVE_DAYS = 3650;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 读取当前阈值（天）。0 = 关闭。 */
export function getInactiveDays() {
  const n = settingsRepo.getInt(KEY_DAYS, DEFAULT_INACTIVE_DAYS);
  return Math.max(0, Math.min(MAX_INACTIVE_DAYS, n));
}

/** 写入阈值（天）。非法值回退默认。返回归一化后的值。 */
export function setInactiveDays(days) {
  const n = Math.floor(Number(days));
  const v = Number.isFinite(n) ? Math.max(0, Math.min(MAX_INACTIVE_DAYS, n)) : DEFAULT_INACTIVE_DAYS;
  settingsRepo.set(KEY_DAYS, v);
  return v;
}

export function lastPurgeAt() {
  const v = settingsRepo.getInt(KEY_LAST, 0);
  return v > 0 ? v : null;
}

/** 预演：列出当前会被清理的账号（不删）。 */
export function previewInactive(now = Date.now()) {
  const days = getInactiveDays();
  if (days <= 0) return { disabled: true, days, before: null, candidates: [] };
  const before = now - days * DAY_MS;
  return { disabled: false, days, before, candidates: usersRepo.listInactive(before, { keepAdmins: true }) };
}

/**
 * 执行一次清理。
 * @returns {{disabled:boolean, days:number, before:number|null, removed:Array<{id,username}>}}
 */
export function runInactivePurge(now = Date.now(), actor = null) {
  const days = getInactiveDays();
  if (days <= 0) return { disabled: true, days, before: null, removed: [] };
  const before = now - days * DAY_MS;
  const removed = usersRepo.purgeInactive(before, { keepAdmins: true });
  settingsRepo.set(KEY_LAST, now);
  if (removed.length) {
    adminRepo.log({
      actorId: actor && actor.id != null ? actor.id : null,
      actorName: actor && actor.username ? actor.username : 'system',
      action: 'purge_inactive',
      detail: { days, count: removed.length, usernames: removed.map((r) => r.username) },
    });
  }
  return { disabled: false, days, before, removed };
}

/**
 * 启动后台调度：每隔 everyMs 跑一次（默认 6 小时；阈值 0 时为 no-op）。
 * unref 以避免阻止进程退出（线上由 http server 保活）。
 */
export function startInactivePurgeScheduler({ everyMs = 6 * 60 * 60 * 1000 } = {}) {
  const tick = () => {
    try {
      const r = runInactivePurge();
      if (!r.disabled && r.removed.length) {
        console.log('[purge] removed ' + r.removed.length + ' inactive account(s) (' + r.days + 'd)');
      }
    } catch (e) { console.error('[purge]', e && e.message); }
  };
  const t = setInterval(tick, everyMs);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

/**
 * 启动空房间清理调度：每隔 everyMs 跑一次 cleanupEmptyRooms（默认 60s）。
 * 空房间 = 无任何人类玩家（大厅成员为空 / 对局内全是 AI 代打）；带宽限期，避免瞬间掉线误清。
 * unref 以避免阻止进程退出。
 */
export function startEmptyRoomCleanupScheduler({ everyMs = 60 * 1000 } = {}) {
  const tick = () => {
    try {
      const removed = cleanupEmptyRooms();
      if (removed.length) {
        console.log('[room-cleanup] removed ' + removed.length + ' empty room(s): ' + removed.join(', '));
      }
    } catch (e) { console.error('[room-cleanup]', e && e.message); }
  };
  const t = setInterval(tick, everyMs);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}
