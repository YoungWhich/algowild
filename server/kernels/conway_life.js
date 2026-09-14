// server/kernels/conway_life.js — Conway B3/S23（CA 别名）
import { cellular_automaton } from './cellular_automaton.js';
export function conway_life(ctx, rng, params) {
  const r = cellular_automaton(ctx, rng, { ...params, rule: 'B3/S23' });
  return { cells: r.cells, alive: r.cells.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0) };
}
conway_life.__meta = { id: 'conway_life', branch: 'classic_rules', hardLimits: { w: 96, h: 96 }, fallback: 'noop' };