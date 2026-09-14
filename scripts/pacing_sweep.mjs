// scripts/pacing_sweep.mjs — sweep life-board tuning params to find a 10-15min match.
// Simulates a player walking a circle (no dodging, no attacking) as a baseline.
import { World } from '../server/engine.js';

function run(seed, cfg, maxTicks = 24000) {
  World.SEED_COOLDOWN = cfg.cd;
  World.TERRITORY_WIN = cfg.win;
  World.DEATH_CELL_LOSS = cfg.loss;
  World.ERAS[3].cells = cfg.empire;
  const w = new World('w1', 1, seed);
  const p = w.addPlayer(1, 'P');
  for (let i = 0; i < maxTicks; i++) {
    const a = i * 0.012;
    p.x = 48 + Math.cos(a) * 38;
    p.y = 48 + Math.sin(a) * 38;
    w.tickOnce();
    if (p.won) return { t: w.tick / 20, r: 'WON ' + p.winReason };
    if (p.lost) return { t: w.tick / 20, r: 'LOST' };
  }
  return { t: maxTicks / 20, r: 'none(' + p.eraName + ' peak=' + p.maxLifeCells + ')' };
}

const cfgs = [
  { cd: 1, win: 14, loss: 0.05, empire: 180, label: 'cd1 e180 w14' },
  { cd: 1, win: 14, loss: 0.05, empire: 150, label: 'cd1 e150 w14' },
  { cd: 1, win: 12, loss: 0.05, empire: 150, label: 'cd1 e150 w12' },
  { cd: 2, win: 12, loss: 0.05, empire: 150, label: 'cd2 e150 w12' },
  { cd: 2, win: 12, loss: 0.05, empire: 130, label: 'cd2 e130 w12' },
];

const seeds = [7, 99, 2024];
for (const cfg of cfgs) {
  const out = seeds.map(s => {
    const r = run(s, cfg);
    return 's' + s + ' ' + r.t.toFixed(0) + 's ' + r.r;
  });
  console.log(cfg.label.padEnd(15), '|', out.join('  |  '));
}
