// server/ai.js — 电脑玩家（"对手棋子"）
// 每个电脑玩家有跟真人一样的数据结构（players[id]），由 AI 每 tick 决策 intent。
// v7"4 方抢地"契约：
//   1) 出生后先落一块 2x2 强细胞当"首都"（康威稳定形， unflagged 自己家）。
//   2) 然后持续殖民：选"与我方势力相邻的最近无主大区"，走到其中心，快照落 2x2。
//      —— 大区 4x4 生命格，中心 2x2 在其 INFLUENCE_R(3) 覆盖内 → 直接翻转归属。
//   3) 翻牌后换下一个大区（向四方扩张成"势力"）。
//   4) 附近有人类/领先的对手 → 交战（守土/抢地）；敌对单位只在贴脸时才打（不被拖走）。
// 确定性：不引入 Math.random，只在真引擎的 world._rng 序列上做整数运算。
import { WORLD_W, WORLD_H, pickSpawn } from './util.js';

const AI_NAMES = ['BoidsAI', 'VoronoiAI', 'L_SystemAI', 'Rule30AI', 'ReactionDiffAI', 'AntColonyAI', 'MSTPrimAI', 'DelaunayAI'];
let aiCounter = 0;

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
  const [px, py] = pickSpawn(rng, Object.values(world.players));   // 四角散布
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
  // "AI 驱动"包含两类：原生 AI，以及**掉线后由电脑接手**的人类角色（botControlled）。
  // 这样"中途离开由电脑接手"无需复制一份 AI 逻辑，玩家回来时清掉标记即接回原位。
  const isBot = (q) => q.isAI === true || q.botControlled === true;
  const humans = ps.filter(q => !isBot(q));
  const ais = ps.filter(q => isBot(q));
  const resList = flattenResources(world.resources);
  for (const p of ps) {
    if (!isBot(p) || !p.alive) continue;
    p._aiThink = (p._aiThink || 0) + 1;
    if (p._aiThink < 2) continue;          // ~10 Hz（原 3 → 反应更快）
    p._aiThink = 0;
    if (p._plantCd > 0) p._plantCd--;

    const f = world._factionOf(p.id);

    // 0) 贴脸敌对（<4 格）→ 打/逃；远处敌对不理（潮汐不会把 AI 拖离领地）
    let threat = null, threatD = 4 * 4;
    for (const e of world.entities) {
      if (e.faction !== 'hostile' || e.hp <= 0) continue;
      const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
      if (d2 < threatD) { threatD = d2; threat = e; }
    }
    if (threat) {
      const dx = threat.x - p.x, dy = threat.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      if (p.hp < 22) { intents.push(p.id, { move: { dx: -dx / l, dy: -dy / l } }); continue; }
      if (threatD < 2 * 2) intents.push(p.id, { attack: { tx: threat.x, ty: threat.y } });
      else intents.push(p.id, { move: { dx: dx / l, dy: dy / l } });
      continue;
    }

    // 1) 站资源上 → 收集
    const hereRes = world.resources[Math.floor(p.x)] && world.resources[Math.floor(p.x)][Math.floor(p.y)];
    if (hereRes) { intents.push(p.id, { build: 'gather' }); continue; }

    // 2) 附近人类/对手 → 交战（提高难度：侦测半径 16→20，更主动来找你）
    let enemy = null, ed = 20 * 20;
    for (const h of humans) {
      if (!h.alive) continue;
      const d2 = (h.x - p.x) ** 2 + (h.y - p.y) ** 2;
      if (d2 < ed) { ed = d2; enemy = h; }
    }
    for (const o of ais) {
      if (o.id === p.id || !o.alive) continue;
      const d2 = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
      if (d2 < ed && o.score > p.score + 30) { ed = d2; enemy = o; }
    }
    if (enemy && ed < 20 * 20) {
      const dx = enemy.x - p.x, dy = enemy.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      moveToward(world, p, intents, enemy.x, enemy.y);
      if (ed < 4 * 4) intents.push(p.id, { attack: { tx: enemy.x, ty: enemy.y } });
      if (ed > 5 * 5 && ed < 14 * 14 && p.dashCharge >= 1 && p.dashCooldown === 0) {
        intents.push(p.id, { dash: { dx, dy } });
      }
      continue;
    }

    // 3) LAND DRIVE：殖民扩张（真正在抢地）
    const owned = ownedRegions(world, f);
    const my = myStrongCells(world, f);
    p._aiBadR = p._aiBadR || {};
    // 若上一目标已属于我 → 清掉换下一个；若**超时仍未占住** → 记黑名单（45s 内不再选它）。
    // （否则会永远卡在同一个区反复落子 —— 实测卡在 goal 62 刷了 2000+ tick 原地不动。）
    let goal = p._aiGoal;
    if (goal && (owned.has(goal.r) || (goal.planted && world.tick - goal.planted > 60))) {
      if (!owned.has(goal.r)) p._aiBadR[goal.r] = world.tick + 900;
      goal = null; p._aiGoal = null;
    }
    if (!goal) {
      const r = pickExpansionRegion(world, p, f, owned, p._aiBadR);
      if (r != null) {
        goal = { r, blockCells: regionBlockCells(r), planted: 0 };
        p._aiGoal = goal;
        p._aiGoalTick = world.tick;
      }
    }
    if (goal) {
      // 目标大区中心（区域中心 2x2 其一，落子即覆盖中心点 → 翻转归属）
      const [cx0, cy0] = lifeCellCenter(goal.blockCells[0][0], goal.blockCells[0][1]);
      const dCenter = Math.hypot(cx0 - p.x, cy0 - p.y);
      if (dCenter > 4) {
        // 还在路上：向中心行军（A* 绕墙）
        moveToward(world, p, intents, cx0, cy0);
        continue;
      }
      // 到点：一次落 2x2（种子引擎已改为 2x2，与玩家一致），覆盖区域中心。
      // 不再逐格走到 0.6 精度 —— 那样会因惯性原地绕圈、永不推进 → 卡死转圈。
      // 没种子就不死循环：原地等回种（不 moveToward，避免惯性打转），种子 ~2.25s 回一颗。
      if ((p.seeds || 0) > 0 && p._plantCd <= 0) {
        intents.push(p.id, { plant: true });
        p._plantCd = 1;                     // 扩张更快（原 5→3→2→1）→ AI 更硬
        goal.planted = world.tick;
      }
      // 等归属刷新：翻牌或落子超时都换下一个区（超时即记黑名单，防止原地死循环）
      if (owned.has(goal.r) || (goal.planted && world.tick - goal.planted > 60)) {
        if (!owned.has(goal.r)) p._aiBadR[goal.r] = world.tick + 900;
        p._aiGoal = null;
      }
      continue;
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
  const W = GO_LIFE_W;
  const L = goLife(world);
  // 本回合可落子数（房主可设，默认 3）；夹紧到 1..16，防越界或未初始化。
  const K = Math.max(1, Math.min(16, world.stonesPerTurn || 3));
  // 1) 候选点：邻接任意非空格（1~2 环）；空盘 → 天元附近
  const cand = new Set();
  let any = false;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
    if (!L[x][y]) continue;
    any = true;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      if (!L[nx][ny]) cand.add(nx * W + ny);
    }
  }
  if (!any) {
    // 空盘：在天元附近摆一个紧凑小群落（≤K 颗，优先 2×2，可自发演化成稳定形），
    // 避免"一次只落一颗在空盘上→立刻因孤立而死"的退化。
    const c = (W / 2) | 0;
    const OFFS = [
      [0, 0], [1, 0], [0, 1], [1, 1],
      [-1, 0], [2, 0], [0, -1], [0, 2],
      [-1, 1], [1, -1], [-1, -1], [2, 1],
      [1, 2], [2, 2], [-2, 0], [0, -2],
    ];
    const moves = [];
    for (const [dx, dy] of OFFS) {
      if (moves.length >= K) break;
      const nx = c + dx, ny = c + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      moves.push({ lx: nx, ly: ny });
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
    const noise = world._rng() * 0.5;
    const score =
      cap * 40 +
      ally * 6 +
      Math.min(libs, 4) * 5 +
      enemy * 3 +
      center * 0.15 +
      noise;
    scored.push({ lx: x, ly: y, s: score });
  }
  if (!scored.length) return { pass: true };
  // 取前 K 名（确定性平局打破：分数相同按 key 升序）
  scored.sort((a, b) => (b.s - a.s) || ((a.lx * W + a.ly) - (b.lx * W + b.ly)));
  const moves = [];
  for (const s of scored) {
    if (moves.length >= K) break;
    moves.push({ lx: s.lx, ly: s.ly });
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
