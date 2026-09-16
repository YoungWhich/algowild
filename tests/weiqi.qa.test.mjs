// tests/weiqi.qa.test.mjs — 标准围棋（weiqi）**独立** QA 套件（QA Edward 编写）
//
// 目的：用与工程师 tests/weiqi.test.mjs **不同**的构造与断言，独立复核规则/契约/隔离性/确定性。
//
// 覆盖（超出工程师用例的部分）：
//   · 角上单子提子；"无气但提对方"仍合法（提 4 子）；禁自杀（角上变体）
//   · 劫：单子提且自身 1 气才成劫；1 子提但自身 ≥2 气不成劫；提 2 子不成劫；隔一手回提成功
//   · 双 pass 终局 + 手算中国规则数子（4×4 边框 → 内 4 空点归黑）；中性空区不计地；贴目精确 x.5
//   · **无演化**：任何棋形（含"康威会变"的三连 + 孤子）在 tick/intervalStep 后棋盘逐格不变
//   · pass 清零连续计数 / 解除劫；认输压过分数；越界/占位/非本回合/未就座/非法格式
//   · routeIntent 三态 + 拒子事件；快照固定 `.go` 键可序列化；rts 的 `.go` 为 null
//   · 独立实现的数子函数与实现交叉验证；注册表元数据；跨模式隔离；主干 seam；IR-3a；确定性
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';
import weiqiDef from '../server/modes/weiqi.js';
import gomokuDef from '../server/modes/gomoku.js';
import { getMode, normalizeMode, boardMaxForMode, availableVictoryLinesForMode, listModes } from '../server/modes/index.js';

await loadKernels();

const SIZE = 19;
const KOMI = 7.5;
const IX = (x, y) => y * SIZE + x;

function seated(seed = 11) {
  const w = new World('weiqi_qa_' + seed, 1, seed, { mode: 'weiqi' });
  w._skipAIFill = true;
  w.addPlayer(1, 'B');
  w.addPlayer(2, 'W');
  w._weiqiInit();
  return w;
}
function put(w, x, y, f) { w.weiqi.board[IX(x, y)] = f; }
function stones(board) { let n = 0; for (const v of board) if (v) n++; return n; }

/** 剥离 JS 注释（IR-3a 检测需排除注释里对 Math.random 的文档性提及）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 独立实现的中国规则数子（与被实现结构不同：显式队列 BFS）。 */
function qaArea(board, size, komi) {
  let bs = 0, ws = 0;
  for (let k = 0; k < board.length; k++) { if (board[k] === 1) bs++; else if (board[k] === 2) ws++; }
  const seen = new Uint8Array(size * size);
  let bt = 0, wt = 0;
  for (let start = 0; start < board.length; start++) {
    if (board[start] !== 0 || seen[start]) continue;
    const q = [start]; seen[start] = 1;
    let cnt = 0, tb = false, tw = false;
    for (let h = 0; h < q.length; h++) {
      const k = q[h]; cnt++;
      const x = k % size, y = (k / size) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nk = ny * size + nx, v = board[nk];
        if (v === 0) { if (!seen[nk]) { seen[nk] = 1; q.push(nk); } }
        else if (v === 1) tb = true; else if (v === 2) tw = true;
      }
    }
    if (tb && !tw) bt += cnt; else if (tw && !tb) wt += cnt;
  }
  return { blackStones: bs, whiteStones: ws, blackTerr: bt, whiteTerr: wt, black: bs + bt, white: ws + wt + komi, komi };
}

/** 复现主干 1Hz interval 循环体（net.js / index.js）。 */
function intervalLoopStep(w) {
  if (w._mode.tickDriver !== 'interval') return { skipped: 'driver' };
  if (Object.keys(w.players).length === 0) return { skipped: 'no-players' };
  if (w.paused) return { skipped: 'paused' };
  const events = [];
  const step = w._mode.intervalStep || w._mode.tick;
  if (!step) return { skipped: 'no-step' };
  const r = step(w, events);
  return { changed: !(r && r.changed === false), events };
}

// ---------- A. 提子 / 禁自杀 / 劫 ----------

test('WQA-01 角上单子提子（仅 2 气）', () => {
  const w = seated();
  put(w, 0, 0, 2);                 // 白角子
  put(w, 0, 1, 1);                 // 黑封一面
  const r = w._weiqiPlay(1, 1, 0, []);   // 黑封另一面 → 提
  assert.equal(r.ok, true);
  assert.equal(r.captured, 1);
  assert.equal(w.weiqi.board[IX(0, 0)], 0);
});

test('WQA-02 「无气但提对方」仍合法：黑入眼提 4 白子', () => {
  const w = seated();
  // 4 颗孤立白子各自只剩 (1,1) 一气；黑用外圈子占满其余邻点
  put(w, 0, 1, 2); put(w, 2, 1, 2); put(w, 1, 0, 2); put(w, 1, 2, 2);
  for (const [x, y] of [[0, 0], [0, 2], [2, 0], [2, 2], [3, 1], [1, 3]]) put(w, x, y, 1);
  assert.equal(w.weiqi.board[IX(1, 1)], 0);
  const r = w._weiqiPlay(1, 1, 1, []);   // 黑入 (1,1)：自身无气，但提净 4 白子 → 合法
  assert.equal(r.ok, true, '提子手即使自身无气也必须合法');
  assert.equal(r.captured, 4);
  assert.equal(w.weiqi.board[IX(1, 1)], 1);
  for (const [x, y] of [[0, 1], [2, 1], [1, 0], [1, 2]]) assert.equal(w.weiqi.board[IX(x, y)], 0, '4 白子应被提净');
});

test('WQA-03 禁自杀（角上变体）：无气且不提子 → suicide，棋盘不变', () => {
  const w = seated();
  put(w, 1, 0, 2); put(w, 0, 1, 2);
  const before = Array.from(w.weiqi.board);
  const r = w._weiqiPlay(1, 0, 0, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'suicide');
  assert.deepEqual(Array.from(w.weiqi.board), before, '自杀手必须整体回滚');
});

test('WQA-04 劫条件收敛：1 子提但自身 ≥2 气不成劫；提 2 子不成劫', () => {
  const w = seated();
  // (a) 提单子，但落子后自身有 3 气 → 不记劫
  put(w, 5, 5, 2); put(w, 4, 5, 1); put(w, 5, 4, 1); put(w, 5, 6, 1);
  const a = w._weiqiPlay(1, 6, 5, []);
  assert.equal(a.captured, 1);
  assert.equal(w.weiqi.ko, null, '自身 ≥2 气不应成劫');
  // (b) 提 2 子 → 不记劫
  const w2 = seated();
  put(w2, 5, 5, 2); put(w2, 5, 6, 2);
  for (const [x, y] of [[4, 5], [6, 5], [4, 6], [6, 6], [5, 4]]) put(w2, x, y, 1);
  const b = w2._weiqiPlay(1, 5, 7, []);
  assert.equal(b.captured, 2);
  assert.equal(w2.weiqi.ko, null, '提 2 子不应成劫');
});

test('WQA-05 劫完整流程：成劫 → 立即回提被拒 → 隔一手回提成功', () => {
  const w = seated();
  // 标准劫形（围绕 (10,10)）：黑/白交错，黑提白单子后自身仅剩 1 气 → 成劫
  put(w, 10, 10, 2);
  put(w, 9, 10, 1); put(w, 10, 9, 1); put(w, 10, 11, 1);
  put(w, 12, 10, 2); put(w, 11, 9, 2); put(w, 11, 11, 2);
  const r1 = w._weiqiPlay(1, 11, 10, []);          // 黑提白 (10,10)
  assert.equal(r1.ok, true);
  assert.equal(r1.captured, 1);
  assert.deepEqual(w.weiqi.ko, { x: 10, y: 10 }, '劫禁着应是被提点');
  const r2 = w._weiqiPlay(2, 10, 10, []);          // 白立即回提
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'ko');
  assert.equal(w.weiqi.board[IX(10, 10)], 0, '被拒不得改变棋盘');
  // 隔一手（双方各在他处应一手）后可回提
  assert.equal(w._weiqiPlay(2, 0, 0, []).ok, true);
  assert.equal(w.weiqi.ko, null, '任何一手落子后劫即解除');
  assert.equal(w._weiqiPlay(1, 1, 0, []).ok, true);
  const r5 = w._weiqiPlay(2, 10, 10, []);          // 回提（提掉黑 (11,10)）
  assert.equal(r5.ok, true, '隔一手后回提应被允许');
  assert.equal(r5.captured, 1);
});

// ---------- A. 双 pass / 中国规则数子 + 贴目 ----------

test('WQA-06 双 pass 终局 + 手算数子（4×4 边框）：黑 12 子 + 内 4 空 = 16；白 1 子 + 7.5 = 8.5', () => {
  const w = seated();
  const frame = [];
  for (let i = 0; i <= 3; i++) { frame.push([i, 0], [i, 3], [0, i], [3, i]); }
  for (const [x, y] of frame) put(w, x, y, 1);
  put(w, 10, 10, 2);
  assert.equal(w.applyWeiqiIntent(1, { pass: true }, []).pass, true);
  assert.equal(w.weiqi.result, null, '仅一方 pass 不终局');
  assert.equal(w.applyWeiqiIntent(2, { pass: true }, []).pass, true);
  const res = w.weiqi.result;
  assert.equal(res.reason, 'pass');
  assert.equal(res.blackStones, 12);
  assert.equal(res.blackTerr, 4, '被黑唯一围住的 2×2 内空点归黑');
  assert.equal(res.whiteTerr, 0, '盘外空区同时接触黑白 → 中立');
  assert.equal(res.black, 16);
  assert.equal(res.white, 8.5);
  assert.equal(res.komi, KOMI);
  assert.equal(res.winner, 1);
});

test('WQA-07 数子交叉验证：QA 独立实现 == 实现；孤子局面空区中立；贴目恒为 x.5', () => {
  const w = seated();
  put(w, 0, 0, 1); put(w, 18, 18, 2); put(w, 9, 9, 1);
  const mine = qaArea(w.weiqi.board, SIZE, KOMI);
  const sc = w._weiqiScore();
  for (const k of ['blackStones', 'whiteStones', 'blackTerr', 'whiteTerr', 'black', 'white']) {
    assert.equal(sc[k], mine[k], `数子字段 ${k} 应与独立实现一致`);
  }
  assert.equal(sc.blackTerr, 0, '盘外空区接触黑白双方 → 双方皆无地');
  assert.equal(sc.whiteTerr, 0);
  assert.equal(sc.white, 1 + KOMI);
  assert.equal(Number.isInteger(sc.white), false, '带贴目后白分恒含 .5');
  assert.equal(sc.winnerF, 2, '白靠贴目领先');
});

test('WQA-08 手算数子（双色各自围空）：黑 8+1=9，白 8+1+7.5=16.5', () => {
  const w = seated();
  // 黑围 (1,1)：黑 3×3 边框
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) put(w, x, y, 1);
  // 白围 (5,5)：白 3×3 边框
  for (const [x, y] of [[4, 4], [5, 4], [6, 4], [4, 5], [6, 5], [4, 6], [5, 6], [6, 6]]) put(w, x, y, 2);
  const sc = w._weiqiScore();
  assert.equal(sc.blackStones, 8); assert.equal(sc.blackTerr, 1);
  assert.equal(sc.whiteStones, 8); assert.equal(sc.whiteTerr, 1);
  assert.equal(sc.black, 9);
  assert.equal(sc.white, 16.5);
  assert.equal(sc.winnerF, 2);
  // 与独立实现一致
  assert.deepEqual(sc, { ...qaArea(w.weiqi.board, SIZE, KOMI), winnerF: sc.winnerF, margin: sc.margin });
});

test('WQA-09 空盘数子：0 : 7.5，白胜（贴目）', () => {
  const w = seated();
  const sc = w._weiqiScore();
  assert.equal(sc.black, 0);
  assert.equal(sc.white, 7.5);
  assert.equal(sc.winnerF, 2);
});

// ---------- A. 无演化（与 go 的本质区别） ----------

test('WQA-10 无演化：康威会变的棋形（三连 + 孤子）在 tick/intervalStep 后棋盘逐格不变', () => {
  const w = seated();
  put(w, 5, 5, 1); put(w, 6, 5, 1); put(w, 7, 5, 1);   // 水平三连（康威下会演化）
  put(w, 9, 9, 1);                                     // 孤子
  put(w, 3, 12, 2); put(w, 4, 12, 2); put(w, 5, 12, 2);
  const before = Array.from(w.weiqi.board);
  const n0 = stones(w.weiqi.board);
  for (let i = 0; i < 5; i++) w._weiqiTick([]);
  assert.deepEqual(Array.from(w.weiqi.board), before, '_weiqiTick 不得改变棋盘（无康威演化）');
  for (let i = 0; i < 3; i++) intervalLoopStep(w);     // 两位人类，无 AI
  assert.deepEqual(Array.from(w.weiqi.board), before, '主干 interval 步进也不得改变棋盘');
  assert.equal(stones(w.weiqi.board), n0, '孤子既不死也不引发新生');
});

// ---------- A. pass / 认输 ----------

test('WQA-11 pass 计数：单 pass 不终局、有落子即清零、pass 解除劫', () => {
  const w = seated();
  put(w, 10, 10, 2);
  put(w, 9, 10, 1); put(w, 10, 9, 1); put(w, 10, 11, 1);
  put(w, 12, 10, 2); put(w, 11, 9, 2); put(w, 11, 11, 2);
  assert.equal(w.applyWeiqiIntent(1, { lx: 11, ly: 10 }, []).ok, true);   // 黑提 → 成劫，换手白
  assert.deepEqual(w.weiqi.ko, { x: 10, y: 10 });
  assert.equal(w.applyWeiqiIntent(2, { pass: true }, []).pass, true);      // 白 pass
  assert.equal(w.weiqi.ko, null, 'pass 应解除劫禁着');
  assert.equal(w.weiqi.passes, 1);
  assert.equal(w.weiqi.result, null, '单 pass 不终局');
  assert.equal(w.applyWeiqiIntent(1, { lx: 0, ly: 0 }, []).ok, true);      // 黑落子
  assert.equal(w.weiqi.passes, 0, '有落子即清零连续 pass');
  assert.equal(w.weiqi.result, null);
});

test('WQA-12 认输压过分数：黑虽地盘巨大，认输即判白胜', () => {
  const w = seated();
  for (let i = 0; i <= 13; i++) { put(w, i, 0, 1); put(w, i, 13, 1); put(w, 0, i, 1); put(w, 13, i, 1); }
  assert.ok(w._weiqiScore().black > w._weiqiScore().white, '构造前提：黑分数领先');
  const r = w.applyWeiqiIntent(1, { resign: true }, []);
  assert.equal(r.resign, true);
  assert.equal(w.weiqi.result.reason, 'resign');
  assert.equal(w.weiqi.result.winner, 2, '认输方判负，与数子分无关');
});

// ---------- B. 错误路径 ----------

test('WQA-13 越界 / 占位 / 非本回合 / 未就座 / 非法格式（棋盘不变）', () => {
  const w = seated();
  assert.equal(w.applyWeiqiIntent(2, { lx: 9, ly: 9 }, []).reason, 'not_your_turn');
  assert.equal(w.applyWeiqiIntent(1, { lx: -1, ly: 0 }, []).reason, 'oob');
  assert.equal(w.applyWeiqiIntent(1, { lx: 19, ly: 0 }, []).reason, 'oob');
  assert.equal(w.applyWeiqiIntent(1, { lx: 0, ly: 19 }, []).reason, 'oob');
  assert.equal(w.applyWeiqiIntent(999, { lx: 9, ly: 9 }, []).reason, 'not_seated');
  for (const bad of [null, {}, { lx: 5 }, { lx: '5', ly: 3 }]) assert.equal(w.applyWeiqiIntent(1, bad, []).reason, 'bad_move');
  assert.equal(w.weiqi.moveNo, 0);
  assert.equal(w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []).ok, true);
  assert.equal(w.applyWeiqiIntent(2, { lx: 9, ly: 9 }, []).reason, 'occupied');
  assert.equal(w.weiqi.moveNo, 1);
});

// ---------- B. routeIntent / snapshot ----------

test('WQA-14 routeIntent 三态 + 拒子事件；快照固定 `.go` 键可序列化；rts 的 `.go` 为 null', () => {
  const w = seated();
  const ev = [];
  const ok = weiqiDef.routeIntent(w, 1, { weiqi: { lx: 9, ly: 9 } }, ev);
  assert.equal(ok.handled, true);
  assert.equal(ok.result.ok, true);
  for (const other of [{ move: { dx: 1, dy: 0 } }, { go: { lx: 1, ly: 1 } }, { gomoku: { lx: 1, ly: 1 } }, {}, 'str']) {
    assert.deepEqual(weiqiDef.routeIntent(w, 1, other, ev), { handled: true, silent: true });
  }
  const ev2 = [];
  const bad = weiqiDef.routeIntent(w, 2, { weiqi: { lx: 9, ly: 9 } }, ev2);
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.reason, 'occupied');
  const rej = ev2.find((e) => e.type === 'weiqi_reject');
  assert.ok(rej && rej.lx === 9 && rej.ly === 9 && rej.reason === 'occupied');

  const s = w.snapshot();
  assert.equal(s.mode, 'weiqi');
  assert.ok(s.go && typeof s.go === 'object', '模式切片必须落在固定键 .go');
  assert.equal(s.go.size, 19);
  assert.equal(s.go.board.length, 361);
  assert.equal(s.go.komi, KOMI);
  assert.equal(s.go.phase, 'play');
  assert.equal(s.go.passes, 0);
  assert.equal(s.go.ko, null);
  assert.ok(s.go.score && typeof s.go.score.black === 'number' && typeof s.go.score.white === 'number');
  assert.equal(s.go.seats.length, 2);
  assert.doesNotThrow(() => JSON.stringify(s));
  const r = new World('rts_qa2', 1, 5, { mode: 'rts' });
  r._skipAIFill = true;
  assert.equal(r.snapshot().go, null);
});

// ---------- C. 注册表 / 隔离性 ----------

test('WQA-15 注册表元数据 + 隔离：weiqi 无 intervalStep（不被 go 的方法串味）', () => {
  assert.equal(getMode('weiqi').id, 'weiqi');
  assert.equal(getMode('weiqi').tickDriver, 'interval');
  assert.equal(getMode('weiqi').intervalMs, 1000);
  assert.equal(boardMaxForMode('weiqi'), 19);
  assert.deepEqual(availableVictoryLinesForMode('weiqi'), ['territory']);
  assert.equal(normalizeMode('weiqi'), 'weiqi');
  assert.ok(listModes().some((m) => m.id === 'weiqi'));
  assert.equal(typeof weiqiDef.intervalStep, 'undefined');
  assert.notEqual(weiqiDef.tick, gomokuDef.tick, 'weiqi 与 gomoku 的 tick 必须是不同实现');
});

test('WQA-16 隔离性：驱动 weiqi 世界不得触碰 gomoku / go 容器', () => {
  const w = seated();
  w.addAI();
  assert.equal(w.gomoku, undefined, 'weiqi 世界不应有 gomoku 容器');
  assert.equal(w.go, null, 'weiqi 世界不应有 go 容器');
  for (let i = 0; i < 4; i++) intervalLoopStep(w);
  assert.equal(w.gomoku, undefined);
  assert.equal(w.go, null);
});

// ---------- D. 确定性 / IR-3a ----------

test('WQA-17 IR-3a：server/modes/weiqi.js 无 Math.random / Date.now（去注释后严格检测）', () => {
  const raw = readFileSync('server/modes/weiqi.js', 'utf8');
  const code = stripComments(raw);
  assert.ok(!/Math\s*\.\s*random/.test(code), '代码（非注释）不得出现 Math.random');
  assert.ok(!/Date\s*\.\s*now/.test(code), '代码（非注释）不得出现 Date.now');
  assert.ok(/Math\.random/.test(raw), '前提：原始源码注释中确有 Math.random 字样');
  assert.ok(!/Math\s*\.\s*random/.test(code), '去注释后不应命中');
});

test('WQA-18 确定性：同 seed 同意图序列 → 棋盘与提子数一致；同 seed 双 AI 世界逐手一致', () => {
  function run(seed) {
    const w = seated(seed);
    const seq = [[1, 9, 9], [2, 9, 10], [1, 3, 3], [2, 3, 4], [1, 15, 15], [2, 15, 16]];
    for (const [pid, x, y] of seq) w.applyWeiqiIntent(pid, { lx: x, ly: y }, []);
    return { board: Array.from(w.weiqi.board), captured: w.weiqi.captured, moveNo: w.weiqi.moveNo };
  }
  assert.deepEqual(run(31), run(31));
  function aiWorld(seed) {
    const w = new World('weiqi_qa_ai_' + seed, 1, seed, { mode: 'weiqi' });
    w._skipAIFill = true; w.addAI(); w.addAI();
    return w;
  }
  const a = aiWorld(5), b = aiWorld(5);
  for (let i = 0; i < 8; i++) { a._weiqiMaybeAIMove([]); b._weiqiMaybeAIMove([]); }
  assert.equal(a.weiqi.moveLog.length, b.weiqi.moveLog.length);
  assert.deepEqual(a.weiqi.moveLog, b.weiqi.moveLog, '同 seed AI 出手应逐手一致');
});

// ---------- E. 主干 seam ----------

test('WQA-19 主干 seam：1Hz 循环按注册表驱动 weiqi（AI 出手 / 计时推进 / changed）', () => {
  const w = new World('weiqi_qa_seam', 1, 3, { mode: 'weiqi' });
  w._skipAIFill = true;
  w.addPlayer(1, 'Human');
  const ai = w.addAI();
  w._weiqiInit();
  w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []);
  assert.equal(w.weiqi.seats[w.weiqi.turnIdx], ai.id);
  const before = w.weiqi.moveNo;

  const s1 = intervalLoopStep(w);
  assert.equal(s1.changed, true);
  assert.equal(w.weiqi.moveNo, before + 1, '轮到 AI 应自动落一手/pass');
  assert.equal(w.weiqi.turn, 1, 'AI 出手后换回人类');

  const ticks = w.weiqi.turnTicks;
  const s2 = intervalLoopStep(w);
  assert.equal(s2.changed, true);
  assert.equal(w.weiqi.moveNo, before + 1, '人类回合 AI 不应出手');
  assert.equal(w.weiqi.turnTicks, ticks + 1, '计时应推进');
});

test('WQA-20 暂停门控：applyWeiqiIntent 被拒 + 主干循环跳过 step（棋盘/计时不变）', () => {
  const w = seated();
  w.paused = true;
  assert.equal(w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []).reason, 'paused');
  const before = Array.from(w.weiqi.board);
  const ticks = w.weiqi.turnTicks;
  for (let i = 0; i < 3; i++) assert.equal(intervalLoopStep(w).skipped, 'paused');
  assert.deepEqual(Array.from(w.weiqi.board), before);
  assert.equal(w.weiqi.turnTicks, ticks);
  w.paused = false;
  assert.equal(w.applyWeiqiIntent(1, { lx: 9, ly: 9 }, []).ok, true);
});
