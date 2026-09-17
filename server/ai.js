// server/ai.js — 电脑玩家（"对手棋子"）
// 每个电脑玩家有跟真人一样的数据结构（players[id]），由 AI 每 tick 决策 intent。
// v7"4 方抢地"契约：
//   1) 出生后先落一块 2x2 强细胞当"首都"（康威稳定形， unflagged 自己家）。
//   2) 然后持续殖民：选"与我方势力相邻的最近无主大区"，走到其中心，快照落 2x2。
//      —— 大区 4x4 生命格，中心 2x2 在其 INFLUENCE_R(3) 覆盖内 → 直接翻转归属。
//   3) 翻牌后换下一个大区（向四方扩张成"势力"）。
//   4) 附近有人类/领先的对手 → **有脑子地**交战：只在"进攻期望收益为正"（对方残血/贴脸/
//      可在合理时间内击杀）时才追猎，且追猎有 6s 时间上限；否则继续扩张（占地才是 AI 的胜利线）。
//      —— 不做数值外挂（不改 PVP_DMG 等全局常量），只让决策更聪明：不把时间浪费在打不死的追猎上。
// 确定性：不引入 Math.random，只在真引擎的 world._rng 序列上做整数运算。
import { WORLD_W, WORLD_H, pickSpawn } from './util.js';

const AI_NAMES = ['BoidsAI', 'VoronoiAI', 'L_SystemAI', 'Rule30AI', 'ReactionDiffAI', 'AntColonyAI', 'MSTPrimAI', 'DelaunayAI'];
let aiCounter = 0;

// ---- AI 强度（房主设置 world.aiDifficulty 1..5，默认 3）----
// diff=3 时各系数取原字面量（噪声 0.5 / 权重 40·5 / 每 tick 决策 / 交战半径 12 / 可冲刺），
// 行为与引入难度前逐位一致；diff<=2 更弱，diff>=4 更强。
export function aiDifficultyOf(world) {
  const v = world ? world.aiDifficulty : undefined;
  const n = (typeof v === 'number' && Number.isFinite(v)) ? Math.floor(v) : 3;
  return Math.max(1, Math.min(5, n));
}
/** 按难度取表值：table[0..4] 对应 diff 1..5；难度非法 → 取 diff=3 那一项。 */
export function aiTune(diff, table) {
  const i = (Number.isInteger(diff) && diff >= 1 && diff <= 5) ? diff - 1 : 2;
  return table[i];
}

// ---- 生命棋盘结构镜像（不 import engine，避免循环依赖）----
const _isStrong = (v) => v > 0 && v <= 8;
const _factionOfCell = (v) => (v > 10 ? v - 10 : v);
const LIFE_W = 32;         // mirror engine World.LIFE_W
const LIFE_CELL = 6;       // world cells per life cell (= WORLD_W/LIFE_W)
const REGIONS_PER_AXIS = 8; // 8x8 macro regions

function regionIndex(lx, ly) {
  return Math.floor(ly / 4) * REGIONS_PER_AXIS + Math.floor(lx / 4);
}
function regionOrigin(r) {
  return { rx: (r % REGIONS_PER_AXIS) * 4, ry: Math.floor(r / REGIONS_PER_AXIS) * 4 };
}
// 大区中心的 2x2 生命格（origin+1..+2）
function regionBlockCells(r) {
  const { rx, ry } = regionOrigin(r);
  return [
    [rx + 1, ry + 1], [rx + 2, ry + 1],
    [rx + 1, ry + 2], [rx + 2, ry + 2],
  ];
}
function lifeCellCenter(lx, ly) {
  return [lx * LIFE_CELL + LIFE_CELL / 2, ly * LIFE_CELL + LIFE_CELL / 2];
}
function myStrongCells(world, f) {
  const out = [];
  const L = world._life;
  if (!L) return out;
  for (let x = 0; x < L.length; x++) {
    for (let y = 0; y < L.length; y++) {
      if (_isStrong(L[x][y]) && _factionOfCell(L[x][y]) === f) out.push([x, y]);
    }
  }
  return out;
}

// 我方已拥有的大区集合
function ownedRegions(world, f) {
  const rf = world._regionFaction;
  const set = new Set();
  if (rf) for (let r = 0; r < 64; r++) if (rf[r] === f) set.add(r);
  return set;
}

// 目标选择：与我方领地相邻的最近无主区；无领地时 → 出生地所在区（若中立）或最近中立区。
function pickExpansionRegion(world, p, f, owned, bad) {
  const rf = world._regionFaction;
  if (!rf) return null;
  // bad[r] = 该区在 world.tick 之前不要再选（占不住就换目标，避免原地死循环反复落子）
  const skip = (r) => !!(bad && bad[r] && bad[r] > world.tick);
  const { lx, ly } = world._lifeXY(p.x, p.y);
  const homeR = regionIndex(lx, ly);
  if (owned.size === 0) {
    if (rf[homeR] === 0 && !skip(homeR)) return homeR;
    // 出生区已被占/在黑名单 → 找最近中立区
    let best = null, bd = Infinity;
    for (let r = 0; r < 64; r++) {
      if (rf[r] !== 0 || skip(r)) continue;
      const { rx, ry } = regionOrigin(r);
      const d = (rx + 2 - lx) ** 2 + (ry + 2 - ly) ** 2;
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }
  // 有领地：优先 8 邻域里的无主区；都没有 → 最近的敌方区（夺地）
  let frontierBest = null, frontierD = Infinity, frontierR = Infinity;
  for (let r = 0; r < 64; r++) {
    if (rf[r] !== 0 || skip(r)) continue;             // 只找无主（且不在黑名单）
    const { rx, ry } = regionOrigin(r);
    // 是否邻接我方任意领地
    let touches = false;
    for (const o of owned) {
      const a = regionOrigin(o);
      if (Math.abs(a.rx - rx) <= 4 && Math.abs(a.ry - ry) <= 4) { touches = true; break; }
    }
    if (!touches) continue;
    const my = myStrongCells(world, f);
    let cx = 0, cy = 0, n = 0;
    for (const [mx, myy] of my) { cx += mx * 3; cy += myy * 3; n++; }
    if (!n) { cx = p.x; cy = p.y; }
    const d = ((rx + 2) * 3 - cx) ** 2 + ((ry + 2) * 3 - cy) ** 2;
    if (d < frontierD || (d === frontierD && r < frontierR)) { frontierD = d; frontierR = r; frontierBest = r; }
  }
  if (frontierBest != null) return frontierBest;
  // 无相邻无主区 → 打最近敌方区
  let best = null, bd = Infinity;
  for (let r = 0; r < 64; r++) {
    if (rf[r] === f || rf[r] === 0 || skip(r)) continue;
    const { rx, ry } = regionOrigin(r);
    const d = ((rx + 2) * 3 - p.x) ** 2 + ((ry + 2) * 3 - p.y) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

function flattenResources(res2d) {
  const out = [];
  for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) if (res2d[x][y]) out.push({ x, y, type: res2d[x][y] });
  return out;
}

export function makeAIPlayer(world, rng) {
  aiCounter = (aiCounter + 1) % 1000;
  const id = 'ai_' + (aiCounter + (world.tick || 0)) + '_' + Math.floor(rng() * 1e6);
  const name = AI_NAMES[Math.floor(rng() * AI_NAMES.length)] + '_' + (aiCounter + 1);
  // 四角散布；形状感知：候选点须落在可落子世界格内（形状外/虚空剔除；board=null → 恒可落）。
  const isValid = (x, y) => (world._isPlayableWorld ? world._isPlayableWorld(x, y) : true);
  const sp = pickSpawn(rng, Object.values(world.players), 24, WORLD_W, WORLD_H, isValid);
  const px = sp ? sp[0] : Math.floor(WORLD_W / 2);
  const py = sp ? sp[1] : Math.floor(WORLD_H / 2);
  const p = {
    id, name, x: px, y: py, vx: 0, vy: 0, mass: 1,
    hp: 100, hpMax: 100,
    score: 0, kills: 0, deaths: 0, assists: 0,
    maxCombo: 0, combo: 0, comboDecay: 0,
    dashCharge: 1, dashCooldown: 0, hitFlash: 0,
    alive: true, respawnTicks: 0,
    regionsOwned: 0, scoreLeadTicks: 0,
    won: false, lost: false, winReason: null, lostReason: null,
    color: `hsl(${(rng()*360)|0},40%,75%)`,
    isAI: true,
    _stock: { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 },
    _aiThink: 0,
    _plantCd: 0,
    _aiGoal: null, _aiGoalTick: 0,   // { r, blockCells:[...], planted }
  };
  world.players[id] = p;
  return p;
}

// A* 寻路（绕敌方强细胞墙），无内核/无路时回退直冲
function aiPathTo(world, p, gx, gy) {
  const astarFn = world.kernelRegistry && world.kernelRegistry.get('astar');
  if (!astarFn) return null;
  const needRecompute =
    !p._aiPath || p._aiPathTick == null ||
    (world.tick - p._aiPathTick) >= 6 ||
    (p._aiPathGoal && (Math.abs(p._aiPathGoal[0] - gx) > 3 || Math.abs(p._aiPathGoal[1] - gy) > 3));
  if (!needRecompute) return p._aiPath;
  world._lifeInit && world._lifeInit();
  if (!world._life) return null;
  const sx = Math.floor(p.x), sy = Math.floor(p.y);
  const aiFaction = world._factionOf(p.id);
  const blocked = (wx, wy) => {
    if (wx === gx && wy === gy) return false;
    if (wx < 0 || wy < 0 || wx >= WORLD_W || wy >= WORLD_H) return true;
    const { lx, ly } = world._lifeXY(wx, wy);
    // 形状/虚空感知：墙格（形状外 / 虚空）不可通行（board=null → 恒 false，逐字节不变）。
    if (world._isWall && world._isWall(lx, ly)) return true;
    const v = world._life[lx][ly];
    if (!_isStrong(v)) return false;
    return _factionOfCell(v) !== aiFaction;
  };
  const res = astarFn(null, world._rng, { sx, sy, gx, gy, blocked });
  const path = res && res.path;
  p._aiPath = path && path.length > 1 ? path : null;
  p._aiPathTick = world.tick;
  p._aiPathGoal = [gx, gy];
  return p._aiPath;
}

function moveToward(world, p, intents, wx, wy) {
  const path = aiPathTo(world, p, Math.floor(wx), Math.floor(wy));
  let tx = wx, ty = wy;
  if (path && path.length > 1) {
    // ⚠ 关键修复：旧实现瞄准 `path[1]`（紧邻的下一格）。AI 一移动，floor(p.x/y) 就跨格，
    //   重算出的 path[1] 会翻到另一侧 → 推动方向 +x/-x 反复交替、dy 恒为 0 → **原地抖动、
    //   永远到不了目的地（既不移动也不落子）**。改为瞄准前方若干格的**格中心**，抖动即消失。
    const idx = Math.min(path.length - 1, 3);
    tx = path[idx][0] + 0.5;
    ty = path[idx][1] + 0.5;
  }
  const dx = tx - p.x, dy = ty - p.y;
  const l = Math.hypot(dx, dy) || 1;
  intents.push(p.id, { move: { dx: dx / l, dy: dy / l } });
}

export function stepAI(world, intents) {
  const ps = Object.values(world.players);
  // 强度：决策频率 / 交战半径 / 冲刺。diff=3 → 每 tick 决策、12 格、可冲刺（= 现状）。
  const diff = aiDifficultyOf(world);
  const thinkEvery = aiTune(diff, [3, 2, 1, 1, 1]);
  const engageR = aiTune(diff, [5, 8, 12, 13, 14]);
  const canDash = diff >= 3;
  // "AI 驱动"包含两类：原生 AI，以及**掉线后由电脑接手**的人类角色（botControlled）。
  // 这样"中途离开由电脑接手"无需复制一份 AI 逻辑，玩家回来时清掉标记即接回原位。
  const isBot = (q) => q.isAI === true || q.botControlled === true;
  const humans = ps.filter(q => !isBot(q));
  const ais = ps.filter(q => isBot(q));
  const resList = flattenResources(world.resources);
  for (const p of ps) {
    if (!isBot(p) || !p.alive) continue;
    p._aiThink = (p._aiThink || 0) + 1;
    // D) 决策频率：每 tick 都决策（原 `_aiThink < 2` → ~10Hz）。rts 实体数不多，20Hz 全量决策
    //    性能可接受；更跟手（修复"回种期冻结/迟钝"）。确定性不受影响（全程无 Math.random，
    //    模拟层只用 world._rng）。
    if (p._aiThink < thinkEvery) continue;
    p._aiThink = 0;
    if (p._plantCd > 0) p._plantCd--;

    const f = world._factionOf(p.id);

    // 0) 贴脸敌对实体（<4 格）→ 打/逃
    let threat = null, threatD = 4 * 4;
    for (const e of world.entities) {
      if (e.faction !== 'hostile' || e.hp <= 0) continue;
      const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
      if (d2 < threatD) { threatD = d2; threat = e; }
    }
    if (threat) {
      const dx = threat.x - p.x, dy = threat.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      // 极端逃跑阈值：濒死(hp<15)必跑，保留原行为。
      if (p.hp < 15) { intents.push(p.id, { move: { dx: -dx / l, dy: -dy / l } }); continue; }
      // A3) 理智撤退：hp 偏低(<35%)且面前有敌对涌现单位 → 拉开距离，别在原地硬刚送死。
      //     （涌现单位碰撞 18 伤害/次，低血贴脸极易被连击致死 → 累积 12 死出局。）
      if (p.hp < 35) { intents.push(p.id, { move: { dx: -dx / l, dy: -dy / l } }); continue; }
      if (threatD < 2 * 2) intents.push(p.id, { attack: { tx: threat.x, ty: threat.y } });
      else intents.push(p.id, { move: { dx: dx / l, dy: dy / l } });
      continue;
    }

    // 1) 站资源格上 → 收集（保留原 hereRes 分支，不与其他逻辑冲突）
    const hereRes = world.resources[Math.floor(p.x)] && world.resources[Math.floor(p.x)][Math.floor(p.y)];
    if (hereRes) { intents.push(p.id, { build: 'gather' }); continue; }

    // 2) 附近人类/领先对手 → **有脑子地**决定打还是继续发育
    //    ─────────────────────────────────────────────────────────────────────
    //    核心修复（对局公平 · 让 AI 决策更聪明，而非给它数值外挂）：
    //    旧实现：任意 20 格内出现真人 → 立刻放弃 land-drive/采集、全力追猎。
    //      但 AI 的 PvP 输出 ≈ PVP_DMG/ATK_COOLDOWN = 6/8 = 0.75 每 tick，
    //      而玩家被动回血 = HP_REGEN_PER_TICK = 0.5 每 tick → **净伤害仅 0.25/tick**，
    //      打死满血 100HP 要 ~400 tick(20s)，且这 20s AI 完全放弃占区发育 →
    //      "追一场空、地也丢了"。AI 不是弱，是**决策错误**：把时间浪费在打不死的追猎上。
    //    新逻辑：只有"进攻期望收益为正"才追猎，否则继续 land-drive（AI 的主胜利线=占地）。
    //    ─────────────────────────────────────────────────────────────────────
    const ENGAGE_R2 = engageR * engageR;       // A1) 交战半径（diff=3 → 12*12，与现状一致）
    let enemy = null, ed = ENGAGE_R2;
    for (const h of humans) {
      if (!h.alive) continue;
      const d2 = (h.x - p.x) ** 2 + (h.y - p.y) ** 2;
      if (d2 < ed) { ed = d2; enemy = h; }
    }
    for (const o of ais) {
      if (o.id === p.id || !o.alive) continue;
      const d2 = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
      // B) AI 互斗领先阈值 +30 → +15（更会互相争夺地盘）
      if (d2 < ed && o.score > p.score + 15) { ed = d2; enemy = o; }
    }
    // A2) "打不动就别追"判断：估算这条追猎线是否能在合理时间内杀死对方。
    //   myDps   = PVP_DMG / ATK_COOLDOWN（每 tick 期望净输出）
    //   enemyNet= myDps - world.HP_REGEN_PER_TICK（对方受伤后前 5s 不回血，但长期会回）
    //   if enemyNet <= 0 → 永远打不死 → 绝不追（继续发育）。
    //   即便净伤害为正，也要"已残血(<40%)"或"贴脸(<5格)"才追击；
    //   否则记为一次"路过的软目标"，继续 land-drive。
    if (enemy && ed < ENGAGE_R2) {
      const PVP_DMG = world.PVP_DMG != null ? world.PVP_DMG : 6;             // 常量只读，不改
      const ATK_CD = world.ATK_COOLDOWN != null ? world.ATK_COOLDOWN : 8;
      const REGEN = world.HP_REGEN_PER_TICK != null ? world.HP_REGEN_PER_TICK : 0.5;
      const myDps = PVP_DMG / Math.max(1, ATK_CD);            // 每 tick 期望伤害
      const enemyNet = myDps - REGEN;                          // 每 tick 期望**净**伤害
      const ehp = enemy.hpMax || 100;
      const ehpFrac = (enemy.hp || 0) / (ehp || 1);
      const canKill = enemyNet > 0 && (ehp / enemyNet) <= 240; // ≤12s 内可击杀（合理时间）
      const almostDead = ehpFrac < 0.4;                        // 敌人已残血(<40%)
      const inFace = ed < 5 * 5;                               // 贴脸(<5格)
      // A5) 追猎时间上限：即使决定追猎，也最多持续 CHASE_MAX_TICKS（6s @20TPS）。
      //     超时立即回去 land-drive —— 任何"打架"决策都不许让 AI 长期脱离扩张。
      const CHASE_MAX_TICKS = 120;
      const chasing = p._chaseUntil != null && world.tick < p._chaseUntil;
      if (chasing || (canKill && (almostDead || inFace))) {
        if (!chasing) p._chaseUntil = world.tick + CHASE_MAX_TICKS;   // 开启一段有限追猎
        const dx = enemy.x - p.x, dy = enemy.y - p.y;
        const l = Math.hypot(dx, dy) || 1;
        // 保持 moveToward 追击（A* 绕墙），近距 attack
        moveToward(world, p, intents, enemy.x, enemy.y);
        if (ed < 6 * 6) intents.push(p.id, { attack: { tx: enemy.x, ty: enemy.y } });
        // B) 冲刺窗口：ed>4*4 && ed<12*12 时冲刺贴身（原 16*16 收窄到交战半径内）
        if (canDash && ed > 4 * 4 && ed < 12 * 12 && p.dashCharge >= 1 && p.dashCooldown === 0) {
          intents.push(p.id, { dash: { dx, dy } });
        }
        continue;
      }
      // 否则：目标"打不动/太远/我还想发育" → 清掉追猎窗口，**不追**，
      // 直接落到下方 land-drive（A4：扩张永远是 AI 的第一优先级）。
      p._chaseUntil = null;
    } else {
      p._chaseUntil = null;   // 附近无软目标 → 结束追猎窗口
    }

    // C) 主动发育分支已下移到「步骤3 land-drive 之后」作为 fall-back（见下方），
    //    以避免抢占 land-drive —— 真实地图资源极密时原实现每 tick 都 continue、
    //    永远到不了 2x2 落子逻辑，导致 AI 全程 regionsOwned=0（QA 验收穿透性 bug）。

    // 3) LAND DRIVE：殖民扩张（核心修复 A —— 种 2x2 可存活团）
    //    单颗强细胞康威必死（0 邻），永远占不下区；改为在目标大区中心 2x2 生命格逐颗落子，
    //    4 颗正交相邻（每颗 2 邻）→ 康威静止形存活 → Voronoi 多数占区。
    const owned = ownedRegions(world, f);
    p._aiBadR = p._aiBadR || {};
    let goal = p._aiGoal;
    // 清理：全 4 格已落 或 已占区 → 清 goal 换下一个；超时(>120 tick)仍未占区 → 记黑名单防死循环。
    if (goal) {
      if (goal.placed.size >= 4 || owned.has(goal.r)) {
        p._aiGoal = null; goal = null;
      } else if (world.tick - (goal.startTick != null ? goal.startTick : (p._aiGoalTick || 0)) > 120) {
        p._aiBadR[goal.r] = world.tick + 900;   // 15s 内不再选它，防原地死循环
        p._aiGoal = null; goal = null;
      }
    }
    if (!goal) {
      const r = pickExpansionRegion(world, p, f, owned, p._aiBadR);
      if (r != null) {
        const blockCells = regionBlockCells(r);   // 目标区中心 2x2 的 4 个生命格
        goal = {
          r,
          blockCells,
          order: blockCells,                        // 逐格落子顺序：[rx+1,ry+1]..[rx+2,ry+2]
          placed: new Set(),                        // 已落子的格："lx,ly"
          startTick: world.tick,
        };
        p._aiGoal = goal;
        p._aiGoalTick = world.tick;
      }
    }
    if (goal) {
      // 取 order 中尚未 placed 的下一个目标格
      let idx = -1;
      for (let i = 0; i < goal.order.length; i++) {
        const c = goal.order[i];
        if (!goal.placed.has(c[0] + ',' + c[1])) { idx = i; break; }
      }
      if (idx === -1) {
        // 兜底：理论上上面已清 goal；这里再保险一次
        p._aiGoal = null;
      } else {
        const cell = goal.order[idx];
        const [cx, cy] = lifeCellCenter(cell[0], cell[1]);   // 该格世界中心 [lx*6+3, ly*6+3]
        const d = Math.hypot(cx - p.x, cy - p.y);
        if (d > 3) {
          // 还在路上：向该格中心行军（A* 绕墙）。在 4 格间来回走动 → 自然消除"发呆"，且逐格落子确保 2x2 成团
          moveToward(world, p, intents, cx, cy);
          continue;
        }
        // 已贴近该格中心（<=3 世界单位）：尝试落子
        const canPlant = (p.seeds || 0) > 0 && p._plantCd <= 0;
        if (canPlant) {
          // 落子必须落在实际脚下的目标格，确保"落子格 == 记录格"一致——
          // 边界处 AI 可能距 A 中心 <=3 却站在 B 上，若直接按 idx 记录会致 2x2 缺角→康威灭绝→占不下区。
          const foot = world._lifeXY(p.x, p.y);
          const footKey = foot.lx + ',' + foot.ly;
          const fv = world._life ? world._life[foot.lx][foot.ly] : 0;
          const footIsTarget = goal.order.some((c) => c[0] === foot.lx && c[1] === foot.ly);
          const footOwn = _isStrong(fv) && _factionOfCell(fv) === f;
          const footEnemy = _isStrong(fv) && _factionOfCell(fv) !== f;
          if (footOwn) {
            // 脚下己方强细胞（含目标格/已落格）→ 直接 mark placed，不 push plant、不扣种子（避免空喷）
            goal.placed.add(footKey);
          } else if (footIsTarget && !goal.placed.has(footKey) && !footEnemy) {
            // 正站在某个未落的己方目标格内 → 落子（plant 落于脚下该格，与记录一致）
            intents.push(p.id, { plant: true });   // engine _lifePlant 落 1 格强细胞（已确认）
            p._plantCd = 1;                          // 扩张更快 → AI 更硬
            goal.placed.add(footKey);
          } else {
            // 边界/敌方已占目标格/非目标格 → 对齐到当前目标格中心，不落子（下一 tick 再判，避免浪费种子）
            moveToward(world, p, intents, cx, cy);
          }
          continue;
        }
        // 够近但此刻不能落（无种子/冷却中）→ 不冻结，朝"下一个未 placed 格"移动，等回种后再落
        let moveCell = cell;
        for (let i = idx + 1; i < goal.order.length; i++) {
          const c = goal.order[i];
          if (!goal.placed.has(c[0] + ',' + c[1])) { moveCell = c; break; }
        }
        const [mx, my] = lifeCellCenter(moveCell[0], moveCell[1]);
        moveToward(world, p, intents, mx, my);
        continue;
      }
    }

    // C) 主动发育（fallback，绝不抢占 land-drive）：仅当没有可扩张区
    //    （p._aiGoal 仍为空 → pickExpansionRegion 返回 null）时才去附近(<25 世界格)资源采集。
    //    走到资源上后由步骤1「hereRes」分支采集；资源采完 resList 不再含它 → 下一 tick 回到 land-drive。
    //    这样扩张每 tick 都推进（修复：真实地图资源极密时原实现每 tick continue、永不 plant/占区）。
    if (!p._aiGoal) {
      let nearRes = null, nd = 25 * 25;
      for (const r of resList) {
        const d2 = (r.x - p.x) ** 2 + (r.y - p.y) ** 2;
        if (d2 < nd) { nd = d2; nearRes = r; }
      }
      if (nearRes) {
        moveToward(world, p, intents, nearRes.x, nearRes.y);
        continue;
      }
    }

    // 4) 全图都被占了（理论不会）→ 就近资源 / 漂移
    if (resList.length > 0) {
      const r = nearestOf(p.x, p.y, resList);
      if (r.it && r.d < 30 * 30) {
        const dx = r.it.x - p.x, dy = r.it.y - p.y;
        const l = Math.hypot(dx, dy) || 1;
        intents.push(p.id, { move: { dx: dx / l, dy: dy / l } });
        continue;
      }
    }
    intents.push(p.id, { move: { dx: (WORLD_W / 2 - p.x) * 0.1, dy: (WORLD_H / 2 - p.y) * 0.1 } });
  }
}

function nearestOf(px, py, list) {
  let best = null, bd = Infinity;
  for (const it of list) {
    const d = (it.x - px) ** 2 + (it.y - py) ** 2;
    if (d < bd) { bd = d; best = it; }
  }
  return { it: best, d: Math.sqrt(bd) };
}

// ============== go（回合制 · 演化棋）AI ==============
// 启发式打分，只评估**候选点集合**（邻接已有棋子的空点；空盘则天元）。≤0.8s。
// 与 rts 的 stepAI 完全独立，不动 rts 行为；共用 world._rng（种子化，无 Math.random）。
// 打分优先级：提子 > 连接（贴己方） > 气数 > 靠近敌子 > 占中心。
const GO_LIFE_W = 32;
function goLife(world) {
  if (!world._life) world._lifeInit();
  return world._life;
}
// 该点落子后所在团的 4-邻空点数（气）
function goLibsAfter(L, f, x, y, W) {
  const dir4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const saved = L[x][y];
  L[x][y] = f;
  const seen = new Set([x * W + y]);
  const stack = [[x, y]];
  let libs = 0;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    for (const [dx, dy] of dir4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const key = nx * W + ny;
      if (seen.has(key)) continue;
      const v = L[nx][ny];
      if (v === 0) { seen.add(key); libs++; }
      else if (v === f) { seen.add(key); stack.push([nx, ny]); }
    }
  }
  L[x][y] = saved;
  return libs;
}
// 若在此点落子，4 邻敌方团中会被提掉的子数
function goCaptureAt(L, f, x, y, W) {
  const dir4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const saved = L[x][y];
  L[x][y] = f;
  let captured = 0;
  const touched = new Set();
  for (const [dx, dy] of dir4) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
    const v = L[nx][ny];
    if (!v || v === f || touched.has(nx * W + ny)) continue;
    // 该团气数（仅空点数）
    const seen = new Set([nx * W + ny]);
    const stack = [[nx, ny]];
    let libs = 0;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      touched.add(cx * W + cy);
      for (const [ax, ay] of dir4) {
        const px = cx + ax, py = cy + ay;
        if (px < 0 || py < 0 || px >= W || py >= W) continue;
        const key = px * W + py;
        if (seen.has(key)) continue;
        const wv = L[px][py];
        if (wv === 0) { seen.add(key); libs++; }
        else if (wv === v) { seen.add(key); stack.push([px, py]); }
      }
    }
    if (libs === 0) {
      // 统计被提子数（同团）
      const cntSeen = new Set([nx * W + ny]);
      const st2 = [[nx, ny]];
      let n = 0;
      while (st2.length) {
        const [cx, cy] = st2.pop(); n++;
        for (const [ax, ay] of dir4) {
          const px = cx + ax, py = cy + ay;
          if (px < 0 || py < 0 || px >= W || py >= W) continue;
          const key = px * W + py;
          if (!cntSeen.has(key) && L[px][py] === v) { cntSeen.add(key); st2.push([px, py]); }
        }
      }
      captured += n;
    }
  }
  L[x][y] = saved;
  return captured;
}

/**
 * go 模式 AI 决策（启发式）。**一回合可落多颗**（需求返工 2026-09-10）：
 * 返回 { moves: [{lx,ly},...] }（1..world.stonesPerTurn 颗，互不重复）或 { pass:true }。
 * 策略：对所有合法候选点按既有启发式打分，取分数最高的前 K 颗（K = stonesPerTurn），
 *       作为"一批"交由 applyGoIntent 原子结算（非法/自杀整批回滚 → 上层视作 pass，不阻塞）。
 * @param {object} world
 * @param {number} f 行动方 faction
 * @returns {{moves:Array<{lx:number, ly:number}>}|{pass:boolean}|null}
 */
export function goAIMove(world, f) {
  const W = world.lifeW || GO_LIFE_W;   // go 生命层随棋盘尺寸（rts 恒 32；自定义棋盘 1..100）
  const L = goLife(world);
  // 形状/虚空感知：非矩形棋盘上，AI 只在「可落子」格选点（否则整批非法 → 被判 pass）。
  const playable = (x, y) => !(world._isWall && world._isWall(x, y));
  // 本回合可落子数（房主可设，默认 3）；夹紧到 1..16，防越界或未初始化。
  const K = Math.max(1, Math.min(16, world.stonesPerTurn || 3));
  // 强度：噪声幅度 / 提子权重 / 气权重 / 失误概率（diff=3 → 0.5 / 40 / 5 / 0，与现状一致）。
  const diff = aiDifficultyOf(world);
  const noiseAmp = aiTune(diff, [2.5, 1.5, 0.5, 0.25, 0.1]);
  const capW = aiTune(diff, [24, 32, 40, 48, 56]);
  const libW = aiTune(diff, [3, 4, 5, 6, 7]);
  const blunderRate = aiTune(diff, [0.5, 0.25, 0, 0, 0]);
  // 1) 候选点：邻接任意非空格（1~2 环）；空盘 → 天元附近
  const cand = new Set();
  let any = false;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
    if (!L[x][y]) continue;
    any = true;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      if (!L[nx][ny] && playable(nx, ny)) cand.add(nx * W + ny);
    }
  }
  if (!any) {
    // 空盘：在天元附近摆一个紧凑小群落（≤K 颗，优先 2×2，可自发演化成稳定形），
    // 避免"一次只落一颗在空盘上→立刻因孤立而死"的退化。
    // ★Q6=a 强制项：每个候选点都必须过 playable 过滤（空盘天元开局原 3 手里有 2 手会落在虚空/形状外）。
    const c = (W / 2) | 0;
    const OFFS = [
      [0, 0], [1, 0], [0, 1], [1, 1],
      [-1, 0], [2, 0], [0, -1], [0, 2],
      [-1, 1], [1, -1], [-1, -1], [2, 1],
      [1, 2], [2, 2], [-2, 0], [0, -2],
    ];
    const moves = [];
    // 首选偏移（尽可能摆成紧凑形）；若被形状挡住，则退化为"扫描全盘找可落子格"。
    for (const [dx, dy] of OFFS) {
      if (moves.length >= K) break;
      const nx = c + dx, ny = c + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      if (!playable(nx, ny)) continue;
      moves.push({ lx: nx, ly: ny });
    }
    if (moves.length < K) {
      // 兜底：全盘扫描补足到 K 颗（确定性：按 x*W+y 升序）。
      for (let x = 0; x < W && moves.length < K; x++) {
        for (let y = 0; y < W && moves.length < K; y++) {
          if (!playable(x, y)) continue;
          if (moves.some(m => m.lx === x && m.ly === y)) continue;
          moves.push({ lx: x, ly: y });
        }
      }
    }
    return { moves };
  }
  if (!cand.size) return { pass: true };
  // 多方局：除自己以外的任何阵营都算敌手（不再假设只有两个阵营）
  const cx0 = (W - 1) / 2, cy0 = (W - 1) / 2;
  const scored = [];
  for (const key of cand) {
    const x = (key / W) | 0, y = key % W;
    if (L[x][y]) continue;
    if (!playable(x, y)) continue;      // 形状/虚空感知：不进墙格
    // 提子数（含能否自救）
    const cap = goCaptureAt(L, f, x, y, W);
    // 落子后气数
    const libs = goLibsAfter(L, f, x, y, W);
    // 合法性：无气且未提子 → 自杀，跳过
    if (cap === 0 && libs === 0) continue;
    // 劫禁着
    const g = world.go;
    if (g && g.ko && g.ko.lx === x && g.ko.ly === y) continue;
    // 连接度：邻接己方数
    let ally = 0, enemy = 0;
    const dir8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (const [dx, dy] of dir8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const v = L[nx][ny];
      if (v === f) ally++;
      else if (v) enemy++;      // 多方局：任何非己方棋子都是对手
    }
    const center = -(Math.abs(x - cx0) + Math.abs(y - cy0));
    // 权重：提子 > 连接 > 气数 > 靠近敌子 > 占中心（+ 少量噪声走 _rng 打破平局）
    const noise = world._rng() * noiseAmp;
    const score =
      cap * capW +
      ally * 6 +
      Math.min(libs, 4) * libW +
      enemy * 3 +
      center * 0.15 +
      noise;
    scored.push({ lx: x, ly: y, s: score });
  }
  if (!scored.length) return { pass: true };
  // 取前 K 名（确定性平局打破：分数相同按 key 升序）
  scored.sort((a, b) => (b.s - a.s) || ((a.lx * W + a.ly) - (b.lx * W + b.ly)));
  // 失误（仅低难度）：用一次 _rng 判定，命中则改取排名靠后的次优手。
  // blunderRate>0 的短路保证 diff>=3 不多消耗 rng，序列与现状完全一致。
  let start = 0;
  if (blunderRate > 0 && world._rng() < blunderRate) {
    start = Math.min(Math.max(1, scored.length >> 1), Math.max(0, scored.length - 1));
  }
  const moves = [];
  for (let i = start; i < scored.length; i++) {
    if (moves.length >= K) break;
    moves.push({ lx: scored[i].lx, ly: scored[i].ly });
  }
  if (!moves.length) return { pass: true };
  return { moves };
}

// 把 goAIMove 挂到 World 静态属性上（go.js 的 _goMaybeAIMove 通过 World.goAIMove 调用，
// 避免 engine ↔ go 的循环依赖）。
export function registerGoAI(World) {
  World.goAIMove = goAIMove;
  return World;
}
