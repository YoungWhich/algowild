// server/signals.js — 算法信号驱动的涌现识别
// 设计：每个涌现单位对应一个真实算法内核。内核在小型输入上的输出越过阈值时，
// 即在该信号位置生成一个对应的涌现单位。延迟=惯性与此无关——这里是"算法即世界法则"。
// 注意：内核签名为 fn(ctx, rng, params)，params 是第三个参数。
import { mulberry32, clamp, WORLD_W, WORLD_H } from './util.js';
import { cellular_automaton } from './kernels/cellular_automaton.js';
import { rule_30 } from './kernels/rule_30.js';
import { rule_184 } from './kernels/rule_184.js';
import { reaction_diffusion } from './kernels/reaction_diffusion.js';
import { boids } from './kernels/boids.js';
import { ant_colony } from './kernels/ant_colony.js';
import { sand_pile } from './kernels/sand_pile.js';
import { l_system } from './kernels/l_system.js';
import { mst_prim } from './kernels/mst_prim.js';
import { delaunay } from './kernels/delaunay.js';
import { voronoi } from './kernels/voronoi.js';
import { predator_prey } from './kernels/predator_prey.js';
import { fuzzy_logic } from './kernels/fuzzy_logic.js';

const GW = 16, GH = 16; // 小型信号网格

function anchor(world) {
  const players = Object.values(world.players);
  if (players.length) return { ax: players[0].x, ay: players[0].y };
  // M10 世界放大后不再写死 96 时代的中点 (48,48)，用共享常量（192×192 → 96,96）
  return { ax: WORLD_W / 2, ay: WORLD_H / 2 };
}
function g2w(ax, ay, i, j) {
  return { x: clamp(ax - GW / 2 + i, 0, WORLD_W - 1), y: clamp(ay - GH / 2 + j, 0, WORLD_W - 1) };
}
function sigState(world, type, init) {
  if (!world.signals) world.signals = {};
  if (!world.signals[type]) world.signals[type] = init();
  return world.signals[type];
}
function rngOf(world) {
  if (!world._sigRng) world._sigRng = mulberry32((world.seed || 1) ^ 0x9e3779b9);
  return world._sigRng;
}
// 统一内核调用：签名为 fn(ctx, rng, params)
function K(fn, world, params) { return fn(null, rngOf(world), params); }

// ---------------- 各涌现单位的信号 detector ----------------
// 每个函数返回 { type, x, y, strength } 或 null（未达阈值）

// 流萤 ← 元胞自动机（Conway）：活细胞聚成团即闪光
function det_firefly(world) {
  const s = sigState(world, 'firefly', () => {
    const g = Array.from({ length: GW }, () => new Uint8Array(GH));
    for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++) g[i][j] = rngOf(world)() < 0.3 ? 1 : 0;
    return { grid: g };
  });
  const res = K(cellular_automaton, world, { cells: s.grid, rule: 'B3/S23' });
  s.grid = res.cells.map(a => Uint8Array.from(a));
  let live = 0, sx = 0, sy = 0;
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++) if (s.grid[i][j]) { live++; sx += i; sy += j; }
  if (live < 4) return null;
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, Math.round(sx / live), Math.round(sy / live));
  return { type: 'firefly', x: c.x, y: c.y, strength: clamp(live / 40, 0, 1) };
}

// 脉冲 ← Rule 30（1D CA）：必有活细胞，作为稳定信号源
function det_pulse(world) {
  const s = sigState(world, 'pulse', () => { const r = new Uint8Array(GW); r[GW >> 1] = 1; return { row: r }; });
  const res = K(rule_30, world, { cells: s.row, w: GW, iters: 1 });
  s.row = Uint8Array.from(res.grid[res.grid.length - 1]);
  let live = 0, sx = 0;
  for (let i = 0; i < GW; i++) if (s.row[i]) { live++; sx += i; }
  if (live < 1) return null;
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, Math.round(sx / live), GH >> 1);
  return { type: 'pulse', x: c.x, y: c.y, strength: clamp(live / GW, 0, 1) };
}

// 火灵 ← Rule 184（交通流）：堵车即火
function det_fire(world) {
  const s = sigState(world, 'fire', () => {
    const r = new Uint8Array(GW);
    for (let i = 0; i < GW; i++) r[i] = rngOf(world)() < 0.5 ? 1 : 0;
    r[GW >> 1] = 1; return { row: r };
  });
  const res = K(rule_184, world, { cells: s.row, w: GW, iters: 1 });
  s.row = Uint8Array.from(res.grid[res.grid.length - 1]);
  let best = 0, cur = 0, pos = GW >> 1;
  for (let i = 0; i < GW; i++) { if (s.row[i]) { cur++; if (cur > best) { best = cur; pos = i; } } else cur = 0; }
  if (best < 3) return null;
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, pos, GH >> 1);
  return { type: 'fire', x: c.x, y: c.y, strength: clamp(best / 8, 0, 1) };
}

// 结晶 / 噬晶兽 ← 反应扩散（Gray-Scott）：高 v 浓度即晶化
function makeRD() {
  const u = Array.from({ length: GW }, () => new Array(GH).fill(1));
  const v = Array.from({ length: GW }, () => new Array(GH).fill(0));
  for (let i = GW / 2 - 2; i < GW / 2 + 2; i++) for (let j = GH / 2 - 2; j < GH / 2 + 2; j++) v[i][j] = 0.5;
  return { u, v };
}
function det_crystal(world) {
  const s = sigState(world, 'crystal', makeRD);
  const res = K(reaction_diffusion, world, { u: s.u, v: s.v, w: GW, h: GH });
  s.u = res.u; s.v = res.v;
  let maxV = -1, mi = GW >> 1, mj = GH >> 1;
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++) if (s.v[i][j] > maxV) { maxV = s.v[i][j]; mi = i; mj = j; }
  if (maxV < 0.3) return null;
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, mi, mj);
  return { type: 'crystal', x: c.x, y: c.y, strength: clamp(maxV, 0, 1) };
}
function det_crystalite(world) {
  const s = sigState(world, 'crystalite', makeRD);
  const res = K(reaction_diffusion, world, { u: s.u, v: s.v, w: GW, h: GH });
  s.u = res.u; s.v = res.v;
  let maxV = -1, mi = GW >> 1, mj = GH >> 1;
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++) if (s.v[i][j] > maxV) { maxV = s.v[i][j]; mi = i; mj = j; }
  if (maxV < 0.5) return null; // 更高阈值 → 更稀有
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, mi, mj);
  return { type: 'crystalite', x: c.x, y: c.y, strength: clamp(maxV, 0, 1) };
}

// 羽群 ← Boids：智能体（玩家+涌现体）形成高对齐集群
function det_feather(world) {
  const agents = [];
  for (const p of Object.values(world.players)) agents.push({ x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0 });
  for (const e of world.entities) agents.push({ x: e.x, y: e.y, vx: e.vx || 0, vy: e.vy || 0 });
  if (agents.length < 3) return null;
  const res = K(boids, world, { boids: agents, sepR: 8, aliR: 16, cohR: 16, maxV: 1.6 });
  const out = res.boids;
  let align = 0, n = 0;
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) > 16) continue;
    const la = Math.hypot(a.vx, a.vy), lb = Math.hypot(b.vx, b.vy);
    if (la < 1e-3 || lb < 1e-3) continue;
    align += (a.vx * b.vx + a.vy * b.vy) / (la * lb); n++;
  }
  if (n === 0) return null;
  align /= n;
  let cx = 0, cy = 0; for (const a of out) { cx += a.x; cy += a.y; } cx /= out.length; cy /= out.length;
  let spread = 0; for (const a of out) spread += Math.hypot(a.x - cx, a.y - cy); spread /= out.length;
  if (align < 0.55 || spread > 22) return null;
  return { type: 'feather', x: clamp(cx, 0, WORLD_W - 1), y: clamp(cy, 0, WORLD_W - 1), strength: clamp(align, 0, 1) };
}

// 蚁工 ← 蚁群信息素：资源点注入信息素，蚂蚁沿路径堆积
function det_ant(world) {
  const { ax, ay } = anchor(world);
  const s = sigState(world, 'ant', () => ({ grid: Array.from({ length: GW }, () => new Array(GH).fill(0)) }));
  for (let rx = 0; rx < WORLD_W; rx++) for (let ry = 0; ry < WORLD_H; ry++) {
    if (world.resources[rx] && world.resources[rx][ry]) {
      const gi = Math.round(rx - ax + GW / 2), gj = Math.round(ry - ay + GH / 2);
      if (gi >= 0 && gi < GW && gj >= 0 && gj < GH) s.grid[gi][gj] = Math.min(2, s.grid[gi][gj] + 0.5);
    }
  }
  const res = K(ant_colony, world, { grid: s.grid, ants: [{ x: 0, y: 0 }], start: { x: 0, y: 0 }, evap: 0.05, alpha: 1, beta: 1 });
  s.grid = res.tau;
  let maxT = -1, mi = 0, mj = 0;
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++) if (s.grid[i][j] > maxT) { maxT = s.grid[i][j]; mi = i; mj = j; }
  if (maxT < 0.6) return null;
  const c = g2w(ax, ay, mi, mj);
  return { type: 'ant', x: c.x, y: c.y, strength: clamp(maxT / 2, 0, 1) };
}

// 砂兽 ← 沙堆模型：崩塌（topple）即兽
function det_sandbeast(world) {
  const s = sigState(world, 'sandbeast', () => {
    const g = Array.from({ length: GW }, () => new Array(GH).fill(0));
    g[GH >> 1][GW >> 1] = 5; return { grid: g };
  });
  const col = Math.floor(rngOf(world)() * GW);
  s.grid[GH >> 1][col] += 1;
  const res = K(sand_pile, world, { grid: s.grid, threshold: 4 });
  s.grid = res.grid;
  if (res.topple <= 0) return null;
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, GH >> 1, col);
  return { type: 'sandbeast', x: c.x, y: c.y, strength: clamp(res.topple / 8, 0, 1) };
}

// 藤蔓 ← L-system：字符串长度增长即生长
function det_vine(world) {
  const s = sigState(world, 'vine', () => ({ iter: 0 }));
  s.iter++;
  const res = K(l_system, world, { axiom: 'X', rules: { X: 'F+[[X]-X]-F[-FX]+X', F: 'FF' }, iters: Math.min(s.iter, 6) });
  const len = res.str.length;
  if (len < 120) return null;
  const { ax, ay } = anchor(world);
  const off = (s.iter * 7) % 24 - 12;
  return { type: 'vine', x: clamp(ax + off, 0, WORLD_W - 1), y: clamp(ay + off * 0.5, 0, WORLD_W - 1), strength: clamp(len / 600, 0, 1) };
}

// 守卫 ← MST（Prim）：节点全连通即守护网络
function samplePoints(world, n) {
  const pts = [];
  for (const p of Object.values(world.players)) pts.push({ x: p.x, y: p.y });
  for (const e of world.entities) pts.push({ x: e.x, y: e.y });
  let cnt = 0;
  for (let rx = 0; rx < WORLD_W && cnt < 40; rx += 7) for (let ry = 0; ry < WORLD_H && cnt < 40; ry += 7) {
    if (world.resources[rx] && world.resources[rx][ry]) { pts.push({ x: rx, y: ry }); cnt++; }
  }
  const out = []; const used = new Set();
  while (out.length < n && used.size < pts.length) {
    const k = Math.floor(rngOf(world)() * pts.length);
    if (used.has(k)) continue; used.add(k); out.push(pts[k]);
  }
  return out;
}
function det_guardian(world) {
  const pts = samplePoints(world, 8);
  if (pts.length < 3) return null;
  const nodes = pts.map((p, i) => i);
  const edges = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.round(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    edges.push([i, j, Math.max(1, Math.min(200, d))]);
  }
  const res = K(mst_prim, world, { nodes, edges });
  if (res.edges.length < pts.length - 1) return null; // 未连通
  let cx = 0, cy = 0; for (const p of pts) { cx += p.x; cy += p.y; } cx /= pts.length; cy /= pts.length;
  return { type: 'guardian', x: clamp(cx, 0, WORLD_W - 1), y: clamp(cy, 0, WORLD_W - 1), strength: 1 };
}

// 界碑 ← Delaunay：存在小三角形即锚点
function det_keystone(world) {
  const pts = samplePoints(world, 8);
  if (pts.length < 3) return null;
  const res = K(delaunay, world, { points: pts });
  if (!res.triangles.length) return null;
  let best = null, bestArea = Infinity;
  for (const [i, j, k] of res.triangles) {
    const a = pts[i], b = pts[j], c = pts[k];
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    if (area < bestArea) { bestArea = area; best = { a, b, c }; }
  }
  if (!best) return null;
  const cx = (best.a.x + best.b.x + best.c.x) / 3, cy = (best.a.y + best.b.y + best.c.y) / 3;
  return { type: 'keystone', x: clamp(cx, 0, WORLD_W - 1), y: clamp(cy, 0, WORLD_W - 1), strength: clamp(res.triangles.length / 5, 0, 1) };
}

// 矿脉 ← Voronoi：分区边界即矿脉
function det_vein(world) {
  const sites = samplePoints(world, 8);
  if (sites.length < 2) return null;
  const res = K(voronoi, world, { sites, w: GW, h: GH });
  const cells = res.cells;
  let boundary = 0, bi = GW >> 1, bj = GH >> 1;
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++) {
    const v = cells[i][j];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + dx, nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
      if (cells[ni][nj] !== v) { boundary++; bi = i; bj = j; break; }
    }
  }
  if (boundary < 8) return null;
  const { ax, ay } = anchor(world);
  const c = g2w(ax, ay, bi, bj);
  return { type: 'vein', x: c.x, y: c.y, strength: clamp(boundary / (GW * GH), 0, 1) };
}

// 环噬 ← 捕食者-猎物（Lotka-Volterra）：生态在平衡震荡窗口即环噬
function det_ring(world) {
  const s = sigState(world, 'ring', () => ({ prey: 10, pred: 5 }));
  const res = K(predator_prey, world, { prey: s.prey, pred: s.pred, steps: 1 });
  s.prey = Math.max(1, res.prey); s.pred = Math.max(1, res.pred);
  if (s.pred >= 3 && s.pred <= 14 && s.prey >= 3 && s.prey <= 25) {
    const { ax, ay } = anchor(world);
    return {
      type: 'ring',
      x: clamp(ax + (rngOf(world)() * 20 - 10), 0, WORLD_W - 1),
      y: clamp(ay + (rngOf(world)() * 20 - 10), 0, WORLD_W - 1),
      strength: clamp(s.pred / 15, 0, 1),
    };
  }
  return null;
}

// 衡者 ← 模糊推理：实体少而科技高 → 失衡需平衡
function det_equalizer(world) {
  const players = Object.keys(world.players).length;
  const ents = world.entities.length;
  const techSum = Object.values(world.tech || {}).reduce((a, b) => a + b, 0);
  const inp = { players, entities: ents, tech: techSum, phase: world.tick % 100 };
  const rules = [
    { ifs: { entities: { c: 6, w: 5 }, tech: { c: 8, w: 8 } }, then: { c: 1 } },
    { ifs: { players: { c: 3, w: 3 }, entities: { c: 6, w: 5 } }, then: { c: 0.8 } },
  ];
  const res = K(fuzzy_logic, world, { inp, rules });
  if (res.out < 0.6) return null;
  const { ax, ay } = anchor(world);
  return { type: 'equalizer', x: clamp(ax, 0, WORLD_W - 1), y: clamp(ay, 0, WORLD_W - 1), strength: clamp(res.out, 0, 1) };
}

const DETS = [
  det_firefly, det_pulse, det_crystal, det_feather, det_ant, det_sandbeast,
  det_fire, det_vine, det_guardian, det_keystone, det_crystalite, det_vein, det_ring, det_equalizer,
];

export function initSignals(world) {
  if (!world.signals) world.signals = {};
  if (!world._sigRng) world._sigRng = mulberry32((world.seed || 1) ^ 0x9e3779b9);
}

// 每 tick 跑一个 detector（轮转），返回候选生成或 null
export function stepSignals(world, tickNum) {
  if (!world._sigRng) world._sigRng = mulberry32((world.seed || 1) ^ 0x9e3779b9);
  const idx = ((tickNum % DETS.length) + DETS.length) % DETS.length;
  try {
    return DETS[idx](world);
  } catch {
    return null;
  }
}
