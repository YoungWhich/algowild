// server/kernels/fuzzy_logic.js — 模糊推理（3 规则）
export function fuzzy_logic(ctx, rng, params) {
  const { inp, rules } = params;
  const con = (m, x) => Math.max(0, Math.min(1, 1 - Math.abs(x - m.c) / Math.max(0.01, m.w)));
  let num = 0, den = 0;
  for (const r of rules) {
    let deg = 1;
    for (const k of Object.keys(r.ifs)) deg = Math.min(deg, con(inp[k], r.ifs[k]));
    num += deg * r.then.c; den += deg;
  }
  return { out: den ? num / den : 0 };
}
fuzzy_logic.__meta = { id: 'fuzzy_logic', branch: 'systems', hardLimits: { rules: 32 }, fallback: 'noop' };