// server/kernels/rule_184.js — 交通流 Rule 184
export function rule_184(ctx, rng, params) {
  const { cells, w, iters } = params;
  const grid = [cells.slice()]; let cur = cells.slice();
  for (let it = 0; it < iters; it++) {
    const nxt = new Uint8Array(w);
    for (let i = 0; i < w; i++) {
      const prev = cur[(i + w - 1) % w], self = cur[i], next = cur[(i + 1) % w];
      nxt[i] = (prev === 1 && self === 0) ? 1 : (self === 1 && next === 0) ? 1 : (self === 1 && next === 1) ? 1 : 0;
      nxt[i] = ((prev === 1 && self === 0) || (self === 1 && next === 1)) ? 1 : self;
    }
    grid.push(Array.from(nxt)); cur = nxt;
  }
  return { grid };
}
rule_184.__meta = { id: 'rule_184', branch: 'classic_rules', hardLimits: { w: 96, iters: 32 }, fallback: 'noop' };