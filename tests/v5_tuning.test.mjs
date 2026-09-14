// tests/v5_tuning.mjs — verify the v5 difficulty tightening is real
// - AI chases humans (not just stands there)
// - Singular victory at 30 (not 20)
// - Territory needs 6 regions × 12 control (not 5 × 5)
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/engine.js';
import { makeAIPlayer, stepAI } from '../server/ai.js';

test('V5-1 Singularity threshold is 30, not 20', () => {
  const w = new World('w1', 1, 42);
  const p = w.addPlayer(1, 'P');
  // Manually push stock to 29 → should NOT win
  p._stock = { wood: 29, stone: 29, ore: 29, crystal: 29, food: 29, shard: 29 };
  for (let i = 0; i < 5; i++) w.tickOnce();
  assert.equal(p.won, false, 'at 29 each, should NOT win');
  // Push to 30 → should win
  p._stock = { wood: 30, stone: 30, ore: 30, crystal: 30, food: 30, shard: 30 };
  w.tickOnce();
  assert.equal(p.won, true, 'at 30 each, SHOULD win');
  assert.equal(p.winReason, 'singularity');
});

test('V5-2 Territory victory needs empire era + 12 regions', () => {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true;
  const p = w.addPlayer(1, 'P');
  // 16 regions owned but still tribe era → should NOT win
  p.regionsOwned = 16;
  p.era = 0;
  w._checkVictoryConditions([]);
  assert.equal(p.won, false, '16 regions at tribe era should NOT win (must grow first)');
  // Reach empire era → SHOULD win
  p.era = 3;
  w._checkVictoryConditions([]);
  assert.equal(p.won, true, 'empire + 16 regions SHOULD win');
  assert.equal(p.winReason, 'territory');
});

test('V5-3 Economy victory needs ecosystem era + lead 600 × 1800 ticks + 10 regions', () => {
  const w = new World('w1', 1, 42);
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  // 直接调用胜利判定（不用 tickOnce：tick 会按棋盘真实归属重算 regionsOwned）
  p1.score = 700; p2.score = 50;   // lead = 650 (≥600)
  p1.regionsOwned = 10;            // 还必须控制 10 区（堵住"角落刷分经济胜"漏洞）
  p1.era = 3;                      // 经济胜收束到"生态系统纪"
  p1.scoreLeadTicks = 1799;        // 已领先 1799 tick，再来一拍即满 1800
  w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 1800, 'lead tick counter should advance');
  w._checkVictoryConditions([]);
  assert.equal(p1.won, true, '生态纪 lead 650 + 10 regions + 1800 ticks should win');
  assert.equal(p1.winReason, 'economy');
});

test('V5-3b Lead of only 100 (below new 600 threshold) does NOT trigger', () => {
  const w = new World('w1', 1, 42);
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  p1.score = 150; p2.score = 50;   // lead = 100
  p1.regionsOwned = 12;
  p1.era = 3;
  p1.scoreLeadTicks = 99999;
  w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 0, 'lead below threshold resets counter');
  assert.equal(p1.won, false, 'lead 100 should NOT trigger economy victory');
});

test('V5-3c Economy win needs land: lead 650 but 0 regions must NOT trigger', () => {
  const w = new World('w1', 1, 42);
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  p1.score = 700; p2.score = 50;   // lead = 650
  p1.regionsOwned = 0;             // 角落刷分：无地
  p1.era = 3;
  p1.scoreLeadTicks = 99999;
  w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 0, 'no land -> economy counter resets');
  assert.equal(p1.won, false, 'score lead without land should NOT win economy');
});

test('V5-3d Economy win needs ecosystem era: pre-ecosystem must NOT trigger', () => {
  const w = new World('w1', 1, 42);
  const p1 = w.addPlayer(1, 'P1');
  const p2 = w.addPlayer(2, 'P2');
  p1.score = 700; p2.score = 50;   // lead = 650
  p1.regionsOwned = 12;
  p1.era = 2;                      // 还在动植物纪，经济胜不允许提前终结长局
  p1.scoreLeadTicks = 99999;
  w._checkVictoryConditions([]);
  assert.equal(p1.scoreLeadTicks, 0, 'pre-ecosystem era -> economy counter resets');
  assert.equal(p1.won, false, 'economic victory should only be reachable at ecosystem era');
});

test('V5-4 AI actively pursues human within 12 cells (closes distance)', () => {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true;
  const human = w.addPlayer(1, 'Human');
  const ai = makeAIPlayer(w, () => 0.5);
  ai.x = human.x + 10;
  ai.y = human.y;
  const startDist = Math.hypot(human.x - ai.x, human.y - ai.y);
  // Run 60 ticks with real impulse physics so AI actually accelerates toward human
  for (let i = 0; i < 60; i++) {
    ai._aiThink = 99;
    stepAI(w, w.intentQueue);
    const imp = w.intentQueue.drain(ai.id);
    if (imp) {
      ai.vx = ai.vx * 0.85 + (imp.jx * 0.6);
      ai.vy = ai.vy * 0.85 + (imp.jy * 0.6);
      const sp = Math.hypot(ai.vx, ai.vy);
      if (sp > 1.6) { ai.vx = (ai.vx / sp) * 1.6; ai.vy = (ai.vy / sp) * 1.6; }
      ai.x += ai.vx;
      ai.y += ai.vy;
    }
  }
  const endDist = Math.hypot(human.x - ai.x, human.y - ai.y);
  assert.ok(endDist < startDist - 0.5, `AI should close distance: ${startDist.toFixed(2)} → ${endDist.toFixed(2)}`);
});

test('V5-5 AI uses dash to close distance when in mid-range', () => {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true;
  const human = w.addPlayer(1, 'Human');
  const ai = makeAIPlayer(w, () => 0.5);
  ai.x = human.x + 7;  // mid-range (5-10 cells)
  ai.y = human.y;
  ai.dashCharge = 1;
  ai.dashCooldown = 0;
  ai._aiThink = 99;
  stepAI(w, w.intentQueue);
  const imp = w.intentQueue.drain(ai.id);
  assert.ok(imp && imp.dash, 'AI should push dash intent when in mid-range with charge ready');
});

test('V5-6 Death penalty: shard loss 10% on death', () => {
  const w = new World('w1', 1, 42);
  const p = w.addPlayer(1, 'P');
  p._stock = p._stock || { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 };
  p._stock.shard = 20;
  p.x = 50; p.y = 50;
  // Place hostile right next to player
  w.entities.push({ id: 'e1', type: 'firefly', name: 'firefly', x: 50.5, y: 50, vx: 0, vy: 0, mass: 1, speed: 0, hp: 10, hpMax: 10, color: '#fff', from: 'ca', faction: 'hostile', born: 0, life: 600 });
  // Trigger death: contact damage is 18, so hp must be at or below that
  p.hp = 10;
  w.tickOnce();
  assert.equal(p.alive, false, 'player should die');
  assert.equal(p._stock.shard, 18, 'shard should drop from 20 to 18 (10% loss)');
});
