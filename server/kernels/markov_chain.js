// server/kernels/markov_chain.js — 马尔可夫链状态转移
export function markov_chain(ctx, rng, params) {
  const { state, mat, states, steps } = params;
  let cur = state, log = [cur];
  for (let i = 0; i < (steps || 8); i++) {
    const row = mat[cur]; if (!row) break;
    let r = rng(), sum = 0; let pick = cur;
    for (let j = 0; j < states; j++) { sum += row[j] || 0; if (r <= sum) { pick = j; break; } }
    cur = pick; log.push(cur);
  }
  return { state: cur, log };
}
markov_chain.__meta = { id: 'markov_chain', branch: 'systems', hardLimits: { steps: 256, states: 32 }, fallback: 'noop' };