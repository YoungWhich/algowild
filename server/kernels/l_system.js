// server/kernels/l_system.js — L-system 重写
export function l_system(ctx, rng, params) {
  const { axiom, rules, iters } = params;
  let s = axiom;
  let i = 0;
  while (i++ < (iters || 4) && s.length < 4096) {
    let next = '';
    for (const c of s) next += (rules[c] || c);
    s = next;
  }
  return { str: s };
}
l_system.__meta = { id: 'l_system', branch: 'systems', hardLimits: { iters: 8, len: 4096 }, fallback: 'noop' };