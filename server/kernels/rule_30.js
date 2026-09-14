// server/kernels/rule_30.js — Wolfram Rule 30（1D CA → 2D 演化）
export function rule_30(ctx, rng, params) {
  const { cells: row, w, iters } = params;
  const grid = [row.slice()]; let cur = row.slice();
  for (let it = 0; it < iters; it++) {
    const nxt = new Uint8Array(w);
    for (let i = 0; i < w; i++) {
      const l = cur[(i - 1 + w) % w], c = cur[i], r = cur[(i + 1) % w];
      nxt[i] = ((l << 2) | (c << 1) | r) & 0b110110 ? ((l << 2 | c << 1 | r) >> 3 & 1) ^ (((l << 2 | c << 1 | r) >> 2) & 1) ^ (((l << 2 | c << 1 | r) >> 1) & 1) : 0;
      // Rule 30: 000->0, 001->1, 010->1, 011->1, 100->1, 101->0, 110->0, 111->0
      const idx = (l << 2) | (c << 1) | r;
      nxt[i] = ((30 >> idx) & 1);
    }
    grid.push(Array.from(nxt)); cur = nxt;
  }
  return { grid };
}
rule_30.__meta = { id: 'rule_30', branch: 'classic_rules', hardLimits: { w: 96, iters: 32 }, fallback: 'noop' };