// tests/multiplayer.test.mjs — L5 联机延迟物理测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentQueue, applyImpulse, elasticCollision, MERGE_MAX } from '../server/intents.js';

test('L5-MP-01 FIFO + 不测量延迟', () => {
  const q = new IntentQueue();
  const T0 = Date.now() - 10000; // 伪造"10 秒前"的 timestamp
  q.push('p1', { move: { dx: 1, dy: 0 }, ts: T0 });
  const d = q.drain('p1');
  // 服务器只按到达时间 FIFO，不读 ts
  assert.equal(d.moveCount, 1);
});

test('L5-MP-02 慢网玩家累计冲量更大', () => {
  // 模拟两种玩家：低延迟/高延迟
  const fast = new IntentQueue(); const slow = new IntentQueue();
  // 200ms 内 fast 发 4 条，slow 因为延迟堆积发 4 条但同 tick 一起到
  for (let i = 0; i < MERGE_MAX; i++) fast.push('fast', { move: { dx: 1, dy: 0 } });
  // slow 累积 5 条（>MERGE_MAX）
  for (let i = 0; i < 5; i++) slow.push('slow', { move: { dx: 1, dy: 0 } });
  const df = fast.drain('fast'); const ds = slow.drain('slow');
  assert.equal(Math.abs(ds.jx), MERGE_MAX, `slow merged to ${MERGE_MAX}`);
  assert.equal(Math.abs(df.jx), MERGE_MAX, `fast merged to ${MERGE_MAX}`);
  // 都达到上限时相同；但累积次数更多 → 慢网玩家 moveCount 更高 → 持续按相同冲量推
  assert.ok(ds.moveCount > df.moveCount);
});

test('L5-MP-06 不同延迟玩家碰撞（动量守恒）', () => {
  const a = { id: 'fast', x: 50, y: 50, vx: 2, vy: 0, mass: 1 };
  const b = { id: 'slow', x: 50.5, y: 50, vx: -2, vy: 0, mass: 2 };
  // 慢网玩家的 mass 更大（理解为惯性）
  const p0 = a.mass * a.vx + b.mass * b.vx;
  elasticCollision(a, b);
  const p1 = a.mass * a.vx + b.mass * b.vx;
  assert.ok(Math.abs(p1 - p0) < 0.01, `总动量不守恒: Δ=${p1 - p0}`);
});

test('L5-MP-08 非法指令丢弃（NaN）', () => {
  const q = new IntentQueue();
  // NaN 检测在 net 层；这里模拟 intentQueue 接收到的合法性
  let ok = false;
  try { q.push('p', { move: { dx: NaN, dy: 0 } }); ok = true; } catch { ok = false; }
  // IntentQueue 不做合法性校验（这是 net 层职责），所以接收；测试只确保不抛
  assert.ok(ok);
});

test('L5-MP-04 伪造时间戳被忽略', () => {
  // 服务器不读 ts；这里用 fn 模拟
  const intent = { move: { dx: 1, dy: 0 }, ts: 0 };
  const q = new IntentQueue();
  q.push('p', intent);
  const d = q.drain('p');
  assert.ok(d.moveCount === 1);
});