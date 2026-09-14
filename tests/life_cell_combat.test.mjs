// tests/life_cell_combat.test.mjs — 生命格"标准康威 + 死亡宽限 + 棋子近战吞噬"服务端模拟测试
//
// 覆盖 2026-09-10 玩法返工的服务端部分：
//   LC-01 rts 标准 B3/S23：孤子(0/1 邻)死、2×2 稳定块存活、3 邻诞生
//   LC-02 rts 死亡宽限 lonelyDeathDelay = 0/1/2 精确语义（撑 N 个回合才死）
//   LC-03 棋子近战吞噬：相邻敌强细胞 3 拍内被磨碎（_cellCombat 直测）
//   LC-04 堡垒 anchor / resist 减伤（有 1/拍 下限保底）
//   LC-05 相邻敌弱痕被立即吞噬（cell_eaten）
//   LC-06 集成（_lifeStep）：相邻敌强细胞在 3 步内被击碎
//   LC-07 确定性：同 seed 同序列 → _life 与 _lifeDmg 完全一致（禁 Math.random）
//   LC-08 快照：settings.stonesPerTurn/lonelyDeathDelay + lifeHits 稀疏结构
//   LC-09 go 模式死亡宽限：_goEvolveOnce 下孤子按 lonelyDeathDelay 延迟死亡
//
// 铁律：算法是世界法则、单位是涌现；模拟内禁 Math.random/Date.now（本测试亦只读不引入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';

await loadKernels();

// 建一个 rts 世界：2 个玩家（faction 1/2），并清空棋盘便于精确摆子。
function rts(seed = 1, opts = {}) {
  const w = new World('lc', 1, seed, { mode: 'rts', ...opts });
  w._skipAIFill = true;
  w.addPlayer(1, 'A');   // faction 1
  w.addPlayer(2, 'B');   // faction 2
  w._lifeInit();
  return w;
}
// 清空棋盘 + 复位死亡宽限/伤害网格（避免 _seedOnboarding 的残留干扰）。
function clearBoard(w) {
  for (let x = 0; x < World.LIFE_W; x++) {
    for (let y = 0; y < World.LIFE_W; y++) {
      w._life[x][y] = 0;
      w._lifeDoom[x][y] = -1;
      w._lifeDmg[x][y] = 0;
    }
  }
}

test('LC-01 rts 标准 B3/S23：孤子(0/1 邻)死、2×2 稳定块存活、3 邻诞生', () => {
  const w = rts(1);
  clearBoard(w);
  const F1 = 1;
  w._life[3][3] = F1;                                   // 孤子（0 邻）
  w._life[7][7] = F1; w._life[8][7] = F1;               // 双联（每格 1 邻）→ 双双死亡
  w._life[10][10] = F1; w._life[11][10] = F1; w._life[10][11] = F1; w._life[11][11] = F1; // 2×2 稳定块
  w._life[19][19] = F1; w._life[20][19] = F1; w._life[19][20] = F1; // L：3 邻 → (20,20) 诞生
  w._lifeStep([]);
  assert.equal(w._life[3][3], 0, '孤子（0 邻）应死亡');
  assert.equal(w._life[7][7], 0, '双联端点（1 邻）应死亡');
  assert.equal(w._life[8][7], 0, '双联端点（1 邻）应死亡');
  assert.equal(w._life[10][10], F1, '2×2 块每格 3 邻应存活');
  assert.equal(w._life[11][11], F1, '2×2 块每格 3 邻应存活');
  assert.equal(w._life[20][20], F1, '3 邻空格应诞生新细胞');
});

test('LC-02 rts 死亡宽限 lonelyDeathDelay=0/1/2 精确语义', () => {
  function lonerAlive(delay, steps) {
    const w = rts(5, { lonelyDeathDelay: delay });
    clearBoard(w);
    w._life[8][8] = 1;   // 孤子；对局无其它子
    for (let i = 0; i < steps; i++) w._lifeStep([]);
    return w._life[8][8] === 1;
  }
  assert.equal(lonerAlive(0, 1), false, 'delay=0：1 步后立即死（恢复标准康威）');
  assert.equal(lonerAlive(1, 1), true, 'delay=1：1 步后仍活（宽限 1）');
  assert.equal(lonerAlive(1, 2), false, 'delay=1：2 步后死');
  assert.equal(lonerAlive(2, 1), true, 'delay=2：1 步后活');
  assert.equal(lonerAlive(2, 2), true, 'delay=2：2 步后活');
  assert.equal(lonerAlive(2, 3), false, 'delay=2：3 步后死');
});

test('LC-03 棋子近战吞噬：相邻敌强细胞 3 拍内被磨碎（_cellCombat 直测）', () => {
  const w = rts(7);
  clearBoard(w);
  // 防守方（阵营 2）放在较小 x，先于攻击方被处理 → 伤害逐拍累积到 3 后击碎
  w._life[5][5] = 2;   // 防守：阵营 2
  w._life[6][5] = 1;   // 攻击：阵营 1（相邻）
  const resistOf = { 1: 1.0, 2: 1.0 };
  const ev = [];
  w._cellCombat(ev, resistOf, undefined);
  assert.equal(w._lifeDmg[5][5], 1, '第 1 拍后防守方 dmg=1');
  assert.equal(w._life[5][5], 2, '第 1 拍尚未击碎');
  w._cellCombat(ev, resistOf, undefined);
  assert.equal(w._lifeDmg[5][5], 2, '第 2 拍后 dmg=2');
  w._cellCombat(ev, resistOf, undefined);
  assert.equal(w._life[5][5], 0, '第 3 拍后防守方被击碎');
  assert.ok(ev.some(e => e.type === 'cell_hit' && e.killed && e.x === 5 && e.y === 5),
    '应产生 killed=true 的 cell_hit 事件');
  assert.ok(ev.some(e => e.type === 'cell_hit' && e.x === 5 && e.y === 5 && e.dmg === 1),
    '应记录逐拍 dmg');
});

test('LC-04 resist/anchor 阈值减伤：击碎步数随 resist 单调提高（无 floor 死区）', () => {
  // 阈值侧减伤：killAt = ceil(CELL_ATK_HP * resist * anchor)；每拍伤害 = max(1, atkIn)。
  // 用独立世界测量"防守方被击碎所需的 _cellCombat 次数"。攻击方给极高 resist，
  // 确保测量窗口内不被反杀（隔离防守方的阈值效应）。
  function stepsToKill(defResist, anchor, atkIn, maxSteps = 40) {
    const w = new World('killcalc', 1, 3, { mode: 'rts' });
    w._skipAIFill = true;
    w.addPlayer(1, 'A'); w.addPlayer(2, 'B'); w._lifeInit();
    clearBoard(w);
    const dx = 5, dy = 5;
    w._life[dx][dy] = 2;   // 防守方（阵营 2），放在较低 x → 先于攻击方被处理
    const atkCells = atkIn === 1
      ? [[dx + 1, dy]]
      : [[dx + 1, dy], [dx - 1, dy], [dx, dy + 1], [dx, dy - 1]];
    for (const [ax, ay] of atkCells) w._life[ax][ay] = 1;   // 攻击方（阵营 1）
    const sh = Array.from({ length: World.LIFE_W }, () => new Uint8Array(World.LIFE_W));
    if (anchor === 2) sh[dx][dy] = 1;
    const resistOf = { 1: 99.0, 2: defResist };   // 攻击方 resist 极高 → 不碎，隔离防守方
    for (let s = 1; s <= maxSteps; s++) {
      w._cellCombat([], resistOf, sh);
      if (w._life[dx][dy] === 0) return s;
    }
    return Infinity;
  }

  // —— 1 面围攻（atkIn=1，伤害 1/拍）：步数 === killAt，随 resist 单调、无死区 ——
  assert.equal(stepsToKill(1.0, 1, 1), 3, 'resist 1.0 → 3 拍');
  assert.equal(stepsToKill(1.15, 1, 1), 4, 'resist 1.15 → 4 拍（旧公式与 1.0 无差别，现已区分）');
  assert.equal(stepsToKill(1.5, 1, 1), 5, 'resist 1.5 → 5 拍（纪元/膜增厚升级现在生效）');
  assert.equal(stepsToKill(2.0, 1, 1), 6, 'resist 2.0 → 6 拍');
  assert.equal(stepsToKill(3.0, 1, 1), 9, 'resist 3.0 → 9 拍');

  // —— 4 面围攻（atkIn=4，伤害 4/拍）：步数 = ceil(killAt / 4) ——
  assert.equal(stepsToKill(1.0, 1, 4), 1, 'resist 1.0、4 面 → 1 拍');
  assert.equal(stepsToKill(1.15, 1, 4), 1, 'resist 1.15、4 面 → 1 拍');
  assert.equal(stepsToKill(1.5, 1, 4), 2, 'resist 1.5、4 面 → 2 拍');
  assert.equal(stepsToKill(2.0, 1, 4), 2, 'resist 2.0、4 面 → 2 拍');
  assert.equal(stepsToKill(3.0, 1, 4), 3, 'resist 3.0、4 面 → 3 拍');

  // —— 2×2 要塞（anchor=2）：阈值翻倍 ——
  assert.equal(stepsToKill(1.0, 2, 1), 6, 'anchor2、resist 1.0 → 6 拍');
  assert.equal(stepsToKill(1.5, 2, 1), 9, 'anchor2、resist 1.5 → 9 拍');
  assert.equal(stepsToKill(2.0, 2, 1), 12, 'anchor2、resist 2.0 → 12 拍');

  // 关键回归：1.15 与 1.5 现在都与 1.0 有区别（旧 floor 公式下三者相同 → 升级无感）
  assert.notEqual(stepsToKill(1.15, 1, 1), stepsToKill(1.0, 1, 1), '1.15 应区别于 1.0');
  assert.notEqual(stepsToKill(1.5, 1, 1), stepsToKill(1.0, 1, 1), '1.5 应区别于 1.0');
});

test('LC-04b 无攻击时自愈：dmg 逐步回 0（自愈行为不变）', () => {
  const w = rts(23);
  clearBoard(w);
  w._life[5][5] = 1;         // 己方强细胞（周围无敌人）
  w._lifeDmg[5][5] = 3;      // 预置一段伤疤
  const ev = [];
  w._cellCombat(ev, { 1: 1.0, 2: 1.0 }, undefined);
  assert.equal(w._lifeDmg[5][5], 2, '无攻击 → 自愈 1 → dmg=2');
  w._cellCombat(ev, { 1: 1.0, 2: 1.0 }, undefined);
  w._cellCombat(ev, { 1: 1.0, 2: 1.0 }, undefined);
  assert.equal(w._lifeDmg[5][5], 0, '继续自愈 → dmg 回 0');
  assert.equal(w._life[5][5], 1, '自愈过程中细胞不被误删');
});

test('LC-05 近战吞噬弱痕：相邻敌方弱痕立即被吃掉', () => {
  const w = rts(13);
  clearBoard(w);
  w._life[5][5] = 1;     // 己方（阵营 1）强细胞
  w._life[6][5] = 12;    // 阵营 2 的弱痕（2 + 10 编码）
  const ev = [];
  w._cellCombat(ev, { 1: 1.0, 2: 1.0 }, undefined);
  assert.equal(w._life[6][5], 0, '相邻敌弱痕应被立即吞噬');
  assert.ok(ev.some(e => e.type === 'cell_eaten' && e.x === 6 && e.y === 5 && e.f === 2 && e.by === 1),
    '应产生 cell_eaten 事件（记录被吃方/吃方阵营）');
});

test('LC-06 集成（_lifeStep）：相邻敌强细胞在 3 步内被击碎', () => {
  // 房主设置了死亡宽限（lonelyDeathDelay=6），令孤子不会因标准规则瞬死，
  // 从而能观测到"近战磨血至碎"这一层机制（演化 → 战斗 同拍结算）。
  const w = rts(17, { lonelyDeathDelay: 6 });
  clearBoard(w);
  w._life[10][10] = 2;                                   // 防守方（阵营 2）
  w._life[9][10] = 1; w._life[11][10] = 1; w._life[10][9] = 1; w._life[10][11] = 1; // 4 面围攻
  let destroyedAt = -1;
  for (let s = 1; s <= 3; s++) {
    w._lifeStep([]);
    if (w._life[10][10] === 0) { destroyedAt = s; break; }
  }
  assert.ok(destroyedAt >= 1 && destroyedAt <= 3,
    `防守方应在 3 步内被击碎（实际第 ${destroyedAt} 步）`);
});

test('LC-07 确定性：同 seed 同序列 → _life 与 _lifeDmg 完全一致', () => {
  function run() {
    const w = rts(999, { lonelyDeathDelay: 1 });
    clearBoard(w);
    // 混合盘面：稳定块 + L + 敌块 + 孤子 + 弱痕
    w._life[5][5] = 1; w._life[6][5] = 1; w._life[5][6] = 1; w._life[6][6] = 1;
    w._life[12][12] = 2; w._life[13][12] = 2; w._life[12][13] = 2;
    w._life[20][5] = 1; w._life[20][15] = 12;   // 强细胞 + 远端敌弱痕
    w._life[8][8] = 1;
    for (let i = 0; i < 6; i++) w._lifeStep([]);
    return {
      life: w._life.map(c => Array.from(c).join(',')),
      dmg: w._lifeDmg.map(c => Array.from(c).join(',')),
    };
  }
  const a = run(), b = run();
  assert.deepEqual(a.life, b.life, '_life 应逐格一致（确定性）');
  assert.deepEqual(a.dmg, b.dmg, '_lifeDmg 应逐格一致（确定性）');
});

test('LC-08 快照：settings.stonesPerTurn/lonelyDeathDelay + lifeHits 稀疏结构', () => {
  const w = rts(3, { stonesPerTurn: 5, lonelyDeathDelay: 2 });
  clearBoard(w);
  const snap = w.snapshot();
  assert.equal(snap.settings.stonesPerTurn, 5, 'settings.stonesPerTurn 应透传（顶层，两种模式都有）');
  assert.equal(snap.settings.lonelyDeathDelay, 2, 'settings.lonelyDeathDelay 应透传');
  assert.ok(Array.isArray(snap.lifeHits), 'lifeHits 应为数组');
  assert.equal(snap.lifeHits.length, 0, '无伤害时 lifeHits 为空数组');
  assert.equal(snap.go, null, 'rts 快照的 go 字段应为 null');
  // 制造伤害 → lifeHits 稀疏出现 [x,y,dmg]
  w._life[5][5] = 2; w._life[6][5] = 1;
  w._cellCombat([], { 1: 1.0, 2: 1.0 }, undefined);
  const snap2 = w.snapshot();
  const hit = snap2.lifeHits.find(h => h[0] === 5 && h[1] === 5);
  assert.ok(hit && hit[2] === 1, 'lifeHits 应含 [5,5,1]');
  assert.ok(snap2.lifeHits.every(h => Array.isArray(h) && h.length === 3 && h[2] > 0),
    'lifeHits 应为稀疏结构（仅 dmg>0 的格子）');
  // 参数越界应被夹紧到合法区间
  const w2 = rts(4, { stonesPerTurn: 999, lonelyDeathDelay: 999 });
  assert.equal(w2.snapshot().settings.stonesPerTurn, World.STONES_PER_TURN_MAX, 'stonesPerTurn 应夹紧到上限');
  assert.equal(w2.snapshot().settings.lonelyDeathDelay, World.LONELY_DEATH_DELAY_MAX, 'lonelyDeathDelay 应夹紧到上限');
});

test('LC-09 go 模式死亡宽限：_goEvolveOnce 下孤子按 lonelyDeathDelay 延迟死亡', () => {
  function goLonerAlive(delay, steps) {
    const w = new World('golc', 1, 21, { mode: 'go', lonelyDeathDelay: delay });
    w._skipAIFill = true;
    w.addPlayer(1, 'A'); w.addPlayer(2, 'B');
    w._goInit();
    for (let x = 0; x < World.LIFE_W; x++) for (let y = 0; y < World.LIFE_W; y++) w._life[x][y] = 0;
    w.go.lastPlacedKeys = new Set();   // 清除"本回合豁免"，模拟遗留子
    const f = w.go.blackF;
    w._life[15][15] = f;
    for (let i = 0; i < steps; i++) w._goEvolveOnce(3);
    return w._life[15][15] === f;
  }
  assert.equal(goLonerAlive(0, 1), false, 'go：delay=0 孤子演化即死（取消孤子不死）');
  assert.equal(goLonerAlive(1, 1), true, 'go：delay=1 撑 1 回合');
  assert.equal(goLonerAlive(1, 2), false, 'go：delay=1 第 2 回合死');
  assert.equal(goLonerAlive(2, 2), true, 'go：delay=2 撑 2 回合');
  assert.equal(goLonerAlive(2, 3), false, 'go：delay=2 第 3 回合死');
});

// ==================== 去棋盘坐标偏序（2026-09-10 收尾）====================

// LC-10：1v1 贴脸 → **同拍互灭**（两阶段结算，任何清除都不影响本拍攻击计数）。
test('LC-10 1v1 贴脸：同拍互灭（不再有"下标小者先死"的幸存方）', () => {
  const w = rts(31);
  clearBoard(w);
  w._life[5][5] = 1;   // A（阵营 1）
  w._life[6][5] = 2;   // B（阵营 2，A 的右侧邻居）
  const ev = [];
  const rows = [];
  for (let s = 1; s <= 4; s++) {
    w._cellCombat(ev, { 1: 1.0, 2: 1.0 }, undefined);
    rows.push({ s, A: w._life[5][5], B: w._life[6][5], dmgA: w._lifeDmg[5][5], dmgB: w._lifeDmg[6][5] });
  }
  assert.equal(rows[0].A, 1, '第 1 拍 A 仍在');
  assert.equal(rows[0].B, 2, '第 1 拍 B 仍在');
  assert.equal(rows[0].dmgA, 1); assert.equal(rows[0].dmgB, 1, '第 1 拍双方各 dmg=1');
  assert.equal(rows[1].dmgA, 2); assert.equal(rows[1].dmgB, 2, '第 2 拍双方各 dmg=2');
  assert.equal(rows[2].A, 0, '第 3 拍 A（resist1.0 → killAt=3）被清');
  assert.equal(rows[2].B, 0, '第 3 拍 B **同拍**被清（互灭）——旧实现下 B 会因 A 先被清而自愈幸存');
  const killed = ev.filter(e => e.type === 'cell_hit' && e.killed);
  assert.equal(killed.length, 2, '第 3 拍应有恰好 2 个 killed 事件（同拍互灭）');
});

// LC-11：顺序无关性 —— 坐标互换 / 整体平移后结果必须完全一致（无"谁下标小谁死"）。
test('LC-11 顺序无关性：坐标互换/平移后结果完全一致', () => {
  // 跑一个"1v1 贴脸（各 1 面攻击、resist 1.0）"局面，返回击碎时点与双方存活情况。
  function duel(p1, p2) {
    const w = rts(37);
    clearBoard(w);
    w._life[p1[0]][p1[1]] = 1;   // 阵营 1
    w._life[p2[0]][p2[1]] = 2;   // 阵营 2
    const ev = [];
    let stepsToClear = -1;
    const trace = [];
    for (let s = 1; s <= 5; s++) {
      w._cellCombat(ev, { 1: 1.0, 2: 1.0 }, undefined);
      trace.push([w._life[p1[0]][p1[1]], w._life[p2[0]][p2[1]]]);
      if (w._life[p1[0]][p1[1]] === 0 && w._life[p2[0]][p2[1]] === 0) { stepsToClear = s; break; }
    }
    return {
      stepsToClear,
      bothDead: w._life[p1[0]][p1[1]] === 0 && w._life[p2[0]][p2[1]] === 0,
      killed: ev.filter(e => e.killed).length,
      trace,
    };
  }
  // 原序：阵营1 在左(x=5)、阵营2 在右(x=6)
  const base = duel([5, 5], [6, 5]);
  // 互换：阵营1 在右(x=6)、阵营2 在左(x=5) —— 排序恰好相反
  const swapped = duel([6, 5], [5, 5]);
  // 整体平移：整对挪到另一区域（去除任何定位/边界依赖）
  const shifted = duel([20, 20], [21, 20]);

  assert.equal(base.bothDead, true, '原序：双方皆灭');
  assert.equal(swapped.bothDead, true, '互换序：双方皆灭（结果一致，不再看谁下标小）');
  assert.equal(shifted.bothDead, true, '平移：双方皆灭（结果一致）');
  assert.equal(base.stepsToClear, 3, '原序：第 3 拍同拍互灭');
  assert.equal(swapped.stepsToClear, base.stepsToClear, '互换序：击碎时点一致');
  assert.equal(shifted.stepsToClear, base.stepsToClear, '平移：击碎时点一致');
  assert.equal(swapped.killed, base.killed, 'killed 事件数一致');
  assert.equal(shifted.killed, base.killed, 'killed 事件数一致');
  assert.deepEqual(swapped.trace, base.trace, '逐拍盘面（双方存活序列）完全一致');
  assert.deepEqual(shifted.trace, base.trace, '平移后逐拍盘面完全一致');
});
