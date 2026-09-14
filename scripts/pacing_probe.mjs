// scripts/pacing_probe.mjs — measure how long each victory condition takes in practice.
// Simulates a player moving around and reports when each win condition fires.
import { World } from '../server/engine.js';

function simulate(label, movement, maxTicks = 20000) {
  const w = new World('w1', 1, 42);
  w._skipAIFill = true;
  const p = w.addPlayer(1, 'P');
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  let result = null;
  for (let i = 0; i < maxTicks; i++) {
    movement(p, i, rand);
    w.tickOnce();
    if (p.won) {
      result = { ticks: w.tick, seconds: (w.tick / 20).toFixed(1), reason: p.winReason };
      break;
    }
    if (p.lost) {
      result = { ticks: w.tick, seconds: (w.tick / 20).toFixed(1), reason: 'LOST:' + p.lostReason };
      break;
    }
  }
  if (!result) {
    // Report progress at end
    const stock = p._stock || {};
    let strong = 0;
    w._regionControlInit();
    for (const cell of w._regionControl) if ((cell[p.id] || 0) >= 12) strong++;
    result = {
      ticks: maxTicks, seconds: (maxTicks / 20).toFixed(1), reason: 'NO_WIN',
      progress: { stock, strongRegions: strong, score: p.score, deaths: p.deaths },
    };
  }
  console.log(`${label.padEnd(28)} ${JSON.stringify(result)}`);
  return result;
}

// 1) Idle player (does nothing, just sits there)
simulate('idle (no movement)', () => {});

// 2) Random walk
simulate('random walk', (p, i, rand) => {
  if (i % 20 === 0) {
    const a = rand() * Math.PI * 2;
    w_move(p, a);
  }
});

// 3) Systematic sweep: walk across all 8x8 regions (like a completionist)
simulate('region sweep (8x8)', (p, i) => {
  // Move diagonally across regions
  p.x = ((i / 12) | 0) % 96;
  p.y = ((i / 156) | 0) % 96;
});

function w_move(p, a) {
  p.vx += Math.cos(a) * 0.5;
  p.vy += Math.sin(a) * 0.5;
}
