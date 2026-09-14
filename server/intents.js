// server/intents.js — 意图冲量合并（延迟=惯性的实现）
import { IMPULSE_MOVE, MERGE_MAX, clamp, inBounds, WORLD_W, WORLD_H } from './util.js';

// 玩家 intent 排队：每帧到达的指令按 FIFO 累积，冲量合并上限 = MERGE_MAX
// 关键：服务器**不**测量、**不**补偿延迟。慢网玩家的指令自然堆积 → 一次吃下多倍冲量 → 动量更大
export class IntentQueue {
  constructor() {
    this.pending = new Map(); // playerId -> { moveCount, jx, jy, attack, build, ... }
  }
  push(playerId, intent) {
    playerId = String(playerId);
    let q = this.pending.get(playerId);
    if (!q) { q = { moveCount: 0, jx: 0, jy: 0, attack: null, build: null, tech: null, dash: null, plant: false, chat: null }; this.pending.set(playerId, q); }
    if (intent.move) {
      // FIFO 合并：累计 moveCount，但冲量 = sign × IMPULSE_MOVE × min(moveCount, MERGE_MAX)
      q.moveCount++;
      const eff = Math.min(q.moveCount, MERGE_MAX);
      if (intent.move.dx || intent.move.dy) {
        const len = Math.hypot(intent.move.dx, intent.move.dy) || 1;
        q.jx = (intent.move.dx / len) * eff;
        q.jy = (intent.move.dy / len) * eff;
      }
    }
    if (intent.attack) q.attack = intent.attack;
    if (intent.build) q.build = intent.build;
    if (intent.tech) q.tech = intent.tech;
    if (intent.dash) q.dash = intent.dash;
    if (intent.plant) q.plant = true;
    if (intent.chat) q.chat = intent.chat;
  }
  drain(playerId) {
    playerId = String(playerId);
    const q = this.pending.get(playerId);
    if (!q) return null;
    const out = { ...q };
    this.pending.set(playerId, { moveCount: 0, jx: 0, jy: 0, attack: null, build: null, tech: null, dash: null, plant: false, chat: null });
    return out;
  }
  clear(playerId) { this.pending.delete(String(playerId)); }
  snapshot() {
    const out = {};
    for (const [k, v] of this.pending) {
      out[k] = { moveCount: v.moveCount, jx: v.jx, jy: v.jy };
    }
    return out;
  }
}

// 把冲量应用为位置位移（每 tick 一次）
export function applyImpulse(player, impulse) {
  // 速度由冲量累积；位置 = 上次位置 + 当前速度
  player.vx = player.vx * 0.85 + (impulse ? impulse.jx * IMPULSE_MOVE : 0);
  player.vy = player.vy * 0.85 + (impulse ? impulse.jy * IMPULSE_MOVE : 0);
  // 被藤蔓缠绕：减速（涌现单位在 tickEmergent 里给玩家打 _vineSlow 标记）
  if (player._vineSlow > 0) {
    player._vineSlow--;
    player.vx *= 0.45;
    player.vy *= 0.45;
  }
  // 速度上限避免失控（脉冲不暴毙）；上限随演化纪元/变异调整（单细胞爬得慢）
  const maxV = player._speedCap || 1.6;
  const sp = Math.hypot(player.vx, player.vy);
  if (sp > maxV) { player.vx = (player.vx / sp) * maxV; player.vy = (player.vy / sp) * maxV; }
  player.x = clamp(player.x + player.vx, 0, WORLD_W - 1);
  player.y = clamp(player.y + player.vy, 0, WORLD_H - 1);
}

// 不同延迟的两玩家位置碰撞：按冲量守恒结算
export function elasticCollision(p, q) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d > 1.5) return; // 距离不够
  const nx = dx / (d || 1), ny = dy / (d || 1);
  // 相对速度在法线上的投影
  const dvx = q.vx - p.vx, dvy = q.vy - p.vy;
  const vn = dvx * nx + dvy * ny;
  if (vn > 0) return; // 已经在分离
  const m1 = p.mass || 1, m2 = q.mass || 1;
  const e = 0.9; // 弹性
  const j = -(1 + e) * vn / (1 / m1 + 1 / m2);
  // 按质量分配冲量（动量守恒：m1*Δv1 + m2*Δv2 = 0）
  p.vx -= (j / m1) * nx; p.vy -= (j / m1) * ny;
  q.vx += (j / m2) * nx; q.vy += (j / m2) * ny;
  // 注意：故意不做位置推开——这会破坏动量守恒。
  // 速度方向的改变已足以让两球在下一 tick 自然分离。
}

export { IMPULSE_MOVE, MERGE_MAX };