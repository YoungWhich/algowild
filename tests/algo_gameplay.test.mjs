// tests/algo_gameplay.test.mjs — 算法内核 → 真实玩法的集成测试
// 覆盖：#37 Voronoi 势力边界 + 中立缓冲、#38 MST 要塞网、#39 A* AI 绕墙包抄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/engine.js';
import { astar } from '../server/kernels/astar.js';
import { voronoi } from '../server/kernels/voronoi.js';
import { mst_prim } from '../server/kernels/mst_prim.js';
import { stepAI } from '../server/ai.js';
import { IntentQueue } from '../server/intents.js';
import { WORLD_W } from '../server/util.js';

// 给一个 World 注入所需内核（engine 异步 loadKernels 在纯单测里不触发）。
// 注意：_updateVoronoi / _updateNetwork 读的是静态 World.kernelRegistry，
// 而 ai.js 的 A* 读的是实例 world.kernelRegistry（二者在真实引擎里指向同一 Map）。
function withKernels(w) {
  const reg = new Map([
    ['astar', astar],
    ['voronoi', voronoi],
    ['mst_prim', mst_prim],
  ]);
  World.kernelRegistry = reg;     // 静态（voronoi / mst 用）
  w.kernelRegistry = reg;         // 实例（A* 用）
  return w;
}

test('#37 Voronoi 势力归属 + 中立缓冲', () => {
  const w = withKernels(new World('v', 'o', 1));
  w._lifeInit();
  const f = w._factionOf('p1');
  w._life[10][10] = f;                 // 一枚强细胞 = 势力种子
  w._updateVoronoi();
  assert.equal(w._lifeOwner[10][10], f, '种子格自身归属该势力');
  assert.equal(w._lifeOwner[10][13], f, 'INFLUENCE_R(6) 内归属该势力');
  // 远于 INFLUENCE_R 的格应为中立(0)，形成缓冲带
  assert.equal(w._lifeOwner[10][20], 0, '超出影响半径 → 中立缓冲');
  assert.equal(w._lifeOwner[25][25], 0, '无种子区域 → 中立');
});

test('#38 MST 要塞网：近距连成帝国网，远距断开', () => {
  const w = withKernels(new World('m', 'o', 2));
  // 构造一个玩家并取其势力号
  const p = { id: 'net_p', isAI: false, alive: true, score: 0, strongholds: 0 };
  w.players['net_p'] = p;
  const f = w._factionOf('net_p');
  // 两个紧邻的要塞代表点（跨度 1 < 2*BUDGET(12)）
  w._strongholdReps = { [f]: [{ x: 5, y: 5 }, { x: 6, y: 6 }] };
  w._updateNetwork();
  assert.equal(p.network, true, '紧邻要塞应连成帝国网');

  // 两个相距极远的要塞（跨度 41 > 2*12=24）
  w._strongholdReps = { [f]: [{ x: 1, y: 1 }, { x: 30, y: 30 }] };
  w._updateNetwork();
  assert.equal(p.network, false, '相距过远的要塞无法连成网');
});

test('#39 A* AI 绕过玩家城墙包抄（而非直冲墙）', () => {
  const C = World.LIFE_CELL;   // 世界格/生命格（随世界尺寸自适应）
  const w = withKernels(new World('a', 'o', 3));
  w.resources = Array.from({ length: WORLD_W }, () => new Array(WORLD_W).fill(0)); // 清场避免误拾取
  w._lifeInit();

  // 玩家（人类）在右、AI 在左，同一行 y=50，相距 10 格（<12 触发追击），墙挡在中间
  const LY = 50;
  const AX = 40, HX = 50;
  const human = { id: 'H', x: HX, y: LY, isAI: false, alive: true };
  w.players['H'] = human;
  const hf = w._factionOf('H');

  const ai = { id: 'A', x: AX, y: LY, isAI: true, alive: true, _aiThink: 2,
               dashCharge: 1, dashCooldown: 0 };
  w.players['A'] = ai;
  w._factionOf('A');

  // 在 AI 与人类正中间竖一道玩家的强细胞墙（生命格列 = 中间位置），阻断直线
  const wallCol = Math.floor((AX + HX) / 2 / C);
  const wallRow0 = Math.floor(LY / C) - 2, wallRow1 = Math.floor(LY / C) + 2;
  for (let ly = wallRow0; ly <= wallRow1; ly++) w._life[wallCol][ly] = hf;
  // 墙体占位的世界格范围（用于校验路径绕行）
  const inWall = (x, y) => x >= wallCol * C && x < (wallCol + 1) * C && y >= wallRow0 * C && y < (wallRow1 + 1) * C;

  const intents = new IntentQueue();
  stepAI(w, intents);
  const aiIntent = intents.drain('A');
  // IntentQueue 合并后移动以 {jx,jy} 冲量表达（非 {move}）
  assert.ok(aiIntent && (aiIntent.jx !== 0 || aiIntent.jy !== 0), 'AI 应发出移动意图');
  assert.ok(ai._aiPath, 'A* 应算出一条路径');
  // 路径终点应为目标格
  const end = ai._aiPath[ai._aiPath.length - 1];
  assert.deepEqual([end[0], end[1]], [HX, LY],
    '路径终点应抵达目标');
  // 路径不应穿过城墙（这是"绕行"而非"直冲"的核心证据）
  assert.ok(!ai._aiPath.some(([x, y]) => inWall(x, y)), '路径不应穿过城墙');
  // 绕行使路径长于直线
  const straight = Math.abs(HX - AX) + 1;
  assert.ok(ai._aiPath.length > straight,
    `绕墙路径应长于直线：len=${ai._aiPath.length} > ${straight}`);

  // 对照：无墙时应直冲（水平直线 straight 节点）
  const w2 = withKernels(new World('a2', 'o', 4));
  w2.resources = Array.from({ length: WORLD_W }, () => new Array(WORLD_W).fill(0));
  w2._lifeInit();
  const h2 = { id: 'H2', x: HX, y: LY, isAI: false, alive: true };
  w2.players['H2'] = h2; w2._factionOf('H2');
  const a2 = { id: 'A2', x: AX, y: LY, isAI: true, alive: true, _aiThink: 2,
               dashCharge: 1, dashCooldown: 0 };
  w2.players['A2'] = a2; w2._factionOf('A2');
  const intents2 = new IntentQueue();
  stepAI(w2, intents2);
  intents2.drain('A2');
  assert.ok(a2._aiPath && a2._aiPath.length === straight,
    `无墙应为直线 ${straight} 节点：len=${a2._aiPath && a2._aiPath.length}`);
});

test('#39 A* 内核缺失时 AI 优雅回退（直冲，不崩溃）', () => {
  const w = withKernels(new World('a3', 'o', 5));
  w.kernelRegistry = new Map();       // 故意不注入 astar
  w.resources = Array.from({ length: WORLD_W }, () => new Array(WORLD_W).fill(0));
  w._lifeInit();
  const h = { id: 'H3', x: 52, y: 50, isAI: false, alive: true };
  w.players['H3'] = h; w._factionOf('H3');
  const ai = { id: 'A3', x: 42, y: 50, isAI: true, alive: true, _aiThink: 2,
               dashCharge: 1, dashCooldown: 0 };
  w.players['A3'] = ai; w._factionOf('A3');
  for (let ly = 14; ly <= 18; ly++) w._life[15][ly] = w._factionOf('H3');
  const intents = new IntentQueue();
  assert.doesNotThrow(() => stepAI(w, intents), '无 A* 内核不应抛错');
  const mi = intents.drain('A3');
  assert.ok(mi && (mi.jx !== 0 || mi.jy !== 0), '回退路径下 AI 仍直冲目标');
  assert.ok(mi.jx > 0, '回退路径下 AI 朝目标(+x)直冲');
});
