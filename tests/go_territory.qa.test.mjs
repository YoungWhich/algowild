// tests/go_territory.qa.test.mjs — 独立验证（QA · Edward）：go「就近归属（势力范围）」地盘归属
//
// 本文件**独立于** tests/go_territory.test.mjs（工程自测），不复跑其断言，而是：
//   QT-01 小棋盘手算：1×5 / 3×3 World.LIFE_W 子区域，逐空点手算归属 vs _goNearestEmpty
//   QT-02 等距中立：对称/等距空点不计给任何方（逐点验证 + 计数）
//   QT-03 不可达中立：墙完全隔离且无子的区域全中立
//   QT-04 墙不穿透：虚空墙两侧归属互不影响（与无墙盘对照）
//   QT-05 散点成效：就近归属使双方各占地盘；旧口径 _goEnclosedEmpty 同盘为 0（改造证据）
//   QT-06 红线性质：空盘 0:0 / 被吃光恒 0 不反超 / 180°对称等分 / 无 komi / winReason='go'
//   QT-07 未改动契约：_goScore（Voronoi）与 _goFinish 胜负池逻辑未被本次改动触及
//   QT-08 确定性：同盘重复调用一致；server/go.js 无 Math.random / Date.now
//   QT-09 已知断言锁：独立重算并锁定「被改动过的既有断言」中的精确值（防被悄悄放宽）
//
// 参考实现（refOwn）用**与源码不同的算法**：对每个空点向外 BFS 找最小半径处的棋子阵营集合，
// 手工编码需求规则（最近归属 / 等距中立 / 不可达中立 / 棋子只作源点），与实现互为独立验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';

await loadKernels();
const W = World.LIFE_W; // 32

// ---------------------------------------------------------------- helpers
function seated(seed = 42, opts) {
  const w = new World('goTQ' + seed + '_' + Math.floor(Math.random() * 1e9), 1, seed,
    Object.assign({ mode: 'go' }, opts || {}));
  w._skipAIFill = true;
  w.addPlayer(1, 'Black');
  w.addPlayer(2, 'White');
  w._goInit();
  return w;
}
function clearLife(w) {
  const L = w._life;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) L[x][y] = 0;
  return L;
}
function boardOf(w, h, rows) { return { w, h, shape: rows.join('/') }; }
function rectRows(w, h, fill = '#') { const r = []; for (let y = 0; y < h; y++) r.push(fill.repeat(w)); return r; }

// 独立参考：逐空点向外 BFS，找最小半径处的棋子阵营集合。
//   恰 1 个阵营 → 归属；0 / ≥2 → 中立；不可达（被墙隔断）→ 中立。
// 返回 { own: Map<key, faction|0>, byF }。
function refOwn(w) {
  const L = w._life;
  const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const own = new Map();
  const byF = Object.create(null);
  for (let sx = 0; sx < W; sx++) {
    for (let sy = 0; sy < W; sy++) {
      if (w._isWall(sx, sy)) continue;
      if (L[sx][sy] !== 0) continue;                 // 只看空点
      const seen = new Set([sx * W + sy]);
      let ring = [[sx, sy]];
      const found = new Set();
      while (found.size === 0 && ring.length) {
        const next = [];
        for (const [cx, cy] of ring) {
          for (const [dx, dy] of NEI) {
            const nx = cx + dx, ny = cy + dy;
            if (w._isWall(nx, ny)) continue;
            const v = L[nx][ny];
            if (v !== 0) { found.add(v); continue; }  // 命中棋子，不再前进
            const k = nx * W + ny;
            if (!seen.has(k)) { seen.add(k); next.push([nx, ny]); }
          }
        }
        ring = next;
      }
      const key = sx * W + sy;
      if (found.size === 1) { const f = [...found][0]; own.set(key, f); byF[f] = (byF[f] || 0) + 1; }
      else own.set(key, 0);
    }
  }
  return { own, byF };
}
// 盘点：Map 中各阵营归属数
function ownCounts(own, B, Wf) {
  let b = 0, wt = 0, neut = 0;
  for (const v of own.values()) { if (v === B) b++; else if (v === Wf) wt++; else neut++; }
  return { b, wt, neut };
}
function implByF(w) { return w._goNearestEmpty().byF; }
function sameCounts(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
  return true;
}

const sq3 = () => boardOf(3, 3, rectRows(3, 3));
const line5 = () => boardOf(5, 1, rectRows(5, 1));

// ============================================================ QT-01 小棋盘手算
test('QT-01a 1×5 手算：B@x0 / W@x4 → 中缝 x2 等距中立（黑1 白1 中立1）', () => {
  const w = seated(9001, { board: line5() });
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[0][0] = B; L[4][0] = Wf;
  // 手算：x1→黑(1<3)、x2→等距(2=2)中立、x3→白(1<3)
  const { own, byF } = refOwn(w);
  assert.equal(own.get(1 * W + 0), B, 'x1 归黑');
  assert.equal(own.get(2 * W + 0), 0, 'x2 等距 → 中立');
  assert.equal(own.get(3 * W + 0), Wf, 'x3 归白');
  assert.ok(sameCounts(byF, { [B]: 1, [Wf]: 1 }), '参考：黑1 白1');
  assert.ok(sameCounts(implByF(w), { [B]: 1, [Wf]: 1 }), '实现：黑1 白1');
});

test('QT-01b 1×5 手算：B@x0 / W@x2 → x1 等距中立，x3/x4 归白（黑0 白2）', () => {
  const w = seated(9002, { board: line5() });
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[0][0] = B; L[2][0] = Wf;
  const { own, byF } = refOwn(w);
  assert.equal(own.get(1 * W + 0), 0, 'x1 等距(1=1) → 中立');
  assert.equal(own.get(3 * W + 0), Wf, 'x3 归白');
  assert.equal(own.get(4 * W + 0), Wf, 'x4 归白');
  assert.ok(sameCounts(byF, { [Wf]: 2 }), '参考：黑0 白2（无黑键）');
  assert.ok(sameCounts(implByF(w), { [Wf]: 2 }), '实现：黑0 白2');
});

test('QT-01c 3×3 逐空点手算：B(0,0) / W(2,2) → 2:2，3 个等距中立点', () => {
  const w = seated(9003, { board: sq3() });
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[0][0] = B; L[2][2] = Wf;
  // 手算（曼哈顿，空格内）：(1,0)/(0,1)→B；(1,2)/(2,1)→W；(1,1)/(2,0)/(0,2) 等距→中立
  const { own } = refOwn(w);
  const exp = {
    '1,0': B, '0,1': B, '1,2': Wf, '2,1': Wf,
    '1,1': 0, '2,0': 0, '0,2': 0,
  };
  for (const [xy, f] of Object.entries(exp)) {
    const [x, y] = xy.split(',').map(Number);
    assert.equal(own.get(x * W + y), f, `(${x},${y}) 期望 ${f}`);
  }
  assert.ok(sameCounts(implByF(w), { [B]: 2, [Wf]: 2 }), '实现：黑2 白2');
});

test('QT-01d 3×3 逐空点手算：B(0,0) / W(2,0) → 2:2，中立点在另一侧对称', () => {
  const w = seated(9004, { board: sq3() });
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[0][0] = B; L[2][0] = Wf;
  const { own } = refOwn(w);
  const exp = { '0,1': B, '0,2': B, '2,1': Wf, '2,2': Wf, '1,0': 0, '1,1': 0, '1,2': 0 };
  for (const [xy, f] of Object.entries(exp)) {
    const [x, y] = xy.split(',').map(Number);
    assert.equal(own.get(x * W + y), f, `(${x},${y}) 期望 ${f}`);
  }
  assert.ok(sameCounts(implByF(w), { [B]: 2, [Wf]: 2 }), '实现：黑2 白2');
});

// ============================================================ QT-02 等距中立
test('QT-02 等距中立：两子对称时中缝整列/整行不计给任一方', () => {
  const w = seated(9100);
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[0][16] = B; L[2][16] = Wf;               // 关于 x=1 对称 → x=1 整列等距
  const { own } = refOwn(w);
  for (let y = 0; y < W; y++) assert.equal(own.get(1 * W + y), 0, `x=1,y=${y} 应等距中立`);
  const c = ownCounts(own, B, Wf);
  assert.equal(c.b, 31, '黑占 x=0 列（除自身）31 格');
  assert.equal(c.neut, 32, '恰 32 个等距中立点');
  assert.ok(sameCounts(implByF(w), refOwn(w).byF), '实现与参考一致');
});

// ============================================================ QT-03 不可达中立
test('QT-03 不可达中立：虚空墙把盘面切片，无子的一侧全中立', () => {
  const rows = rectRows(32, 32).map((r) => r.slice(0, 16) + 'x' + r.slice(17)); // 第 16 列虚空
  const w = seated(9200, { board: boardOf(32, 32, rows) });
  const L = clearLife(w);
  const B = w.go.blackF;
  L[5][5] = B;                               // 只在左半放一颗黑子
  const { own } = refOwn(w);
  let rightOwned = 0;
  for (let x = 17; x < 32; x++) for (let y = 0; y < 32; y++) if (own.get(x * W + y) !== 0) rightOwned++;
  assert.equal(rightOwned, 0, '墙右（无子、不可达）必须全中立');
  assert.equal(implByF(w)[B], 16 * 32 - 1, '黑只能吸左半 511 格');
  assert.equal(Object.keys(implByF(w)).length, 1, '除黑外无任何归属');
});

// ============================================================ QT-04 墙不穿透
test('QT-04 墙不穿透：墙两侧各一子 → 各自只吸自己那侧（与无墙盘对照）', () => {
  const rows = rectRows(32, 32).map((r) => r.slice(0, 16) + 'x' + r.slice(17));
  const w = seated(9300, { board: boardOf(32, 32, rows) });
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[5][5] = B; L[26][26] = Wf;
  const byF = implByF(w);
  assert.equal(byF[B], 16 * 32 - 1, '黑 = 左半 511（不得越墙）');
  assert.equal(byF[Wf], 15 * 32 - 1, '白 = 右半 479（不得越墙）');
  assert.ok(sameCounts(byF, refOwn(w).byF), '实现与参考一致');

  // 对照：同两子放在**无墙**盘 → 归属随距离切分，与有墙盘显著不同（证明墙确有阻断作用）。
  const w2 = seated(9301);
  const L2 = clearLife(w2);
  L2[5][5] = w2.go.blackF; L2[26][26] = w2.go.whiteF;
  const byF2 = implByF(w2);
  assert.notDeepEqual(byF2, byF, '有墙 / 无墙结果必须不同');
  assert.ok(Math.abs(byF2[w2.go.blackF] - (16 * 32 - 1)) > 10, '无墙盘黑吸到的格数应明显不同于有墙盘');
});

// ============================================================ QT-05 散点成效 + 旧口径对照
test('QT-05 散点：就近归属双方各占地盘 > 0；旧「严格围空」口径同盘为 0（改造证据）', () => {
  const w = seated(9400);
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  for (let x = 3; x <= 12; x += 3) for (let y = 3; y <= 27; y += 4) L[x][y] = B;   // 左半黑散点
  for (let x = 18; x <= 27; x += 3) for (let y = 3; y <= 27; y += 4) L[x][y] = Wf; // 右半白散点

  const neu = implByF(w);
  const old = w._goEnclosedEmpty().byF;
  assert.ok(neu[B] > 0, '新口径黑地盘 > 0');
  assert.ok(neu[Wf] > 0, '新口径白地盘 > 0');
  assert.equal(old[B] || 0, 0, '旧口径黑围空 = 0');
  assert.equal(old[Wf] || 0, 0, '旧口径白围空 = 0');
  assert.ok(sameCounts(neu, refOwn(w).byF), '实现与参考一致');

  // 数子：byF = 子数 + 空地，且 emptyByF 与 _goNearestEmpty 完全一致。
  const sc = w._goScoreChinese();
  assert.equal(sc.byF[B], sc.stoneByF[B] + sc.emptyByF[B]);
  assert.equal(sc.byF[Wf], sc.stoneByF[Wf] + sc.emptyByF[Wf]);
  assert.ok(sameCounts(sc.emptyByF, neu), '_goScoreChinese 的空地口径 = _goNearestEmpty');
  assert.equal(sc.black, sc.byF[B]);
  assert.equal(sc.white, sc.byF[Wf]);
});

// ============================================================ QT-06 红线性质
test('QT-06a 空盘：无源 → 全中立 → 0:0 平局（winner=null，无 komi）', () => {
  const w = seated(9500);
  clearLife(w);
  assert.deepEqual(Object.keys(implByF(w)), [], '空盘无任何归属');
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.blackScore, 0);
  assert.equal(w.go.result.whiteScore, 0);
  assert.equal(w.go.result.winner, null, '0:0 → 平局');
});

test('QT-06b 180° 旋转对称盘 → 双方数子严格相等；平局（无 komi）', () => {
  const w = seated(9501);
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[3][3] = B; L[4][3] = B; L[3][4] = B; L[4][4] = B;                       // 黑 2×2 于左上
  L[28][28] = Wf; L[27][28] = Wf; L[28][27] = Wf; L[27][27] = Wf;           // 白 2×2 于右下（180° 对称）
  const sc = w._goScoreChinese();
  assert.equal(sc.black, sc.white, '对称盘面等分');
  assert.equal(w._goNearestEmpty().byF[B], 480);
  assert.equal(w._goNearestEmpty().byF[Wf], 480);
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.winner, null, '等分 → 平局（黑先不加分）');
});

test('QT-06c 被吃光方恒 0 分、不出局：不反超，胜负由数子决定', () => {
  const w = seated(9502);
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[20][20] = Wf; L[21][20] = Wf; L[20][21] = Wf; L[21][21] = Wf;
  const pB = w.players[w.go.blackId];
  pB.maxLifeCells = 6; pB.lifeCells = 0;                                     // 黑曾被吃光
  const sc = w._goScoreChinese();
  assert.equal(sc.stoneByF[B] || 0, 0);
  assert.equal(sc.emptyByF[B] || 0, 0, '被吃光方无子 → 无源 → 0 地盘');
  assert.equal(sc.byF[B] || 0, 0);
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result, null, '被吃光不触发终局');
  assert.equal(pB.lost, false, '被吃光方不出局');
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.reason, 'pass');
  assert.equal(w.go.result.winner, w.go.whiteId);
  assert.equal(w.players[w.go.blackId].won, false, '被吃光方绝不判胜');
});

test('QT-06d winReason 仍为 go（胜负口径变更不改 winReason 契约）', () => {
  const w = seated(9503);
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[16][16] = B; L[16][17] = B; L[17][16] = B;   // 黑 3 子居中、白 0 子 → 黑胜
  void Wf;
  const ev = [];
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  w.applyGoIntent(w.go.seats[w.go.turnIdx], { pass: true }, ev);
  assert.equal(w.go.result.winner, w.go.blackId);
  assert.equal(w.players[w.go.blackId].winReason, 'go', 'winReason 仍为 go');
});

// ============================================================ QT-07 未改动契约
test('QT-07 _goScore（Voronoi）与 _goFinish 胜负池逻辑未被本次改动触及', () => {
  const w = seated(9600);
  const L = clearLife(w);
  const B = w.go.blackF, Wf = w.go.whiteF;
  L[5][5] = B; L[25][25] = Wf;
  // _goScore 仍是 Voronoi 目数口径（与 _goScoreChinese 的「就近数子」结果不同）。
  const vor = w._goScore();
  const ch = w._goScoreChinese();
  assert.equal(typeof vor.black, 'number');
  assert.ok(vor.byF && typeof vor.byF === 'object', '_goScore 仍返回 Voronoi 结构');
  assert.notDeepEqual(
    { black: vor.black, white: vor.white },
    { black: ch.black, white: ch.white },
    '_goScore（Voronoi）与 _goScoreChinese（就近数子）必须是两条不同口径',
  );
  // 源码守卫：_goFinish 的胜负池过滤行仍在（剔除认输方；被吃光不出局，不再需要 wiped 特殊分支）。
  const src = readFileSync(new URL('../server/go.js', import.meta.url), 'utf8');
  assert.ok(
    /filter\(r\s*=>\s*!r\.lost\)/.test(src),
    '_goFinish 胜负池过滤（剔除认输 lost 方）逻辑应存在',
  );
  assert.ok(/P\._goScore\s*=\s*function/.test(src), '_goScore 定义应存在');
  assert.ok(/P\._goFinish\s*=\s*function/.test(src), '_goFinish 定义应存在');
});

// ============================================================ QT-08 确定性
test('QT-08 确定性：同盘重复调用一致 + 另一世界同盘一致；go.js 无 Math.random / Date.now', () => {
  const build = (w) => {
    const L = clearLife(w);
    for (let x = 3; x <= 18; x += 3) for (let y = 3; y <= 18; y += 3) L[x][y] = w.go.blackF;
    L[0][0] = w.go.whiteF; L[1][0] = w.go.whiteF;
  };
  const w = seated(9700); build(w);
  const a = implByF(w), b = implByF(w), c = implByF(w);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  const w2 = seated(9700); build(w2);
  assert.deepEqual(implByF(w2), a, '同盘两世界结果一致（纯函数、无隐藏状态）');

  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const src = strip(readFileSync(new URL('../server/go.js', import.meta.url), 'utf8'));
  assert.ok(!/Math\.random\s*\(/.test(src), 'server/go.js 不得含 Math.random()');
  assert.ok(!/Date\.now\s*\(/.test(src), 'server/go.js 不得含 Date.now()');
});

// ============================================================ QT-09 已知断言锁（独立重算）
test('QT-09 被改动过的既有断言的精确值 —— 独立重算锁定（防悄然放宽）', () => {
  // 以下每一组数字独立由本文件 refOwn 重算得出，锁定「被改动的既有断言」的精确口径。
  const cases = [
    {
      name: 'QA-05#1 7B(含围)+2W', seed: 501,
      setup: (w, L) => {
        const B = w.go.blackF, Wf = w.go.whiteF;
        L[4][5] = B; L[6][5] = B; L[5][4] = B; L[5][6] = B;
        L[1][1] = B; L[30][30] = B; L[16][16] = B;
        L[20][20] = Wf; L[21][20] = Wf;
      },
      exp: { B: 541, W: 254 },
    },
    {
      name: 'QA-05#2 对角(10,10)B/(11,11)W', seed: 502,
      setup: (w, L) => { L[10][10] = w.go.blackF; L[11][11] = w.go.whiteF; },
      exp: { B: 120, W: 440 },
    },
    {
      name: 'QA-12 散点 30B/30W', seed: 1202,
      setup: (w, L) => {
        const B = w.go.blackF, Wf = w.go.whiteF;
        for (let y = 2; y < 30; y += 3) { L[5][y] = B; L[8][y] = B; L[11][y] = B; }
        for (let y = 2; y < 30; y += 3) { L[21][y] = Wf; L[24][y] = Wf; L[27][y] = Wf; }
      },
      exp: { B: 482, W: 450 },
    },
    {
      name: 'VC-10#1 6B(含围)+1W(15,15)', seed: 1,
      setup: (w, L) => {
        const B = w.go.blackF, Wf = w.go.whiteF;
        L[3][3] = 0; L[2][3] = B; L[4][3] = B; L[3][2] = B; L[3][4] = B;
        L[10][10] = B; L[20][20] = B; L[15][15] = Wf;
      },
      exp: { B: 591, W: 60 },
    },
    {
      name: 'VC-10#2 (5,5)B/(25,25)W', seed: 2,
      setup: (w, L) => { L[5][5] = w.go.blackF; L[25][25] = w.go.whiteF; },
      exp: { B: 434, W: 485 },
    },
    {
      name: 'VC-10#3 16B(中心)/2W(角)', seed: 3,
      setup: (w, L) => {
        const B = w.go.blackF, Wf = w.go.whiteF;
        for (let x = 14; x <= 17; x++) for (let y = 14; y <= 17; y++) L[x][y] = B;
        L[0][0] = Wf; L[1][0] = Wf;
      },
      exp: { B: 887, W: 117 },
    },
    {
      name: 'VC-10#4 对称 2×2(3,3)/(28,28)', seed: 4,
      setup: (w, L) => {
        const B = w.go.blackF, Wf = w.go.whiteF;
        L[3][3] = B; L[4][3] = B; L[3][4] = B; L[4][4] = B;
        L[28][28] = Wf; L[27][28] = Wf; L[28][27] = Wf; L[27][27] = Wf;
      },
      exp: { B: 480, W: 480 },
    },
    {
      name: 'VC-10#5 snapshot 4B(含围)+1W(0,0)', seed: 5,
      setup: (w, L) => {
        const B = w.go.blackF, Wf = w.go.whiteF;
        L[3][3] = 0; L[2][3] = B; L[4][3] = B; L[3][2] = B; L[3][4] = B; L[0][0] = Wf;
      },
      exp: { B: 1014, W: 5 },
    },
  ];
  for (const c of cases) {
    const w = seated(c.seed);
    const L = clearLife(w);
    c.setup(w, L);
    const B = w.go.blackF, Wf = w.go.whiteF;
    const ref = refOwn(w).byF;
    const impl = implByF(w);
    assert.equal(ref[B] || 0, c.exp.B, `${c.name}: 参考黑=${c.exp.B}`);
    assert.equal(ref[Wf] || 0, c.exp.W, `${c.name}: 参考白=${c.exp.W}`);
    assert.equal(impl[B] || 0, c.exp.B, `${c.name}: 实现黑=${c.exp.B}`);
    assert.equal(impl[Wf] || 0, c.exp.W, `${c.name}: 实现白=${c.exp.W}`);
  }
});

// ============================================================ QT-10 随机对照（实现 vs 独立参考）
test('QT-10 随机盘面 150 例：实现 _goNearestEmpty 与独立参考逐阵营计数完全一致', () => {
  let s = 20250915 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let t = 0; t < 150; t++) {
    const w = seated(9800 + t);
    const L = clearLife(w);
    const n = 1 + Math.floor(rnd() * 44);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rnd() * W), y = Math.floor(rnd() * W);
      L[x][y] = 1 + Math.floor(rnd() * 2);   // 黑 / 白
    }
    assert.ok(sameCounts(implByF(w), refOwn(w).byF),
      `随机盘面 #${t} 实现与参考不一致：impl=${JSON.stringify(implByF(w))} ref=${JSON.stringify(refOwn(w).byF)}`);
  }
});
