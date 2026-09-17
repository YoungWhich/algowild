// server/roles.js — 账号级角色的单一事实来源
// 层级：player < readonly < admin < superadmin
// 与房间内的「房主」（room/engine.hostId）无关：房主按房间生效，这里是账号级权限。
export const ROLE_PLAYER = 'player';
export const ROLE_READONLY = 'readonly';
export const ROLE_ADMIN = 'admin';
export const ROLE_SUPERADMIN = 'superadmin';

/** 全部合法角色（升序层级）。 */
export const ROLES = [ROLE_PLAYER, ROLE_READONLY, ROLE_ADMIN, ROLE_SUPERADMIN];

const RANK = { player: 0, readonly: 1, admin: 2, superadmin: 3 };

/** 显示名（面向玩家：成年人语域、简洁）。 */
export const ROLE_LABEL = {
  [ROLE_SUPERADMIN]: '超管',
  [ROLE_ADMIN]: '管理员',
  [ROLE_READONLY]: '只读',
  [ROLE_PLAYER]: '玩家',
};

/** 合法角色原样返回；非法/未知一律回落 'player'。 */
export function normalizeRole(role) {
  const r = String(role);
  return Object.prototype.hasOwnProperty.call(RANK, r) ? r : ROLE_PLAYER;
}

/** 角色的层级序数（未知角色 = 玩家的 0）。 */
export function rankOf(role) {
  const r = RANK[String(role)];
  return Number.isFinite(r) ? r : 0;
}

/** 可进管理后台（只读管理员也算）。 */
export function isStaffRole(role) {
  return rankOf(role) >= rankOf(ROLE_READONLY);
}

/** 可在管理后台执行变更（ban / kick / delete / 关房 / 清理）。只读管理员为 false。 */
export function isWriterRole(role) {
  return rankOf(role) >= rankOf(ROLE_ADMIN);
}

/** 可调整其他账号的角色（改角色）：仅超管。 */
export function isSuperadmin(role) {
  return rankOf(role) >= rankOf(ROLE_SUPERADMIN);
}

/** 角色的中文显示名（未知回落「玩家」）。 */
export function roleLabel(role) {
  return ROLE_LABEL[normalizeRole(role)];
}
