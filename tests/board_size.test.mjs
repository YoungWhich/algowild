// tests/board_size.test.mjs — 自定义棋盘尺寸的运行时正确性（go 生命层跟随棋盘 / rts 恒 32）
//
// 背景（Bug 修复）：此前 go 棋盘位图尺寸可设到 100×100，但生命层被硬编码为 32×32，
// 于是 >32 的棋盘一落子就崩溃（go.js 里 L[nx][ny] 越界）。修复后：
//   · go：生命层**只涨不缩** —— max(32, 棋盘宽, 棋盘高)；棋盘 ≤32 时行为与改造前逐字节一致。
//   · rts：生命层恒 32（1 生命格 = 6×6 世界格），棋盘只做遮罩 → 棋盘尺寸上限 32。
// 本文件专门覆盖「尺寸 > 32 的棋盘真正可用」这条此前完全没测到的路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';
import { normBoard } from '../server/rooms.js';

await loadKernels();

const rect = (w, h) => Array.from({ length: h }, () => '#'.repeat(w)).join('/');
const mk = (w, h) => ({ w, h, shape: rect(w, h) });

function goWorld(w, h, seed = 42) {
  const wd = new World('bs_' + w + 'x' + h + '_' + seed, 1, seed, { mode: 'go', board: mk(w, h) });
  wd._skipAIFill = true;
  wd.addPlayer(1, 'Black');
  wd.addPlayer(2, 'White');
  wd._goInit();
  return wd;
}

test('BS-01 go 32×32：lifeW 保持 32，边界不变（不回归）', () => {
  const wd = goWorld(32, 32);
  assert.equal(wd.lifeW, 32, 'lifeW = 32');
  assert.equal(wd._life.length, 32, '生命层 32×32');
  assert.equal(wd._isPlayable(31, 31), true, '(31,31) 可落子');
  assert.equal(wd._isPlayable(32, 32), false, '越界为墙');
});

test('BS-02 go 100×100：生命层扩到 100，远端格可落子', () => {
  const wd = goWorld(100, 100);
  assert.equal(wd.lifeW, 100, 'lifeW 跟随棋盘');
  assert.equal(wd._life.length, 100, '生命层 100×100');
  assert.equal(wd._isPlayable(60, 60), true, '(60,60) 可落子（此前越界）');
  assert.equal(wd._isPlayable(99, 99), true, '(99,99) 可落子');
  assert.equal(wd._isPlayable(100, 100), false, '越界为墙');
});

test('BS-03 go 100×100：真实落子不崩溃（核心回归）', () => {
  const wd = goWorld(100, 100);
  const F = wd.go.blackF;
  const r = wd._goPlay(F, 60, 60, []);
  assert.equal(r.ok, true, '远端落子在修复前会抛 TypeError，现在应成功');
  const r2 = wd._goPlay(F, 100, 100, []);
  assert.equal(r2.ok, false, '越界落子被拒');
  assert.equal(r2.reason, 'oob');
});

test('BS-04 go 48×48：生命层 48，边界正确', () => {
  const wd = goWorld(48, 48);
  assert.equal(wd.lifeW, 48);
  assert.equal(wd._isPlayable(47, 47), true);
  assert.equal(wd._isPlayable(48, 48), false);
});

test('BS-05 go 小棋盘只涨不缩：3×3 → lifeW 仍 32（保持改造前行为）', () => {
  const wd = goWorld(3, 3);
  assert.equal(wd.lifeW, 32, '生命层不随小棋盘缩小');
  assert.equal(wd._life.length, 32);
  assert.equal(wd._isPlayable(2, 2), true, '棋盘内可落子');
  assert.equal(wd._isPlayable(3, 3), false, '棋盘外为墙');
});

test('BS-06 go 非方形 40×10：lifeW = max(w,h) = 40，超出棋盘的部分为墙', () => {
  const wd = goWorld(40, 10);
  assert.equal(wd.lifeW, 40);
  assert.equal(wd._isPlayable(39, 9), true, '棋盘内 (39,9) 可落子');
  assert.equal(wd._isPlayable(39, 10), false, '棋盘高外 (39,10) 为墙');
  assert.equal(wd._isPlayable(40, 0), false, '棋盘宽外 (40,0) 为墙');
});

test('BS-07 rts：棋盘尺寸上限 32（100 列形状被拒）', () => {
  assert.equal(normBoard(mk(100, 100), 'rts'), null, '100 列与钳后 32 不符 → 拒绝');
  assert.equal(normBoard(mk(33, 33), 'rts'), null, '33 列同理被拒');
  assert.deepEqual(normBoard(mk(32, 32), 'rts'), { w: 32, h: 32, shape: rect(32, 32) }, '32×32 合法');
  const wd = new World('bs_rts', 1, 42, { mode: 'rts', board: mk(32, 32) });
  wd._skipAIFill = true;
  wd._lifeInit();
  assert.equal(wd.lifeW, 32, 'rts 生命层恒 32');
});

test('BS-08 go：normBoard 允许到 100（>100 钳制后与形状不符 → 拒绝）', () => {
  const b = normBoard(mk(100, 100), 'go');
  assert.ok(b, '100×100 在 go 下合法');
  assert.equal(b.w, 100);
  assert.equal(b.h, 100);
  assert.equal(normBoard(mk(101, 101), 'go'), null, '101 列与钳后 100 不符 → 拒绝');
});

test('BS-09 snapshot.lifeW 反映真实生命层尺寸', () => {
  const wd = goWorld(48, 48);
  const s = wd.snapshot();
  assert.equal(s.lifeW, 48, 'snapshot.lifeW = 48');
  assert.equal(s.settings.board.w, 48, 'settings.board 回显棋盘');
});

test('BS-10 board=null：lifeW 32、无位图、行为不回归', () => {
  const wd = new World('bs_null', 1, 7, { mode: 'go' });
  wd._skipAIFill = true;
  wd.addPlayer(1, 'Black');
  wd.addPlayer(2, 'White');
  wd._goInit();
  assert.equal(wd.lifeW, 32);
  assert.equal(wd.board, null);
  assert.equal(wd._isPlayable(31, 31), true);
  assert.equal(wd._isPlayable(32, 32), false);
});

test('BS-11 go 100×100：演化 + 就近归属数子在超大网格上正常工作', () => {
  const wd = goWorld(100, 100);
  const L = wd._life;
  const B = wd.go.blackF, Wf = wd.go.whiteF;
  // 左侧竖三连（黑）+ 右侧竖三连（白）：直线三连在康威规则下可存活，演化后仍在。
  for (let i = 0; i < 3; i++) { L[10][10 + i] = B; L[89][10 + i] = Wf; }
  wd._goEvolveOnce(3);                       // 演化一步（超大网格不得崩溃）
  const sc = wd._goScoreChinese();
  assert.ok(Number.isFinite(sc.black) && Number.isFinite(sc.white), '数子返回有限数值');
  assert.ok(sc.emptyByF[B] > 0, '黑在 100×100 上有地盘（就近归属生效）');
  assert.ok(sc.emptyByF[Wf] > 0, '白在 100×100 上有地盘');
  assert.equal(sc.black + sc.white > 0, true, '总分大于 0');
});

test('BS-12 go 100×100：AI 在全盘范围选点且不落墙', async () => {
  const { goAIMove } = await import('../server/ai.js');
  const wd = goWorld(100, 100, 99);
  const mv = goAIMove(wd, wd.go.blackF);
  assert.ok(mv, 'AI 返回决策');
  if (mv.moves) {
    for (const m of mv.moves) {
      assert.ok(!wd._isWall(m.lx, m.ly), `AI 落子 (${m.lx},${m.ly}) 不在墙上`);
      assert.ok(m.lx >= 0 && m.lx < 100 && m.ly >= 0 && m.ly < 100, 'AI 落子在棋盘范围内');
    }
  }
});

test('BS-13 确定性：同 seed 同尺寸的世界 lifeW 与棋盘一致', () => {
  const a = goWorld(64, 64, 5);
  const b = goWorld(64, 64, 5);
  assert.equal(a.lifeW, b.lifeW);
  assert.equal(a.lifeW, 64);
  assert.equal(a._life.length, b._life.length);
});
