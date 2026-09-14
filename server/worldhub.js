// server/worldhub.js — 内存中的活跃世界（避免重复创建）
export const activeWorlds = new Map();
export const worldModes = new Map(); // worldId -> 'rts' | 'go'（DB 无 mode 列，内存记住以支撑重建）
export const pendingIntents = new Map(); // worldId -> Map<playerId, intent[]>
export const tickCounters = new Map(); // worldId -> tick count

export function registerIntent(worldId, playerId, intent) {
  if (!pendingIntents.has(worldId)) pendingIntents.set(worldId, new Map());
  const m = pendingIntents.get(worldId);
  if (!m.has(playerId)) m.set(playerId, []);
  m.get(playerId).push(intent);
}

export function drainIntents(worldId) {
  const m = pendingIntents.get(worldId);
  pendingIntents.delete(worldId);
  return m || new Map();
}