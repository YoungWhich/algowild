// tests/engine.test.mjs — L3 世界引擎测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels, kernelRegistry } from '../server/engine.js';
import { IntentQueue, applyImpulse, elasticCollision } from '../server/intents.js';
import { EMERGENTS } from '../server/emergent.js';

test('L3 engine kernels 注册 46 个', async () => {
  await loadKernels();
  assert.equal(kernelRegistry.size, 46);
});

test('L3 World 创建大世界地形 + 资源', () => {
  const w = new World('w1', 1, 42);
  assert.ok(w.terrain.length === 192);
  assert.ok(w.terrain[0].length === 192);
  const flat = w.resourcesFlat();
  assert.ok(flat.length === 192 * 192);
});

test('L3 大氧化事件：无氧→有氧确定性跃迁，多细胞谱系获得代谢/速度加成', () => {
  const w = new World('w_ox', 1, 7);
  w._skipAIFill = true;
  const p = w.addPlayer(1, 'A');
  p.era = 1; // 多细胞：才有资格享受有氧代谢
  const beforeMul = p._speedMul || 1;
  for (let i = 0; i <= World.OXIC_TICK; i++) w.tickOnce();
  assert.equal(w.oxic, true, 'OXIC_TICK 后世界应转入有氧');
  assert.ok((p._speedMul || 1) > beforeMul, '有氧代谢应提升移动速度（+15%）');
  assert.ok((p._seedMul || 1) > 1, '有氧代谢应提升种子回速');
});

test('L3 addPlayer/removePlayer', () => {
  const w = new World('w1', 1, 42);
  const p = w.addPlayer(10, 'Alice');
  assert.equal(p.id, 10);
  assert.equal(p.name, 'Alice');
  assert.ok(w.players[10]);
  w.removePlayer(10);
  assert.ok(!w.players[10]);
});

test('L3 tickOnce 不崩溃 + 推进 tick', () => {
  const w = new World('w1', 1, 42);
  w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  const t0 = w.tick;
  w.tickOnce();
  assert.equal(w.tick, t0 + 1);
});

test('L3 1000 tick 不死循环 / 内存稳态', () => {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true; // suppress AI opponents for this deterministic test
  w.addPlayer(1, 'A');
  w.addPlayer(2, 'B');
  w.intentQueue.push(1, { move: { dx: 1, dy: 0 } });
  w.intentQueue.push(2, { move: { dx: -1, dy: 0 } });
  // Force GC so start heap is stable.
  if (global.gc) { for (let i = 0; i < 3; i++) global.gc(); }
  const startHeap = process.memoryUsage().heapUsed;
  let totalEvents = 0;
  for (let i = 0; i < 1000; i++) {
    w.intentQueue.push(1, { move: { dx: 1, dy: 0 } });
    w.intentQueue.push(2, { move: { dx: -1, dy: 0 } });
    const r = w.tickOnce();
    totalEvents += r.events.length;
  }
  if (global.gc) { for (let i = 0; i < 3; i++) global.gc(); }
  const endHeap = process.memoryUsage().heapUsed;
  const grow = (endHeap - startHeap) / Math.max(1, startHeap);
  assert.ok(grow < 0.3, `heap grew ${(grow * 100).toFixed(1)}% (>30%)`);
  assert.ok(totalEvents >= 0);
});

test('L3 涌现识别：1000 tick 至少产生 1 个涌现体', () => {
  const w = new World('w1', 1, 42);
  w.addPlayer(1, 'A');
  for (let i = 0; i < 1000; i++) w.tickOnce();
  assert.ok(w.entities.length >= 1, `expected ≥1 emergent, got ${w.entities.length}`);
});

test('L3 EMERGENTS 14 + 行为可观测', () => {
  const keys = Object.keys(EMERGENTS);
  assert.equal(keys.length, 14);
});

test('L3 IntentQueue FIFO + 冲量合并', () => {
  const q = new IntentQueue();
  // 同方向连续 5 次指令，合并上限 4
  q.push(1, { move: { dx: 1, dy: 0 } });
  q.push(1, { move: { dx: 1, dy: 0 } });
  q.push(1, { move: { dx: 1, dy: 0 } });
  q.push(1, { move: { dx: 1, dy: 0 } });
  q.push(1, { move: { dx: 1, dy: 0 } });
  const drained = q.drain(1);
  assert.equal(drained.moveCount, 5);
  // 冲量被合并为 4 倍
  assert.equal(Math.abs(drained.jx), 4, `expected |jx|=4, got ${drained.jx}`);
});

test('L3 applyImpulse 位置前进 + 阻尼', () => {
  const p = { x: 50, y: 50, vx: 0, vy: 0, mass: 1 };
  applyImpulse(p, { jx: 1, jy: 0 });
  assert.ok(p.x > 50);
  // 多次应用应衰减（阻尼 0.85）
  const before = p.vx;
  applyImpulse(p, { jx: 0, jy: 0 });
  assert.ok(Math.abs(p.vx) <= Math.abs(before));
});

test('L3 elasticCollision 动量守恒', () => {
  const a = { x: 50, y: 50, vx: 1, vy: 0, mass: 1 };
  const b = { x: 51, y: 50, vx: -1, vy: 0, mass: 1 };
  elasticCollision(a, b);
  // 总动量应不变（接近）
  const total = (a.vx + b.vx);
  assert.ok(Math.abs(total) < 0.01, `momentum not conserved: ${total}`);
});

test('L3 tick 预算超 50ms 不崩溃（极端输入）', () => {
  const w = new World('w1', 1, 42);
  w.addPlayer(1, 'A');
  // 灌入超大 intent 量
  for (let i = 0; i < 100; i++) w.intentQueue.push(1, { move: { dx: 1, dy: 1 } });
  const r = w.tickOnce();
  assert.ok(r);
});

test('L3 snapshot 不含全量 9216 资源（仅元数据）', () => {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true; // suppress AI opponents for this deterministic test
  w.addPlayer(1, 'A');
  w.tickOnce();
  const s = w.snapshot(false);
  assert.ok(!('resources' in s));
  assert.ok(s.playerCount === 1, 'should be only 1 human (AI suppressed)');
});

test('L3 自动攻击：靠近敌对单位自动开火，且只打射程内目标', () => {
  const w = new World('w1', 1, 42);
  const p = w.addPlayer(1, 'A');
  p.x = 50; p.y = 50;
  // e1 在 (52,50) 距离 2 < 自动攻击半径；e2 在 (80,80) 距离 ~42 远超半径
  w.entities.push({ id: 'e1', type: 'firefly', name: '流萤', x: 52, y: 50, vx: 0, vy: 0, mass: 1, speed: 0, hp: 20, hpMax: 20, color: '#fff', from: 'ca', faction: 'hostile', born: 0, life: 600 });
  w.entities.push({ id: 'e2', type: 'ant', name: '蚁工', x: 80, y: 80, vx: 0, vy: 0, mass: 1, speed: 0, hp: 20, hpMax: 20, color: '#fff', from: 'ac', faction: 'hostile', born: 0, life: 600 });
  // 不发送 attack 意图：靠近的 e1 应被自动攻击掉血（新设计：短距自动）
  w.intentQueue.push(1, { move: { dx: 1, dy: 0 } });
  w.tickOnce();
  assert.ok(w.entities.find(e => e.id === 'e1').hp < 20, '靠近的 e1 应被自动攻击掉血');
  assert.equal(w.entities.find(e => e.id === 'e2').hp, 20, '远处 e2（超出射程）不应被命中');
});

test('L3 涌现确定性：同种子同序列 → 首个涌现单位完全一致', () => {
  const a = new World('w_a', 1, 777); a.addPlayer(1, 'A');
  const b = new World('w_b', 1, 777); b.addPlayer(1, 'A');
  for (let i = 0; i < 500; i++) { a.tickOnce(); b.tickOnce(); }
  assert.ok(a.entities.length >= 1 && b.entities.length >= 1, 'both should have emergents');
  assert.equal(a.entities.length, b.entities.length, 'entity count should match');
  assert.equal(a.entities[0].type, b.entities[0].type, 'first emergent type matches');
  assert.equal(Math.round(a.entities[0].x), Math.round(b.entities[0].x));
  assert.equal(Math.round(a.entities[0].y), Math.round(b.entities[0].y));
});

test('L3 涌现类型来自算法信号（多种单位，绝不出现算法名）', () => {
  const w = new World('w_c', 1, 42); w.addPlayer(1, 'A');
  for (let i = 0; i < 600; i++) w.tickOnce();
  const types = new Set(w.entities.map(e => e.type));
  assert.ok(types.size >= 3, `multiple algorithm-driven types expected, got ${types.size}`);
  for (const t of types) assert.ok(EMERGENTS[t], 'unknown emergent type ' + t);
});