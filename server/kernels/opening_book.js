// server/kernels/opening_book.js — 开局库（哈希查找）
export function opening_book(ctx, rng, params) {
  const { hash, book: bk } = params;
  return { move: bk[hash] || null, total: Object.keys(bk).length };
}
opening_book.__meta = { id: 'opening_book', branch: 'game_decision', hardLimits: {}, fallback: 'noop' };