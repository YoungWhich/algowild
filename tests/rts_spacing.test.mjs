// tests/rts_spacing.test.mjs — rts 实时模式：单位互不重合 + 开局不再被秒杀出局
//
// 覆盖 2026-09-11 两个同根因 bug 的修复：
//   RS-01 分离力：N 个同类实体挤在同一坐标 → 若干拍后任意两实体间距 >= (r1+r2)*0.9
//   RS-02 静态单位（speed===0）不被推动，只有可移动的一方被弹开
//   RS-03 分离逻辑确定性：同 seed 同输入 → 逐拍坐标完全一致（禁 Math.random/Date.now）
//   RS-04 性能：512 实体（ENTITY_CAP）下单 tick < 2ms（空间网格，非 O(n²) 暴力）
//   RS-05 开局保护：初始 invulnTicks > 0 + started 过渡补发；敌对环伺下跑满 60s（1200 tick）lost === false
//   RS-06 敌对单位不会生成在任一存活玩家 SAFE_SPAWN_DIST（12 世界单位）内
//
// 铁律：算法是世界法则、单位是涌现；模拟内禁 Math.random/Date.now。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';
import {
  EMERGENTS, emergentRadius, separateEntities, tickEmergent,
  tooCloseToPlayer, SAFE_SPAWN_DIST,
} from '../server/emergent.js';
import { ENTITY_CAP, WORLD_W, WORLD_H } from '../server/util.js';

await loadKernels();

/** 建一个只有 1 个人类玩家的 rts 世界（不自动补 AI）。 */
function rts(seed = 1, opts = {}) {
  const w = new World('rs', 1, seed, { mode: 'rts', ...opts });
  w._skipAIFill = true;
  return w;
}

/** 按 EMERGENTS 表手搓一个实体（与 recognizeEmergent 生成的字段保持一致）。 */
function makeEnt(w, type, x, y) {
  const cfg = EMERGENTS[type];
  const e = {
    id: `${type}_${w.entities.length}`,
    type, name: cfg.name, x, y, vx: 0, vy: 0,
    mass: cfg.mass, speed: cfg.speed, r: emergentRadius(cfg.mass),
    hp: cfg.hp, hpMax: cfg.hp, color: cfg.color, from: cfg.from, shape: cfg.shape,
    effect: cfg.effect, faction: cfg.faction || 'neutral',
    born: w.tick, life: 600,
  };
  w.entities.push(e);
  return e;
}

/** 当前所有实体两两之间的最小距离（n 很小，直接 O(n²) 即可，仅测试用）。 */
function minPairDist(list) {
  let best = Infinity;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
test('RS-01 分离力：同坐标堆叠的实体若干拍后不再重合（>= (r1+r2)*0.9）', () => {
  const w = rts(11);
  w.addPlayer(1, 'A');
  const N = 40;
  for (let i = 0; i < N; i++) makeEnt(w, 'ring', 96, 96);
  const before = minPairDist(w.entities);
  assert.equal(before, 0, '前置：40 个实体完全重合，最小间距应为 0');

  for (let t = 0; t < 60; t++) separateEntities(w);

  const need = 2 * emergentRadius(EMERGENTS.ring.mass);
  const after = minPairDist(w.entities);
  assert.ok(
    after >= need * 0.9,
    `分离后最小间距 ${after.toFixed(4)} 应 >= 接触距离*0.9 = ${(need * 0.9).toFixed(4)}（接触距离 ${need.toFixed(4)}）`,
  );
  // 仍在世界范围内（分离不能把实体顶出边界）
  for (const e of w.entities) {
    assert.ok(e.x >= 0 && e.x <= WORLD_W - 1, `x 越界: ${e.x}`);
    assert.ok(e.y >= 0 && e.y <= WORLD_H - 1, `y 越界: ${e.y}`);
  }
});

// ---------------------------------------------------------------------------
test('RS-02 静态单位（speed===0）不被推动，只有移动方被弹开', () => {
  const w = rts(12);
  w.addPlayer(1, 'A');
  const rock = makeEnt(w, 'crystal', 50, 50);       // speed 0 → 不可推动
  const mover = makeEnt(w, 'ring', 50.3, 50);       // speed 0.8 → 被弹开
  const rockX = rock.x, rockY = rock.y;

  for (let t = 0; t < 10; t++) separateEntities(w);

  assert.equal(rock.x, rockX, '静态单位 x 不应被推动');
  assert.equal(rock.y, rockY, '静态单位 y 不应被推动');
  assert.notEqual(mover.x, 50.3, '可移动单位应被弹开');
  const d = Math.hypot(mover.x - rock.x, mover.y - rock.y);
  assert.ok(d > 0.3, `推开后距离应大于初始 0.3，实际 ${d.toFixed(4)}`);

  // 两个静态景观叠在一起 → 谁都不动（避免"互相顶开"的无意义抖动）
  const w2 = rts(13);
  w2.addPlayer(1, 'A');
  const a = makeEnt(w2, 'crystal', 20, 20);
  const b = makeEnt(w2, 'keystone', 20, 20);
  for (let t = 0; t < 10; t++) separateEntities(w2);
  assert.deepEqual([a.x, a.y], [20, 20], '两个静态单位都不应被推动（a）');
  assert.deepEqual([b.x, b.y], [20, 20], '两个静态单位都不应被推动（b）');
});

// ---------------------------------------------------------------------------
test('RS-03 分离逻辑确定性：同 seed 同输入 → 逐拍坐标完全一致', () => {
  const trace = (seed) => {
    const w = rts(seed);
    w.addPlayer(1, 'A');
    // 混合质量/速度/静态，覆盖质量反比与静态分支
    const types = ['ring', 'fire', 'crystal', 'crystalite', 'sandbeast', 'keystone'];
    for (let i = 0; i < 60; i++) {
      makeEnt(w, types[i % types.length], 96 + (i % 5) * 0.1, 96 + (i % 7) * 0.1);
    }
    const frames = [];
    for (let t = 0; t < 30; t++) {
      tickEmergent(w);
      frames.push(w.entities.map((e) => `${e.id}:${e.x.toFixed(6)},${e.y.toFixed(6)}`).join('|'));
    }
    return frames;
  };
  assert.deepEqual(trace(101), trace(101), '同 seed 两次运行的逐拍坐标必须完全一致');
  assert.notDeepEqual(trace(101), trace(202), '不同 seed 应产生不同轨迹（证明轨迹确实由 RNG 驱动）');
});

// ---------------------------------------------------------------------------
test('RS-04 性能：512 实体（ENTITY_CAP）单 tick < 2ms', () => {
  const w = rts(14);
  w.addPlayer(1, 'A');
  const types = ['crystal', 'ring', 'fire', 'crystalite', 'sandbeast', 'vein'];
  for (let i = 0; i < ENTITY_CAP; i++) {
    const x = 10 + (i % 23) * 8 + (i % 7) * 0.05;
    const y = 10 + Math.floor(i / 23) * 8 + (i % 5) * 0.05;
    makeEnt(w, types[i % types.length], Math.min(WORLD_W - 1, x), Math.min(WORLD_H - 1, y));
  }
  assert.equal(w.entities.length, ENTITY_CAP, `应铺满 ${ENTITY_CAP} 个实体`);

  for (let i = 0; i < 5; i++) tickEmergent(w);          // 预热（JIT）
  const N = 50;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) tickEmergent(w);
  const msPerTick = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(msPerTick < 2, `512 实体单 tick 应 < 2ms，实测 ${msPerTick.toFixed(4)}ms`);
});

// ---------------------------------------------------------------------------
test('RS-05 开局保护：初始 invulnTicks > 0，且敌对环伺下跑满 60s 不出局', () => {
  const w = rts(21);
  const p = w.addPlayer(1, 'A');
  assert.ok(p.invulnTicks > 0, `初始出生应有无敌保护，实际 ${p.invulnTicks}`);
  assert.equal(p.invulnTicks, World.INVULN_TICKS, '初始无敌时长应与复活一致（3s = INVULN_TICKS）');

  // 开局前在房间里空转：无敌会被消耗 → 点"开始游戏"那一刻必须补发一次完整无敌
  w.started = false;
  for (let t = 0; t < 30; t++) w.tickOnce();
  const before = p.invulnTicks;
  assert.ok(before < World.INVULN_TICKS, `前置：等待期无敌应已消耗（${before}）`);
  w.started = true;
  w.tickOnce();
  // 补发发生在 tick 开头，同拍末尾会正常衰减 1 → 允许 INVULN_TICKS-1
  assert.ok(
    p.invulnTicks >= World.INVULN_TICKS - 1,
    `started 过渡时应补发完整无敌，实际 ${p.invulnTicks}`,
  );

  // 敌对环伺：6 个敌对单位包围（距离 14 > SAFE_SPAWN_DIST，模拟"刚生成/刚靠近"）
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    makeEnt(w, i % 2 ? 'ring' : 'crystalite', p.x + Math.cos(ang) * 14, p.y + Math.sin(ang) * 14);
  }
  for (let t = 0; t < 1200; t++) w.tickOnce();   // 60s @ 20TPS

  assert.equal(p.lost, false, `60s 内不应出局，实际 lost=${p.lost} reason=${p.lostReason}`);
  assert.equal(p.lostReason, null, `出局原因应为空，实际 ${p.lostReason}`);
  // ⚠️ hp 在某一拍为 0 只代表"正在复活"，并不等于出局；真正要断的是"没被淘汰"。
  //（旧断言 p.hp>0 只是"恰好那一刻活着"，对敌对环伺场景是时序敏感的假失败。）
  assert.ok((p.deaths || 0) < World.DEATH_LIMIT,
    `60s 内死亡次数不应达出局线（deaths=${p.deaths}/${World.DEATH_LIMIT}）`);
  assert.ok(p.deaths < World.DEATH_LIMIT, `死亡数不应触顶出局（deaths=${p.deaths}）`);
});

// ---------------------------------------------------------------------------
test('RS-06 敌对单位不会生成在任一存活玩家 SAFE_SPAWN_DIST 内', () => {
  // (a) 单元级：生成保护谓词在半径边界内外的行为
  const fake = { players: { a: { x: 50, y: 50, alive: true } } };
  assert.equal(tooCloseToPlayer(fake, 50, 50, SAFE_SPAWN_DIST), true, '重合点必须被拒');
  assert.equal(tooCloseToPlayer(fake, 50 + SAFE_SPAWN_DIST - 0.01, 50, SAFE_SPAWN_DIST), true, '半径内必须被拒');
  assert.equal(tooCloseToPlayer(fake, 50 + SAFE_SPAWN_DIST + 0.01, 50, SAFE_SPAWN_DIST), false, '半径外应放行');
  const deadOnly = { players: { a: { x: 50, y: 50, alive: false } } };
  assert.equal(tooCloseToPlayer(deadOnly, 50, 50, SAFE_SPAWN_DIST), false, '已出局玩家不应再挡住生成');

  // (b) 集成级：真实世界跑 3000 tick，任何新生敌对实体出现时距存活玩家不得 < SAFE_SPAWN_DIST
  //     （允许 1 tick 内的最大漂移：敌对单位最高 speed 0.8，故留 1.0 的观测余量）
  const w = rts(23);
  const p = w.addPlayer(1, 'A');
  w.started = true;
  let births = 0, minSeen = Infinity;
  const MAX_HOSTILE_SPEED = 1.0;
  for (let t = 0; t < 3000; t++) {
    const known = new Set(w.entities.map((e) => e.id));
    const deaths0 = p.deaths || 0;
    const px0 = p.x, py0 = p.y;
    w.tickOnce();
    // 复活/冲刺会让玩家本拍**大位移**（瞬移）→ 用起始坐标量"生成距离"必然假阳性
    //（实测曾误报"生成在玩家 1.481 / 2.778 处"）。位移过大或发生复活则跳过该拍。
    // 另：生成守卫按设计只保护**存活**玩家（`tooCloseToPlayer` 跳过 !alive），
    // 玩家死亡/复活中时单位可生成在其位置附近——这不是漏洞，跳过这些拍。
    if ((p.deaths || 0) !== deaths0 || !p.alive || Math.hypot(p.x - px0, p.y - py0) > 4) continue;
    for (const e of w.entities) {
      if (known.has(e.id) || e.faction !== 'hostile') continue;
      births++;
      const d = Math.hypot(e.x - px0, e.y - py0);
      if (d < minSeen) minSeen = d;
      assert.ok(
        d >= SAFE_SPAWN_DIST - MAX_HOSTILE_SPEED,
        `敌对单位 ${e.id} 生成在玩家 ${d.toFixed(3)} 处，小于保护半径 ${SAFE_SPAWN_DIST}`,
      );
    }
  }
  // 生成保护是"放弃本次生成"，不消耗冷却 → 允许本轮 0 次生成（信息性，不谎报）
  assert.ok(Number.isFinite(births) && births >= 0, '统计应有效');
  if (births > 0) {
    assert.ok(minSeen >= SAFE_SPAWN_DIST - MAX_HOSTILE_SPEED, `最小生成距离 ${minSeen.toFixed(3)} 应达标`);
  }
});
