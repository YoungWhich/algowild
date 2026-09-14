// server/emergent.js — 涌现识别器（14 种生物单位）
import { ENTITY_CAP, clamp, WORLD_W, WORLD_H } from './util.js';
import { stepSignals } from './signals.js';

// EMERGENTS 表 — 每个单位的物理属性 + 行为模式（behavior）。
// behavior 决定 tickEmergent 里该单位怎么动 / 怎么增殖，彻底取代旧版"所有会动的单位都朝玩家飘"的单一逻辑。
// 生物学隐喻（参考：细胞/微生物/病毒、原核/真核、分解者/捕食者/生产者、无性出芽、以及元气骑士等弹幕游戏的小怪攻击模式）：
//   wander   游荡型 —— 完全无视玩家，随机漂浮（流萤）
//   dart     冲刺型 —— 高速直线乱窜，无视玩家（脉冲）
//   flock    聚群型 —— 同类 boids 聚群飞行（羽群）
//   forage   觅食型 —— 沿信息素（同类）缓慢集群游荡（蚁工）
//   charger  冲锋型 —— 平时慢速游荡，玩家进入半径→高速冲撞（砂兽·危险）
//   hunter   猎杀型 —— 主动追猎最近玩家，贴身造成伤害（火灵·噬晶兽）
//   orbiter  盘旋型 —— 绕玩家盘旋觅食，不直接硬撞（环噬·敌对）
//   grow     增殖型 —— 原地不动，定时出芽增殖（藤蔓·植物）
//   static   静物型 —— 完全静止的景观/资源/守卫（结晶/界碑/矿脉/守卫/衡者）
export const EMERGENTS = {
  firefly:   { name: '流萤',   mass: 0.3, speed: 0.9, hp: 2,  color: '#ffd56b', from: 'cellular_automaton', faction: 'neutral', shape: 'circle',   behavior: 'wander',  effect: '漂浮微光·无害·随机游荡' },
  pulse:     { name: '脉冲',   mass: 0.1, speed: 1.8, hp: 1,  color: '#9be7ff', from: 'rule_30/90',         faction: 'neutral', shape: 'triangle', behavior: 'dart',    effect: '规则波纹·极快直线冲刺' },
  crystal:   { name: '结晶',   mass: 1.0, speed: 0.0, hp: 16, color: '#cfd8ff', from: 'reaction_diffusion', faction: 'neutral', shape: 'diamond',  behavior: 'static',  effect: '静止结晶·极耐打' },
  feather:   { name: '羽群',   mass: 0.2, speed: 1.0, hp: 1,  color: '#e6c8ff', from: 'boids',               faction: 'neutral', shape: 'star',     behavior: 'flock',   effect: '群体同向飞行·聚群' },
  ant:       { name: '蚁工',   mass: 0.4, speed: 0.7, hp: 3,  color: '#ff9e6a', from: 'ant_colony',          faction: 'neutral', shape: 'square',   behavior: 'forage',  effect: '沿信息素游荡·集群搬运' },
  sandbeast: { name: '砂兽',   mass: 1.5, speed: 0.4, hp: 16, color: '#c2a37b', from: 'sand_pile',           faction: 'neutral', shape: 'hex',      behavior: 'charger', danger: true, effect: '靠近时高速冲撞·重伤' },
  fire:      { name: '火灵',   mass: 0.1, speed: 1.4, hp: 3,  color: '#ff6b3d', from: 'rule_184',            faction: 'neutral', shape: 'spike',    behavior: 'hunter',  danger: true, effect: '主动猎杀·接触灼烧' },
  vine:      { name: '藤蔓',   mass: 0.6, speed: 0.0, hp: 10, color: '#9ee37a', from: 'l_system',            faction: 'neutral', shape: 'cross',    behavior: 'grow',    effect: '原地增殖·缠绕减速' },
  guardian:  { name: '守卫',   mass: 1.2, speed: 0.0, hp: 14, color: '#7aa3ff', from: 'mst_prim',            faction: 'neutral', shape: 'ring',     behavior: 'static',  effect: '静止·守护己方连线' },
  keystone:  { name: '界碑',   mass: 1.0, speed: 0.0, hp: 12, color: '#d0d4ff', from: 'delaunay',            faction: 'neutral', shape: 'bar',      behavior: 'static',  effect: '静止·加固邻近己方' },
  crystalite:{ name: '噬晶兽', mass: 1.8, speed: 0.5, hp: 20, color: '#ff7be0', from: 'reaction_diffusion', faction: 'hostile', shape: 'octagon',  behavior: 'hunter',  effect: '敌对·吞噬细胞·猎杀' },
  vein:      { name: '矿脉',   mass: 1.0, speed: 0.0, hp: 10, color: '#cfa56b', from: 'voronoi',             faction: 'neutral', shape: 'oval',     behavior: 'static',  effect: '静止·产出资源' },
  ring:      { name: '环噬',   mass: 0.8, speed: 0.8, hp: 6,  color: '#b39bff', from: 'predator_prey',       faction: 'hostile', shape: 'chevron',  behavior: 'orbiter', effect: '敌对·盘旋觅食' },
  equalizer: { name: '衡者',   mass: 1.0, speed: 0.0, hp: 12, color: '#dadada', from: 'fuzzy_logic',         faction: 'neutral', shape: 'gem',      behavior: 'static',  effect: '静止·平衡势力' },
};

// 算法信号驱动：每 tick 由对应内核输出决定是否生成一个涌现单位
// stepSignals 返回 { type, x, y, strength } 或 null（门槛未达）。
// 每个类型有冷却，避免刷屏；总量受 ENTITY_CAP 限制。
const SPAWN_COOLDOWN = 80;

// 实体碰撞半径：r = 0.35 + 0.28 * sqrt(mass)。生成时写入 e.r；
// 缺省（旧存档/早期生成）由 emergentRadius(mass) 现算，保证向后兼容。
export function emergentRadius(mass) {
  const m = (typeof mass === 'number' && mass > 0) ? mass : 1;
  return 0.35 + 0.28 * Math.sqrt(m);
}
// 敌对单位的最小生成距离：候选点距任一存活玩家 < SAFE_SPAWN_DIST 时**放弃本次生成**
// （不挪位、不改 RNG 序列，保持确定性）。避免开局被贴脸刷怪秒杀。
export const SAFE_SPAWN_DIST = 12;

/** 候选点是否离某个存活玩家过近（导出以便测试直接断言生成保护半径）。 */
export function tooCloseToPlayer(world, x, y, dist) {
  const d2 = dist * dist;
  for (const pid of Object.keys(world.players)) {
    const p = world.players[pid];
    if (!p || !p.alive) continue;
    const dx = p.x - x, dy = p.y - y;
    if (dx * dx + dy * dy < d2) return true;
  }
  return false;
}

/** 增殖型（藤蔓）参数：单世界最多藤蔓数 + 出芽间隔 + 首芽延迟（单位 tick）。 */
const VINE_CAP = 48;
const GROW_INTERVAL = 240; // 12s 出芽一次
const GROW_FIRST = 120;    // 首次出芽延迟 6s
const VINE_SLOW_TICKS = 20;
const VINE_SLOW_RANGE = 1.4;

export function recognizeEmergent(world, tickNum) {
  if (world.entities.length >= ENTITY_CAP) return;
  const cand = stepSignals(world, tickNum);
  if (!cand) return;
  if (!world._spawnCd) world._spawnCd = {};
  const last = world._spawnCd[cand.type] || -1e9;
  if (tickNum - last < SPAWN_COOLDOWN) return;
  const cfg = EMERGENTS[cand.type];
  if (!cfg) return;
  const ex = clamp(cand.x, 0, WORLD_W - 1), ey = clamp(cand.y, 0, WORLD_H - 1);
  // 敌对单位禁止贴脸生成：距离任一存活玩家 < SAFE_SPAWN_DIST → 放弃本次生成
  // （不消耗冷却，下一 tick 可重试；判定不引入随机，完全确定）。
  if (cfg.faction === 'hostile' && tooCloseToPlayer(world, ex, ey, SAFE_SPAWN_DIST)) return;
  world._spawnCd[cand.type] = tickNum;
  const id = `${cand.type}_${world.worldId}_${world.entities.length}_${tickNum}`;
  world.entities.push({
    id, type: cand.type, name: cfg.name, x: ex, y: ey,
    vx: 0, vy: 0, mass: cfg.mass, speed: cfg.speed,
    r: emergentRadius(cfg.mass),
    hp: cfg.hp, hpMax: cfg.hp, color: cfg.color, from: cfg.from,
    shape: cfg.shape, effect: cfg.effect,
    faction: cfg.faction || 'neutral',
    behavior: cfg.behavior || 'wander',
    danger: !!cfg.danger,          // 杀伤性单位（火灵·灼烧 / 砂兽·冲撞）都会撞伤玩家。
    born: tickNum, life: 600,
  });
}

/** 实体半径（优先用生成时写入的 e.r，缺省按质量现算）。 */
function radiusOf(e) {
  return (typeof e.r === 'number' && e.r > 0) ? e.r : emergentRadius(e.mass);
}
/** speed===0 的静态单位（crystal/keystone/vein/equalizer/vine…）视为不可推动。 */
function isStaticEntity(e) {
  return !e.speed || e.speed <= 0;
}

/** 最近存活玩家（确定性：按对象遍历顺序，第一个最近者胜）。返回 {p, d}。 */
function nearestPlayer(world, e) {
  let best = null, bd = Infinity;
  for (const pid of Object.keys(world.players)) {
    const p = world.players[pid];
    if (!p || !p.alive) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d < bd) { bd = d; best = p; }
  }
  return { p: best, d: bd };
}

/** 沿当前速度积分位置（外部已把速度夹在 e.speed 上限内）。 */
function integrate(e) {
  const sp = Math.hypot(e.vx, e.vy);
  const maxV = e.speed || 0;
  if (sp > maxV) { e.vx = (e.vx / sp) * maxV; e.vy = (e.vy / sp) * maxV; }
  e.x = clamp(e.x + e.vx, 0, WORLD_W - 1);
  e.y = clamp(e.y + e.vy, 0, WORLD_H - 1);
}

/** 藤蔓出芽：在 8 邻域里挑一个空位再生一颗藤蔓（无性增殖）。确定性（用 world._rng 洗牌）。 */
function tryGrowVine(world, e, rng, born) {
  let vineCount = 0;
  for (const o of world.entities) if (o.type === 'vine' && o.hp > 0) vineCount++;
  if (vineCount >= VINE_CAP) return;
  if (world.entities.length + born.length >= ENTITY_CAP) return;
  const dirs = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  // Fisher–Yates 确定性洗牌（用 world._rng，不影响确定性）
  for (let k = 0; k < dirs.length; k++) {
    const j = k + Math.floor(rng() * (dirs.length - k));
    const t = dirs[k]; dirs[k] = dirs[j]; dirs[j] = t;
  }
  const cfg = EMERGENTS.vine;
  for (const [dx, dy] of dirs) {
    const nx = clamp(e.x + dx, 0, WORLD_W - 1), ny = clamp(e.y + dy, 0, WORLD_H - 1);
    let occupied = false;
    for (const o of world.entities) {
      if (o.hp > 0 && Math.hypot(o.x - nx, o.y - ny) < 0.6) { occupied = true; break; }
    }
    if (occupied) continue;
    born.push({
      id: `vine_${world.worldId}_${world.tick}_${born.length}`, type: 'vine', name: cfg.name,
      x: nx, y: ny, vx: 0, vy: 0, mass: cfg.mass, speed: 0, r: emergentRadius(cfg.mass),
      hp: cfg.hp, hpMax: cfg.hp, color: cfg.color, from: cfg.from, shape: cfg.shape,
      effect: cfg.effect, faction: cfg.faction, behavior: 'grow', danger: false,
      born: world.tick, life: 600, _growCd: GROW_INTERVAL + Math.floor(rng() * 40),
    });
    return;
  }
}

/**
 * 每 tick 行为调度：按 e.behavior 分派，彻底取代旧版"所有会动单位都朝玩家飘"的单一逻辑。
 * 设计约束（与原版一致）：
 *  · 全程仅用 world._rng（mulberry32），禁 Math.random / Date.now → 同 seed 同轨迹（RS-03 依赖）。
 *  · 新生成的子代先放进 born[]，循环结束后再并入 world.entities，避免"同 tick 内迭代到新生体"导致连锁增殖。
 *  · 推挤分离（separateEntities）放在末尾，对全部实体统一处理；静态/增殖单位 speed=0 → 不被推动。
 */
export function tickEmergent(world) {
  const rng = world._rng;
  const players = world.players;
  const born = [];
  for (const e of world.entities) {
    if (e.hp <= 0) continue;
    e.life--;
    if (e.life <= 0) { e.hp = 0; continue; }
    const beh = e.behavior || 'wander';

    // 静物型：完全不动（结晶/界碑/矿脉/守卫/衡者）。
    if (beh === 'static') { e.vx = 0; e.vy = 0; continue; }

    // 增殖型（藤蔓）：原地不动；缠绕减速靠近的玩家；定时出芽。
    if (beh === 'grow') {
      e.vx = 0; e.vy = 0;
      for (const pid of Object.keys(players)) {
        const p = players[pid];
        if (!p || !p.alive) continue;
        if (Math.hypot(p.x - e.x, p.y - e.y) < VINE_SLOW_RANGE) {
          p._vineSlow = Math.max(p._vineSlow || 0, VINE_SLOW_TICKS);
        }
      }
      e._growCd = (e._growCd == null) ? GROW_FIRST : e._growCd - 1;
      if (e._growCd <= 0) { e._growCd = GROW_INTERVAL; tryGrowVine(world, e, rng, born); }
      continue;
    }

    // —— 以下为会动的行为 ——
    switch (beh) {
      case 'dart': {
        // 高速直线冲刺，偶尔改变朝向（无视玩家）。
        if (e._hd == null) e._hd = rng() * Math.PI * 2;
        if (rng() < 0.05) e._hd = rng() * Math.PI * 2;
        e.vx = Math.cos(e._hd) * e.speed;
        e.vy = Math.sin(e._hd) * e.speed;
        break;
      }
      case 'flock': {
        // 羽群：boids 简化版（聚群 + 对齐），只与同类互动。
        let ax = 0, ay = 0, avx = 0, avy = 0, cnt = 0;
        for (const o of world.entities) {
          if (o === e || o.type !== 'feather' || o.hp <= 0) continue;
          const dx = o.x - e.x, dy = o.y - e.y, d2 = dx * dx + dy * dy;
          if (d2 < 64) { ax += o.x; ay += o.y; avx += o.vx; avy += o.vy; cnt++; }
        }
        if (cnt) {
          ax = ax / cnt - e.x; ay = ay / cnt - e.y;
          e.vx += ax * 0.004 + avx / cnt * 0.02;
          e.vy += ay * 0.004 + avy / cnt * 0.02;
        } else if (rng() < 0.25) {
          e.vx += (rng() - 0.5) * 0.1; e.vy += (rng() - 0.5) * 0.1;
        }
        e.vx *= 0.95; e.vy *= 0.95;
        break;
      }
      case 'forage': {
        // 蚁工：沿信息素（最近同类）缓慢集群，否则随机游荡。
        let tx = null, ty = null, bd = 36;
        for (const o of world.entities) {
          if (o === e || o.type !== 'ant' || o.hp <= 0) continue;
          const d = Math.hypot(o.x - e.x, o.y - e.y);
          if (d < bd) { bd = d; tx = o.x; ty = o.y; }
        }
        if (tx != null) { e.vx += (tx - e.x) * 0.004; e.vy += (ty - e.y) * 0.004; }
        else if (rng() < 0.3) { e.vx += (rng() - 0.5) * 0.08; e.vy += (rng() - 0.5) * 0.08; }
        e.vx *= 0.9; e.vy *= 0.9;
        break;
      }
      case 'charger': {
        // 砂兽：玩家进入冲锋半径→高速冲撞；否则慢速游荡。
        const { p, d } = nearestPlayer(world, e);
        if (p && d < 18) {
          const dx = p.x - e.x, dy = p.y - e.y, l = Math.hypot(dx, dy) || 1;
          e.vx += (dx / l) * 0.07; e.vy += (dy / l) * 0.07;
        } else if (rng() < 0.2) {
          e.vx += (rng() - 0.5) * 0.05; e.vy += (rng() - 0.5) * 0.05;
          e.vx *= 0.9; e.vy *= 0.9;
        }
        break;
      }
      case 'hunter': {
        // 火灵 / 噬晶兽：主动追猎最近玩家（全球范围），贴身造成伤害。
        const { p } = nearestPlayer(world, e);
        if (p) {
          const dx = p.x - e.x, dy = p.y - e.y, l = Math.hypot(dx, dy) || 1;
          e.vx = e.vx * 0.8 + (dx / l) * 0.07;
          e.vy = e.vy * 0.8 + (dy / l) * 0.07;
        } else if (rng() < 0.3) {
          e.vx += (rng() - 0.5) * 0.1; e.vy += (rng() - 0.5) * 0.1;
        }
        break;
      }
      case 'orbiter': {
        // 环噬：绕玩家盘旋觅食（保持半径 + 切向运动），不直接硬撞。
        const { p, d } = nearestPlayer(world, e);
        if (p) {
          const dx = p.x - e.x, dy = p.y - e.y, l = Math.hypot(dx, dy) || 1;
          if (e._orbitDir == null) e._orbitDir = rng() < 0.5 ? 1 : -1;
          const tx = -dy / l, ty = dx / l;               // 切向
          const radial = 6 - l;                           // 维持 ~6 格盘旋半径
          e.vx = e.vx * 0.7 + tx * e._orbitDir * 0.09 + (dx / l) * radial * 0.012;
          e.vy = e.vy * 0.7 + ty * e._orbitDir * 0.09 + (dy / l) * radial * 0.012;
        } else if (rng() < 0.3) {
          e.vx += (rng() - 0.5) * 0.1; e.vy += (rng() - 0.5) * 0.1;
        }
        break;
      }
      case 'wander':
      default: {
        // 流萤等：单纯随机漂浮，无视玩家。
        if (rng() < 0.25) { e.vx += (rng() - 0.5) * 0.08; e.vy += (rng() - 0.5) * 0.08; }
        e.vx *= 0.92; e.vy *= 0.92;
        break;
      }
    }
    integrate(e);
  }
  if (born.length) world.entities.push(...born);
  // 清理死亡
  world.entities = world.entities.filter(e => e.hp > 0);
  // 互不重合：漂移/吸引之后统一推开（放在清理之后，减少对已死实体的无效计算）
  // 2 pass：单位会朝同一玩家聚拢，1 pass 解不开"链式堆叠"，会留下肉眼可见的重叠。
  separateEntities(world, 2);
}

/**
 * 实体互不重合（分离力）——修复"几个单位叠在一起"。
 * · 任意两实体若 dist < r1+r2，按**质量反比**沿连线推开（重的少动、轻的多动）；
 * · speed===0 的静态单位不可推动（只推另一方）；两个都静态则都不推；
 * · 空间网格（格子边长 = 最大直径）把 O(n²) 降到 O(n·k)，512 实体下仍在 2ms 内；
 * · **确定性**：固定迭代顺序（按实体数组顺序、每对只结算 i<j 一次），
 *   重合时用索引派生的固定角度散开 —— 全程无 Math.random / Date.now；
 * · 推挤后统一 clamp 回世界范围（只处理实体，不会把玩家挤出边界）。
 * @param {object} world 世界（只读写 world.entities）
 * @param {number} passes 迭代次数。2 次即可把常见堆叠收敛到接近接触距离。
 */
export function separateEntities(world, passes = 1) {
  const list = world.entities;
  const n = list.length;
  if (n < 2) return;
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    const r = radiusOf(list[i]);
    list[i].r = r;
    if (r > maxR) maxR = r;
  }
  const cell = Math.max(1, maxR * 2);
  const cols = Math.max(1, Math.ceil(WORLD_W / cell));
  const rows = Math.max(1, Math.ceil(WORLD_H / cell));
  const total = Math.max(1, passes | 0);
  for (let pass = 0; pass < total; pass++) {
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const e = list[i];
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(e.x / cell)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(e.y / cell)));
      const k = cy * cols + cx;
      const bucket = grid.get(k);
      if (bucket) bucket.push(i); else grid.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      const a = list[i], ra = a.r;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(a.x / cell)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(a.y / cell)));
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const bucket = grid.get(ny * cols + nx);
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const j = bucket[bi];
            if (j <= i) continue;
            const b = list[j], rb = b.r;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy);
            const minD = ra + rb;
            if (d >= minD) continue;
            let ux, uy;
            if (d > 1e-6) { ux = dx / d; uy = dy / d; }
            else {
              const ang = (((i * 31 + j * 17) % 360) * Math.PI) / 180;
              ux = Math.cos(ang); uy = Math.sin(ang);
            }
            const overlap = minD - d;
            const ma = (a.mass > 0) ? a.mass : 1;
            const mb = (b.mass > 0) ? b.mass : 1;
            let wa = mb / (ma + mb), wb = ma / (ma + mb);
            const sa = isStaticEntity(a), sb = isStaticEntity(b);
            if (sa && sb) continue;
            if (sa) { wa = 0; wb = 1; }
            else if (sb) { wa = 1; wb = 0; }
            a.x -= ux * overlap * wa;
            a.y -= uy * overlap * wa;
            b.x += ux * overlap * wb;
            b.y += uy * overlap * wb;
          }
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const e = list[i];
    e.x = clamp(e.x, 0, WORLD_W - 1);
    e.y = clamp(e.y, 0, WORLD_H - 1);
  }
}

export function totalEmergentCount(world) {
  return world.entities.length;
}
