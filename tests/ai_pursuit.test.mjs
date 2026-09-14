// tests/ai_pursuit.test.mjs — verify AI now actually chases humans past 6 cells
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/engine.js';
import { makeAIPlayer, stepAI } from '../server/ai.js';

test('L3-AI AI actively pursues human within 12 cells', () => {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true;
  const human = w.addPlayer(1, 'Human');
  // manually add AI (since _skipAIFill blocked _maybeAddAI)
  const ai = makeAIPlayer(w, () => 0.5);
  ai.x = human.x + 8;
  ai.y = human.y;
  const startDx = human.x - ai.x, startDy = human.y - ai.y;
  const startDist = Math.hypot(startDx, startDy);
  // Run a few decision cycles (every 3 ticks). After ~30 ticks AI should have moved toward human.
  for (let i = 0; i < 30; i++) {
    ai._aiThink = 99; // force decision
    stepAI(w, w.intentQueue);
    const imp = w.intentQueue.drain(ai.id);
    if (imp && imp.jx) ai.x += imp.jx * 0.05; // simulate move from intent
    if (imp && imp.jy) ai.y += imp.jy * 0.05;
  }
  const dx = human.x - ai.x, dy = human.y - ai.y;
  const endDist = Math.hypot(dx, dy);
  assert.ok(endDist < startDist - 0.5, `AI should close distance to human. Start ${startDist.toFixed(2)} → end ${endDist.toFixed(2)}`);
});

test('L3-AI AI fills empty slots up to 4 total (engine layer)', () => {
  const w = new World('w1', 1, 42);
  w.addPlayer(1, 'H1');
  // 1 human → fills to 4 total (1 + 3 AI)
  assert.equal(Object.keys(w.players).length, 4, '1 human + 3 AI = 4 total');
  assert.equal(Object.values(w.players).filter(p => !p.isAI).length, 1);
  assert.equal(Object.values(w.players).filter(p => p.isAI).length, 3);
  w.addPlayer(2, 'H2');
  // 2 humans → fills to 4 total (2 + 2 AI)
  assert.equal(Object.keys(w.players).length, 4, '2 humans + 2 AI = 4 total');
  assert.equal(Object.values(w.players).filter(p => !p.isAI).length, 2);
  assert.equal(Object.values(w.players).filter(p => p.isAI).length, 2);
  w.addPlayer(3, 'H3');
  // 3 humans → fills to 4 total (3 + 1 AI)
  assert.equal(Object.keys(w.players).length, 4, '3 humans + 1 AI = 4 total');
  assert.equal(Object.values(w.players).filter(p => !p.isAI).length, 3);
  assert.equal(Object.values(w.players).filter(p => p.isAI).length, 1);
  w.addPlayer(4, 'H4');
  // 4 humans → 0 AI (no spawning since slots are full)
  assert.equal(Object.values(w.players).filter(p => !p.isAI).length, 4);
  assert.equal(Object.values(w.players).filter(p => p.isAI).length, 0);
});
