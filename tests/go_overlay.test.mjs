// tests/go_overlay.test.mjs — go 棋盘「势力底色」必须与「数子归属」同口径
//
// 由来：底色读快照的 lifeOwner（原为 Voronoi 影响力半径），而胜负改由「就近归属」数子决定后，
// 两者算的不是同一套归属 → **地图颜色与最终得分对不上**（玩家一眼可见）。
// 修复：_goSnapshotState 计算数子时，把「就近归属」网格写回 lifeOwner，底色与结算天然一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, loadKernels } from '../server/engine.js';

await loadKernels();

const rect = (w, h) => Array.from({ length: h }, () => '#'.repeat(w)).join('/');

/** 造一个带散点棋子的 go 局（黑左半 / 白右半，中间大片空点 → 归属可区分）。 */
function scattered(seed = 2024, size = 32) {
  const wd = new World('ovl_' + seed, 1, seed, { mode: 'go', board: { w: size, h: size, shape: rect(size, size) } });
  wd._skipAIFill = true;
  wd.addAI();
  wd.addAI();
  const g = wd._goInit();
  const L = wd._life;
  const B = g.seatF[0], Wf = g.seatF[1];
  for (const y of [3, 11, 19, 27]) { L[3][y] = B; L[6][y] = B; }
  for (const y of [3, 11, 19, 27]) { L[size - 4][y] = Wf; L[size - 7][y] = Wf; }
  return { wd, g, B, Wf };
}

test('OVL-01 快照 lifeOwner 逐格等于数子归属网格（底色 = 结算口径）', () => {
  const { wd } = scattered();
  const s = wd.snapshot();
  const sc = wd._goScoreChinese();
  const W = wd.lifeW;
  assert.ok(s.lifeOwner, '快照应下发 lifeOwner');
  assert.equal(s.lifeOwner.length, W);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < W; y++) {
      assert.equal(s.lifeOwner[x][y], sc.ownerGrid[x * W + y], `lifeOwner(${x},${y}) 应与数子归属一致`);
    }
  }
});

test('OVL-02 棋子格的底色 = 自身阵营；空点底色 = 归属阵营或中立', () => {
  const { wd, B, Wf } = scattered();
  wd.snapshot();
  const L = wd._life, own = wd._lifeOwner, W = wd.lifeW;
  let ownedEmpty = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < W; y++) {
      const v = L[x][y];
      if (v > 0) {
        assert.equal(own[x][y], v, `棋子格(${x},${y}) 底色应为自身阵营 ${v}`);
      } else {
        assert.ok(own[x][y] === 0 || own[x][y] === B || own[x][y] === Wf, `空点底色必须是 0/黑/白之一`);
        if (own[x][y] !== 0) ownedEmpty++;
      }
    }
  }
  assert.ok(ownedEmpty > 0, '散点盘面应有大量归属空点（否则底色全中立 = 修复失效）');
});

test('OVL-03 底色确实换掉了 Voronoi：与旧口径至少一格不同', () => {
  const { wd } = scattered();
  const W = wd.lifeW, g = wd.go;
  // 先手动跑旧口径（Voronoi + 呼吸半径）
  wd._updateVoronoi(g._breathR);
  const voronoi = wd._lifeOwner.map((c) => Array.from(c));
  // 再走一次快照（应把 _lifeOwner 覆盖为就近归属）
  wd.snapshot();
  let diff = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) if (voronoi[x][y] !== wd._lifeOwner[x][y]) diff++;
  assert.ok(diff > 0, '若底色仍等于 Voronoi，说明修复未生效（两者在散点盘面上必然不同）');
});

test('OVL-04 空盘：底色全中立（无棋子 → 无归属）', () => {
  const wd = new World('ovl_empty', 1, 7, { mode: 'go', board: { w: 32, h: 32, shape: rect(32, 32) } });
  wd._skipAIFill = true;
  wd.addAI(); wd.addAI();
  wd._goInit();
  wd.snapshot();
  const own = wd._lifeOwner, W = wd.lifeW;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) assert.equal(own[x][y], 0, `空盘 (${x},${y}) 应中立`);
});

test('OVL-05 棋盘 >32 时底色网格尺寸跟随生命层', () => {
  const wd = new World('ovl_big', 1, 7, { mode: 'go', board: { w: 40, h: 40, shape: rect(40, 40) } });
  wd._skipAIFill = true;
  wd.addAI(); wd.addAI();
  const g = wd._goInit();
  wd._life[10][10] = g.seatF[0];
  wd._life[30][30] = g.seatF[1];
  const s = wd.snapshot();
  assert.equal(wd.lifeW, 40);
  assert.equal(s.lifeOwner.length, 40, '底色网格应为 40×40');
  assert.equal(s.lifeOwner[10][10], g.seatF[0], '棋盘远端棋子格底色正确（此前会崩溃）');
  assert.equal(s.lifeOwner[30][30], g.seatF[1]);
});
