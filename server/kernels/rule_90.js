// server/kernels/rule_90.js — Wolfram Rule 90（Sierpinski）
export function rule_90(ctx, rng, params) {
  const { cells: row, w, iters } = params;
  const grid = [row.slice()]; let cur = row.slice();
  for (let it = 0; it < iters; it++) {
    const nxt = new Uint8Array(w);
    for (let i = 0; i < w; i++) {
      const l = cur[(i - 1 + w) % w], r = cur[(i + 1) % w];
      nxt[i] = l ^ r;
    }
    grid.push(Array.from(nxt)); cur = nxt;
  }
  return { grid };
}
rule_90.__meta = { id: 'rule_90', branch: 'classic_rules', hardLimits: { w: 96, iters: 32 }, fallback: 'noop' };