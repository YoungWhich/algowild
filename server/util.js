// server/util.js — 共享工具：确定性 RNG、冲量常量、grid helper
// 不依赖任何模块，纯函数。

// 确定性 RNG (mulberry32) — 测试可重放
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 冲量常量（SDD §6.4）
export const IMPULSE_MOVE = 0.6;   // 单次 move 指令转冲量
export const MERGE_MAX = 4;        // FIFO 合并上限
export const TICK_RATE = 20;       // TPS
export const TICK_BUDGET_MS = 50;
export const ENTITY_CAP = 512;
export const WORLD_W = 192;   // 世界放大 2x（96→192，面积 4x）：棋盘更开阔、更接近"文明/饥荒"的探索规模
export const WORLD_H = 192;
export const CHUNK_W = 16;
export const CHUNK_H = 16;
export const MAX_PLAYERS = 8;

// 边界裁剪
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const mod = (n, m) => ((n % m) + m) % m;

// Euclidean 距离（连续）
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

// 简单 A* 启发（Manhattan）
export const heur = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

// grid 坐标 ↔ chunk 坐标
export const toChunk = (x, y) => [Math.floor(x / CHUNK_W), Math.floor(y / CHUNK_H)];
export const inBounds = (x, y) => x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H;

// 远距出生点：在 N 个候选点里选一个离所有现存玩家最远的（确定性，用传入的 rng）。
// 让 4 方从地图四角各自发展、中盘在边界相遇——这是"4 方抢地"长局的前提。
export function pickSpawn(rng, existing, tries = 24, w = WORLD_W, h = WORLD_H) {
  let best = null, bestMin = -1;
  for (let i = 0; i < tries; i++) {
    const x = Math.floor(rng() * w), y = Math.floor(rng() * h);
    let mn = Infinity;
    for (const o of existing) {
      const d2 = (o.x - x) ** 2 + (o.y - y) ** 2;
      if (d2 < mn) mn = d2;
    }
    if (existing.length === 0) mn = i; // 首个玩家任意；后续都按"离大家最远"
    if (mn > bestMin) { bestMin = mn; best = [x, y]; }
  }
  return best;
}

// 简易事件总线（SDD §4.2 P7）
export class EventBus {
  constructor() { this.handlers = new Map(); }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, payload) {
    const hs = this.handlers.get(type);
    if (!hs) return;
    for (const fn of hs) try { fn(payload); } catch { /* no-op */ }
  }
}

// 通用 4 邻
export const NEI4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const NEI8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// 类型 ID — terrain
export const TERRAIN = Object.freeze({
  VOID: 0, GRASS: 1, FOREST: 2, WATER: 3, MOUNTAIN: 4, DESERT: 5,
});

// 资源 ID
export const RESOURCE = Object.freeze({
  WOOD: 1, STONE: 2, ORE: 3, CRYSTAL: 4, FOOD: 5,
});

// 单位阵营
export const FACTION = Object.freeze({ P: 'P', N: 'N' }); // P=player, N=neutral/emergent

// 安全归并：把对象合并到 state，但不破坏引用
export function mergeState(base, patch) {
  for (const k of Object.keys(patch)) base[k] = patch[k];
  return base;
}