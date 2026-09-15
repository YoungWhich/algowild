// tests/go_territory.test.mjs — go 模式「就近归属（势力范围）」地盘归属
//
// 覆盖需求返工（2026-09）：go 判空点归属从「严格围空（仿围棋）」改为「就近归属（势力范围）」。
//   GT-01 散点局面就归属：左半黑散点 / 右半白散点 → 双方地盘都 > 0（不再全中立）+ 旧口径对照
//   GT-02 等距中立：双方棋子等距的空点不计给任何方
//   GT-03 空盘：无源 → 全中立 → 0:0 平局（无 komi）
//   GT-04 墙阻断：BFS 不穿虚空 / 形状外的墙
//   GT-05 对称盘等分：180° 旋转对称 → 双方数子相等（无 komi）
//   GT-06 被吃光方分数恒 0，永不反超
//   GT-07 确定性：同一盘面多次调用结果完全一致；go.js 无 Math.random / Date.now
//   GT-08 保留契约：_goEnclosedEmpty（旧口径）/ _goScore（Voronoi）仍在且可用
// 风格参考 tests/go_mode.test.mjs：node:test + node:assert/strict。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';

await loadKernels();

// 空盘 go 世界（2 座位，跳过 AI 自动补位）。
function seated(seed = 42, opts) {
  const w = new World('goTerr' + seed, 1, seed, Object.assign({ mode: 'go' }, opts || {}));
  w._skipAIFill = true;
  w.addPlayer(1, 'Black');
  w.addPlayer(2, 'White');
  w._goInit();
  return w;
}
function clearLife(w) {
  const L = w._life;
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) L[x][y] = 0;
  return L;
}
function boardOf(w, h, rows) { return { w, h, shape: rows.join('/') }; }

// ============================================================ GT-01 散点就近归属
test('GT-01 散点就近归属：左半黑散点 / 右半白散点 → 双方地盘都 > 0（不再全中立）', () => {
  const w = seated(5001);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 3; x <= 13; x += 3) for (let y = 3; y <= 28; y += 4) L[x][y] = B;
  for (let x = 18; x <= 28; x += 3) for (let y = 3; y <= 28; y += 4) L[x][y] = W;

  const { byF: newByF } = w._goNearestEmpty();
  const { byF: oldByF } = w._goEnclosedEmpty();

  // 新口径：双方各占大片地盘（散点撒子也能占地）。
  assert.ok(newByF[B] > 0, '黑地盘应 > 0');
  assert.ok(newByF[W] > 0, '白地盘应 > 0');
  assert.equal(newByF[B], 452, '黑就近归属 452 个空点');
  assert.equal(newByF[W], 484, '白就近归属 484 个空点');
  const emptyTotal = 32 * 32 - 56;                     // 两方各 28 子 → 968 空点
  assert.equal(emptyTotal - (newByF[B] + newByF[W]), 32, '仅 32 个空点中立（绝大部分已归属，不再全中立）');

  // 对照（改造证据）：旧「严格围空」口径下双方围空皆为 0 —— 胜负退化为「谁落子多」。
  assert.equal(oldByF[B] || 0, 0, '旧口径黑围空为 0');
  assert.equal(oldByF[W] || 0, 0, '旧口径白围空为 0');

  // _goScoreChinese 走新口径：数子 = 子数 + 就近地盘。
  const sc = w._goScoreChinese();
  assert.equal(sc.stoneByF[B], 28, '黑子数 28');
  assert.equal(sc.stoneByF[W], 28, '白子数 28');
  assert.equal(sc.emptyByF[B], 452, '黑空地 452');
  assert.equal(sc.emptyByF[W], 484, '白空地 484');
  assert.equal(sc.byF[B], 480, '黑数子 = 28 + 452 = 480');
  assert.equal(sc.byF[W], 512, '白数子 = 28 + 484 = 512');
  // 结构不变式：总分 = 子数 + 空地（逐阵营）
  for (const f of [B, W]) {
    assert.equal(sc.byF[f], sc.stoneByF[f] + sc.emptyByF[f], `faction ${f} 总分 = 子数 + 空地`);
  }
});

// ============================================================ GT-02 等距中立
test('GT-02 等距中立：双方棋子等距的空点不计给任何方', () => {
  // 31 宽棋盘关于 x=15 对称；黑 (10,16) 与白 (20,16) 关于该列对称。
  // 中线整列（x=15）到两子曼哈顿距离恒等 → 全列中立。
  const rows = [];
  for (let y = 0; y < 32; y++) rows.push('#'.repeat(31));
  const w = seated(906, { board: boardOf(31, 32, rows) });
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  L[10][16] = B; L[20][16] = W;

  const { byF } = w._goNearestEmpty();
  assert.equal(byF[B], 479, '黑就近归属 479 空点');
  assert.equal(byF[W], 479, '白就近归属 479 空点');
  assert.equal(byF[B], byF[W], '对称 → 双方等分（等距点不计给任一方）');
  const emptyTotal = 31 * 32 - 2;                      // 990
  assert.equal(emptyTotal - (byF[B] + byF[W]), 32, '恰有 32 个空点等距中立（中线整列）');
});

// ============================================================ GT-03 空盘
test('GT-03 空盘：无任何棋子 → 无 BFS 源 → 所有空点中立 → 0:0 平局', () => {
  const w = seated(1001);
  clearLife(w);
  const { byF } = w._goNearestEmpty();
  assert.deepEqual(Object.keys(byF), [], '空盘无任何归属（无 BFS 源）');
  const sc = w._goScoreChinese();
  assert.equal(sc.emptyByF[w.go.blackF] || 0, 0);
  assert.equal(sc.emptyByF[w.go.whiteF] || 0, 0);
  // 端到端：双方各 pass → 终局 → 0:0 平局（无 komi）。
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result, '应已终局');
  assert.equal(w.go.result.blackScore, 0);
  assert.equal(w.go.result.whiteScore, 0);
  assert.equal(w.go.result.winner, null, '空盘 → 0:0 平局（无 komi 补偿）');
});

// ============================================================ GT-04 墙阻断
test('GT-04 墙阻断：BFS 不穿墙（虚空列）—— 对面区域不可达 → 中立', () => {
  // 32×32，第 16 列整列为虚空（墙），把盘面切成左 16 列 / 右 15 列。
  const rows = [];
  for (let y = 0; y < 32; y++) {
    let r = '';
    for (let x = 0; x < 32; x++) r += (x === 16 ? 'x' : '#');
    rows.push(r);
  }
  const board = boardOf(32, 32, rows);

  // (a) 仅黑一子在墙左侧：只能吃到左侧，墙右区域不可达 → 中立。
  const w = seated(903, { board });
  const L = clearLife(w);
  const B = w.go.blackF;
  L[5][16] = B;
  const { byF } = w._goNearestEmpty();
  assert.equal(byF[B], 512 - 1, '黑只吸到墙左侧 511 格（右侧被墙阻断）');
  assert.equal(Object.keys(byF).length, 1, '白方无子且右侧不可达 → 无其它归属');

  // (b) 对照：同样一子放在**无墙**盘 → 应吸满 1023 格（差异来自墙阻断）。
  const w2 = seated(907);
  const L2 = clearLife(w2);
  L2[5][16] = w2.go.blackF;
  assert.equal(w2._goNearestEmpty().byF[w2.go.blackF], 1023, '无墙时同一子吸满 1023 格');

  // (c) 双方各在墙的一侧：各自只吃自己那一侧，互不越墙。
  const w3 = seated(904, { board });
  const L3 = clearLife(w3);
  const B3 = w3.go.blackF, W3 = w3.go.whiteF;
  L3[5][16] = B3; L3[26][16] = W3;
  const r3 = w3._goNearestEmpty().byF;
  assert.equal(r3[B3], 511, '黑 511（左 16 列 - 1 子）');
  assert.equal(r3[W3], 479, '白 479（右 15 列 - 1 子）');
});

// ============================================================ GT-05 对称盘等分
test('GT-05 对称盘等分：180° 旋转对称 → 双方数子相等（无 komi）', () => {
  const w = seated(4001);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  // 黑块与白块关于盘心 (15.5,15.5) 旋转对称（(x,y)|→(31-x,31-y)）。
  L[3][3] = B; L[4][3] = B; L[3][4] = B; L[4][4] = B;
  L[28][28] = W; L[27][28] = W; L[28][27] = W; L[27][27] = W;
  const sc = w._goScoreChinese();
  assert.equal(sc.emptyByF[B], 480, '黑就近归属 480 空点');
  assert.equal(sc.emptyByF[W], 480, '白就近归属 480 空点');
  assert.equal(sc.black, 484); assert.equal(sc.white, 484);
  assert.equal(sc.black, sc.white, '对称盘面等分（无 komi：黑先不白送分）');
  // 端到端：pass×2 → 平局。
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.winner, null, '等分 → 平局');
  assert.equal(w.players[w.go.blackId].won, false);
  assert.equal(w.players[w.go.whiteId].won, false);
});

// ============================================================ GT-06 被吃光方 0 分不反超
test('GT-06 被吃光方分数恒 0、不出局、永不反超（胜负由数子决定）', () => {
  const w = seated(2001);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  L[20][20] = W; L[21][20] = W; L[20][21] = W; L[21][21] = W;   // 白 4 子
  const pB = w.players[w.go.blackId];
  pB.maxLifeCells = 6; pB.lifeCells = 0;

  const sc = w._goScoreChinese();
  assert.equal(sc.stoneByF[B] || 0, 0, '黑 0 子');
  assert.equal(sc.emptyByF[B] || 0, 0, '黑无子 → 无 BFS 源 → 0 地盘');
  assert.equal(sc.byF[B] || 0, 0, '黑数子恒 0');

  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result, null, '被吃光不触发终局');
  assert.equal(pB.lost, false, '被吃光方不出局');
  // 双方停手 → 终局
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.ok(w.go.result, '双方停手后终局');
  assert.equal(w.go.result.reason, 'pass');
  const rankedB = w.go.result.ranked.find(r => r.playerId === w.go.blackId);
  assert.ok(rankedB, '被吃光方仍在胜负池中');
  assert.equal(rankedB.score, 0, '被吃光方数子 = 0');
  assert.equal(w.go.result.winner, w.go.whiteId, '白数子多者胜');
  assert.ok(w.go.result.whiteScore > w.go.result.blackScore);
});

// ============================================================ GT-07 确定性 + 源码守卫
test('GT-07 确定性：同一盘面多次调用结果完全一致；go.js 无 Math.random / Date.now', () => {
  const w = seated(3001);
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  for (let x = 3; x <= 18; x += 3) for (let y = 3; y <= 18; y += 3) L[x][y] = B;
  L[0][0] = W; L[1][0] = W;

  const a = w._goNearestEmpty();
  const b = w._goNearestEmpty();
  const c = w._goNearestEmpty();
  assert.deepEqual(a, b, '重复调用结果一致');
  assert.deepEqual(b, c, '重复调用结果一致');

  // 同盘面另一世界 → 结果一致（纯函数、无随机、无隐藏状态）。
  const w2 = seated(3001);
  const L2 = clearLife(w2);
  for (let x = 3; x <= 18; x += 3) for (let y = 3; y <= 18; y += 3) L2[x][y] = w2.go.blackF;
  L2[0][0] = w2.go.whiteF; L2[1][0] = w2.go.whiteF;
  assert.deepEqual(w2._goNearestEmpty(), a, '同盘面两世界结果一致');

  // 铁律 IR-3a：go.js 源码（剔除注释）不得含 Math.random / Date.now。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const src = stripComments(readFileSync(new URL('../server/go.js', import.meta.url), 'utf8'));
  assert.ok(!/Math\.random\s*\(/.test(src), 'server/go.js 不得含 Math.random()');
  assert.ok(!/Date\.now\s*\(/.test(src), 'server/go.js 不得含 Date.now()');
});

// ============================================================ GT-08 保留契约
test('GT-08 保留契约：_goEnclosedEmpty（旧口径）/ _goScore（Voronoi）仍在且可用', () => {
  const w = seated(42);
  assert.equal(typeof w._goEnclosedEmpty, 'function', '_goEnclosedEmpty 应保留');
  assert.equal(typeof w._goScore, 'function', '_goScore 应保留');
  assert.equal(typeof w._goNearestEmpty, 'function', '_goNearestEmpty 应存在');
  // 黑白各一子（相距较远）：新旧口径在该盘面语义不同 —— 旧口径双方围空皆 0，新口径各占约半盘。
  const L = clearLife(w);
  const B = w.go.blackF, W = w.go.whiteF;
  L[5][5] = B; L[25][25] = W;
  const oldByF = w._goEnclosedEmpty().byF;
  const newByF = w._goNearestEmpty().byF;
  assert.equal(oldByF[B] || 0, 0, '旧「严格围空」口径：黑围空 0');
  assert.equal(oldByF[W] || 0, 0, '旧「严格围空」口径：白围空 0');
  assert.equal(newByF[B], 434, '新「就近归属」口径：黑 434');
  assert.equal(newByF[W], 485, '新「就近归属」口径：白 485');
  // _goScore（Voronoi 目数）仍可用且结构不变（GM-10/GM-23 依赖）。
  const sc = w._goScore();
  assert.ok(sc && typeof sc.black === 'number', '_goScore 仍返回 Voronoi 目数结构');
  assert.ok(sc.byF && typeof sc.byF === 'object', '_goScore 返回 byF');
});
