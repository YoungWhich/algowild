// tests/gomoku.qa2.test.mjs — 独立回归：修复 #1（gomoku 平局判定改真缺陷）+ 围棋无满盘终局
//
// 由 QA（Edward）编写，与工程师 tests/gomoku.test.mjs 的 GK-17/18/19 采用**不同**形状与构造，
// 独立证明：
//   · 非矩形盘（编辑器挖出的墙格=3）：只要还有「非墙空点」就不判平局（即便 moveNo 被人为抬到 size²）。
//   · 所有非墙格占满 → 判 draw。
//   · 15×15（board=null）：仅剩 1 空点不判平局；占满 225 → 平局（与旧行为等价）。
//   · 围棋（weiqi）**没有**"满盘即终局"判定：填满棋盘不自动终局，仍需双 pass / 认输。
//   · IR-3a：两模式源码（去注释后）无 Math.random / Date.now；gomoku 不再有 `moveNo >= size` 旧判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from '../server/engine.js';

const WALL = 99;                // 容器内墙哨兵（形状外/虚空）——与 World.GOMOKU_WALL / WEIQI_WALL 一致（落在阵营号 1..8 之外）
const wall = WALL;

// 形状串（与 server 端 SHAPE_CHARS 一致）：'#'=可落子 '.'=形状外 'x'=虚空。
// SHAPE_D：4×4，仅 8 个可落格（四角 + 每边中点的邻格），中间 2×2 为虚空 → 任意方向最长 4 连（**五连不可能**）。
//   行0 '#..#'  行1 '#xx#'  行2 '#xx#'  行3 '#..#'
const SHAPE_D = '#..#/#xx#/#xx#/#..#';   // w=4 h=4，size(容器)=4，size²=16，可落 8，墙 8
// SHAPE_A：3×3，中心虚空 → 可落 8，size=3，size²=9（五连不可能）。
const SHAPE_A = '###/#x#/###';

/** 建一个已就座（黑=pid1 先手）的模式世界。board=null → 默认矩形（无墙）。 */
function world(mode, board, seed) {
  const w = new World(`qa2_${mode}_${seed}`, 1, seed, board ? { mode, board } : { mode });
  w._skipAIFill = true;
  w.addPlayer(1, 'B');
  w.addPlayer(2, 'W');
  return w;
}

// ---------- QA 自带独立工具（不复用被实现的私有函数） ----------

/** 容器内可落子（非墙）格的下标集合。 */
function playable(g) {
  const out = [];
  for (let i = 0; i < g.board.length; i++) if (g.board[i] !== wall) out.push(i);
  return out;
}
/** 容器内空点（0）计数。 */
function empties(g) {
  let n = 0;
  for (const v of g.board) if (v === 0) n++;
  return n;
}
/** 容器内墙格（99）计数。 */
function walls(g) {
  let n = 0;
  for (const v of g.board) if (v === wall) n++;
  return n;
}
/** 独立五连扫描器：容器内是否已存在任意 ≥5 连（墙（99）天然隔断）。 */
function hasFive(g) {
  const size = g.size, b = g.board;
  const D = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const f = b[y * size + x];
      if (f !== 1 && f !== 2) continue;
      for (const [dx, dy] of D) {
        let n = 1, cx = x + dx, cy = y + dy;
        while (cx >= 0 && cy >= 0 && cx < size && cy < size && b[cy * size + cx] === f) { n++; cx += dx; cy += dy; }
        if (n >= 5) return true;
      }
    }
  }
  return false;
}
/** 两个人类席位先后落子的 pid 序列（黑先）。 */
function seqPid(i) { return (i % 2 === 0) ? 1 : 2; }
/** 去掉 JS 注释（IR-3a 严格检测用）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// ---------- A. 非矩形盘：_gomokuNoEmpty 的语义 ----------

test('Q2-GK-01 形状盘结构 + 空点扫描：8 可落 / 8 墙；填满可落格后 NoEmpty 翻转', () => {
  const w = world('gomoku', { w: 4, h: 4, shape: SHAPE_D }, 11);
  const g = w._gomokuInit();
  assert.equal(g.size, 4, '容器尺寸 = max(cfg.w,cfg.h) = 4');
  assert.equal(g.board.length, 16);
  assert.equal(walls(g), 8, '4×4 中 8 格为墙（虚空 + 形状外）');
  assert.equal(playable(g).length, 8);
  assert.equal(empties(g), 8);
  assert.equal(w._gomokuNoEmpty(), false, '初始有可落空点 → 非满盘');
  // 逐格核对墙/可落语义（独立于实现）
  assert.equal(g.board[0], 0, '(0,0) 可落、初始为空');
  assert.equal(g.board[1], wall, '(1,0) 形状外 → 墙');
  assert.equal(g.board[5], wall, '(1,1) 虚空 → 墙');
  // 填满所有非墙格
  for (const i of playable(g)) g.board[i] = (i % 2) ? 1 : 2;
  assert.equal(empties(g), 0);
  assert.equal(w._gomokuNoEmpty(), true, '所有非墙格占满 → NoEmpty=true');
  assert.equal(hasFive(g), false, 'QA 独立扫描：该图案无 ≥5 连');
});

test('Q2-GK-02 误判点：moveNo 人为抬到 size²（16）但仍有非墙空点 → 不判平局', () => {
  const w = world('gomoku', { w: 4, h: 4, shape: SHAPE_D }, 12);
  const g = w._gomokuInit();
  const cells = playable(g);                 // [0,3,4,7,8,11,12,15]
  const keep = new Set([cells[0], cells[1]]); // 留 2 个非墙空点
  for (const i of cells) if (!keep.has(i)) g.board[i] = (i % 2) ? 1 : 2;
  g.moveNo = 16;                             // 旧判定 `moveNo >= size²` 在此必判平局（误判点）
  assert.equal(empties(g), 2);
  assert.equal(w._gomokuNoEmpty(), false);
  const r = w.applyGomokuIntent(1, { lx: cells[0] % 4, ly: (cells[0] / 4) | 0 }, []);
  assert.equal(r.ok, true);
  assert.equal(r.draw, undefined, '尚剩非墙空点 → 不得判平局');
  assert.equal(g.result, null);
  assert.equal(empties(g), 1, '落子后仍剩 1 个非墙空点');
  assert.equal(w._gomokuNoEmpty(), false);
  assert.equal(hasFive(g), false);
});

test('Q2-GK-03 所有非墙格占满 → 判 draw（即便 moveNo 已 ≥ size²）', () => {
  const w = world('gomoku', { w: 4, h: 4, shape: SHAPE_D }, 13);
  const g = w._gomokuInit();
  const cells = playable(g);
  const last = cells[cells.length - 1];       // 15 → (3,3)
  for (const i of cells) if (i !== last) g.board[i] = (i % 2) ? 1 : 2;
  g.moveNo = 16;
  assert.equal(empties(g), 1);
  assert.equal(w._gomokuNoEmpty(), false);
  const r = w.applyGomokuIntent(1, { lx: last % 4, ly: (last / 4) | 0 }, []);
  assert.equal(r.draw, true, '所有非墙格占满 → 平局');
  assert.equal(g.result.reason, 'draw');
  assert.equal(g.result.winner, null);
  assert.equal(empties(g), 0);
  assert.equal(w._gomokuNoEmpty(), true);
  assert.equal(hasFive(g), false);
});

test('Q2-GK-04 自然对局：形状盘（8 可落、五连不可能）走满 → 第 8 手平局（旧逻辑永不触发）', () => {
  const w = world('gomoku', { w: 4, h: 4, shape: SHAPE_D }, 14);
  const g = w._gomokuInit();
  const cells = playable(g);
  assert.equal(cells.length, 8);
  let last = null;
  for (let i = 0; i < cells.length; i++) {
    const x = cells[i] % 4, y = (cells[i] / 4) | 0;
    last = w.applyGomokuIntent(seqPid(i), { lx: x, ly: y }, []);
    assert.equal(last.ok, true, `第 ${i + 1} 手应成功`);
    assert.equal(last.win, undefined, '该形状最长 4 连，不可能五连');
  }
  assert.equal(last.draw, true, '填满全部可落格 → 平局（旧 `moveNo>=size²` 逻辑在 8 手时永不触发）');
  assert.equal(g.moveNo, 8);
  assert.equal(g.result.reason, 'draw');
  assert.equal(w._gomokuNoEmpty(), true);
});

test('Q2-GK-05 更小形状盘（3×3 中心虚空）同语义：留 1 空不判、占满判平', () => {
  const w = world('gomoku', { w: 3, h: 3, shape: SHAPE_A }, 15);
  const g = w._gomokuInit();
  assert.equal(g.size, 3);
  assert.equal(walls(g), 1, '仅中心虚空 1 格为墙');
  assert.equal(playable(g).length, 8);
  // 留 2 空、moveNo=9 → 不判平
  const cells = playable(g);
  for (const i of cells) if (i !== cells[0] && i !== cells[1]) g.board[i] = (i % 2) ? 1 : 2;
  g.moveNo = 9;
  let r = w.applyGomokuIntent(1, { lx: cells[0] % 3, ly: (cells[0] / 3) | 0 }, []);
  assert.equal(r.draw, undefined);
  assert.equal(g.result, null);
  // 再补最后一格 → 占满 → 平
  r = w.applyGomokuIntent(seqPid(1), { lx: cells[1] % 3, ly: (cells[1] / 3) | 0 }, []);
  assert.equal(r.ok, true);
  assert.equal(r.draw, true);
  assert.equal(g.result.reason, 'draw');
  assert.equal(w._gomokuNoEmpty(), true);
});

// ---------- B. 15×15 回归（board=null 逐字节等价旧行为） ----------

test('Q2-GK-06 board=null：无墙；仅剩 1 空点不判平，占满 225 → 平局', () => {
  const SIZE = 15;
  const w = world('gomoku', null, 16);
  const g = w._gomokuInit();
  assert.equal(g.size, SIZE);
  assert.equal(walls(g), 0, 'board=null → 容器内不得有墙');
  assert.equal(empties(g), SIZE * SIZE);
  assert.equal(w._gomokuNoEmpty(), false);
  // 自造无五连的周期图案（QA 版）：((3x+2y)%4)<2 —— 各方向最长连续 ≤2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x === 0 && y === 0) continue;            // 留 (0,0) 作最后一手
      g.board[y * SIZE + x] = ((3 * x + 2 * y) % 4) < 2 ? 1 : 2;
    }
  }
  assert.equal(hasFive(g), false, 'QA 独立扫描：图案无 ≥5 连');
  g.moveNo = SIZE * SIZE - 1;                      // 224
  assert.equal(empties(g), 1);
  assert.equal(w._gomokuNoEmpty(), false, '还剩 1 空点 → 不应判满盘');
  const r = w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []);
  assert.equal(r.draw, true, '占满 225 格 → 平局（等价旧 `moveNo >= size²`）');
  assert.equal(g.moveNo, SIZE * SIZE);
  assert.equal(g.result.reason, 'draw');
  assert.equal(empties(g), 0);
  assert.equal(w._gomokuNoEmpty(), true);
});

test('Q2-GK-07 等价性：board=null 时 _gomokuNoEmpty() ≡「容器无 0」≡「占满 225」', () => {
  const SIZE = 15;
  const w = world('gomoku', null, 17);
  const g = w._gomokuInit();
  // 逐级填充，断言扫描器与"无空点"、"已满 225"三者始终一致
  let filled = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const noEmpty = (empties(g) === 0);
      assert.equal(w._gomokuNoEmpty(), noEmpty, `filled=${filled} 时扫描结果应与"无空点"一致`);
      g.board[y * SIZE + x] = (x + y) % 2 ? 1 : 2;
      filled++;
    }
  }
  assert.equal(filled, SIZE * SIZE);
  assert.equal(w._gomokuNoEmpty(), true);
  assert.equal(empties(g), 0);
});

// ---------- C. 围棋：没有"满盘即终局"判定 ----------

test('Q2-WQ-01 weiqi 19×19：填满整盘不自动终局，仍需双 pass', () => {
  const w = world('weiqi', null, 21);
  const g = w._weiqiInit();
  assert.equal(g.size, 19);
  for (let i = 0; i < g.board.length; i++) g.board[i] = (i % 2) ? 1 : 2;   // 填满 361
  assert.equal(w.weiqi.result, null, '围棋无"满盘平局"：填满不得自动终局');
  assert.equal(w.applyWeiqiIntent(1, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result, null, '单方 pass 不终局');
  assert.equal(w.applyWeiqiIntent(2, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result.reason, 'pass', '双 pass 才终局（中国规则数子）');
});

test('Q2-WQ-02 weiqi 形状盘（8 可落 / 8 墙）：填满可落格不终局，仍需双 pass', () => {
  const w = world('weiqi', { w: 4, h: 4, shape: SHAPE_D }, 22);
  const g = w._weiqiInit();
  assert.equal(g.size, 4);
  assert.equal(walls(g), 8);
  for (let i = 0; i < g.board.length; i++) if (g.board[i] !== wall) g.board[i] = (i % 2) ? 1 : 2;
  assert.equal(w.weiqi.result, null, '形状盘填满亦不自动终局');
  assert.equal(w.applyWeiqiIntent(1, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result, null);
  assert.equal(w.applyWeiqiIntent(2, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result.reason, 'pass');
});

test('Q2-WQ-03 weiqi 源码静态钉扎：无满盘/平局判定，终局原因仅 pass/resign', () => {
  const code = stripComments(readFileSync('server/modes/weiqi.js', 'utf8'));
  assert.ok(!/_weiqiNoEmpty/.test(code), 'weiqi 不应有满盘空点扫描');
  assert.ok(!/['"]draw['"]/.test(code), 'weiqi 不应有 draw 终局原因');
  assert.ok(!/moveNo\s*>=/.test(code), 'weiqi 不应有 moveNo >= size² 类满盘判定');
  // 终局入口只有 pass / resign 两种
  assert.ok(/_weiqiFinish\(\s*['"]pass['"]/.test(code), '应存在 _weiqiFinish(`pass`)');
  assert.ok(/_weiqiFinish\(\s*['"]resign['"]/.test(code), '应存在 _weiqiFinish(`resign`)');
});

// ---------- D. 确定性 / IR-3a ----------

test('Q2-DET-01 IR-3a：gomoku/weiqi 去注释后无 Math.random / Date.now', () => {
  for (const f of ['server/modes/gomoku.js', 'server/modes/weiqi.js']) {
    const code = stripComments(readFileSync(f, 'utf8'));
    assert.ok(!/Math\s*\.\s*random/.test(code), `${f} 代码不得含 Math.random`);
    assert.ok(!/Date\s*\.\s*now/.test(code), `${f} 代码不得含 Date.now`);
  }
});

test('Q2-DET-02 gomoku 已移除旧 `moveNo >= size²` 判定，改用容器扫描 _gomokuNoEmpty', () => {
  const raw = readFileSync('server/modes/gomoku.js', 'utf8');
  const code = stripComments(raw);
  assert.ok(/_gomokuNoEmpty\s*\(/.test(code), '应存在 _gomokuNoEmpty 扫描助手');
  assert.ok(/if\s*\(\s*this\._gomokuNoEmpty\(\)\s*\)/.test(code), '平局判定应调用 _gomokuNoEmpty()');
  assert.ok(!/moveNo\s*>=/.test(code), '不应再残留 moveNo >= size² 旧判定');
});
