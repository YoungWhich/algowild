// tests/gomoku.qa.test.mjs — 五子棋（gomoku）**独立** QA 套件（QA Edward 编写）
//
// 目的：用与工程师 tests/gomoku.test.mjs **不同**的构造与断言，独立复核规则/契约/隔离性/确定性。
//      凡断言与实现不一致处，先判断"期望是否正确"再定位是源码缺陷还是测试缺陷。
//
// 覆盖（超出工程师用例的部分）：
//   · 四个方向（横/竖/主对角/副对角）判胜各一条（工程师只覆盖横+主对角）
//   · 恰好 4 连不算胜；≥5（6 连/长连 overline）算胜；断线（中间有空格/被敌子截断）不误判
//   · 满盘无五连 = 平局（用 QA 自写的独立五连扫描器交叉验证构造）
//   · 非法格式 / 未就座 / 暂停门控 / 越界 / 占位 / 非本回合
//   · routeIntent 三态语义 + 被拒事件；快照固定 `.go` 键；rts 的 `.go` 为 null
//   · 注册表元数据 + 隔离（gomoku 不得有 intervalStep，go 才有；步进不串味到 weiqi/go）
//   · 主干 interval 循环 seam 复现（含 paused / changed 门控）；RNG 确定性
//   · IR-3a：源码无 Math.random / Date.now
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';
import gomokuDef from '../server/modes/gomoku.js';
import goDef from '../server/modes/go.js';
import weiqiDef from '../server/modes/weiqi.js';
import { getMode, normalizeMode, boardMaxForMode, availableVictoryLinesForMode, listModes } from '../server/modes/index.js';

await loadKernels();

const SIZE = 15;
const IX = (x, y) => y * SIZE + x;

// ---------- QA 自带的独立工具（不复用被实现的私有函数） ----------

/** 两位人类就座（黑=首座，先手）。 */
function seated(seed = 7) {
  const w = new World('gomoku_qa_' + seed, 1, seed, { mode: 'gomoku' });
  w._skipAIFill = true;
  w.addPlayer(1, 'B');
  w.addPlayer(2, 'W');
  w._gomokuInit();
  return w;
}

/** 直接摆子（绕过回合），用于快速构造局面。 */
function put(w, x, y, f) { w.gomoku.board[IX(x, y)] = f; }

/** 独立实现：从 (x,y) 出发四方向计数连续同色（前向），返回是否存在 ≥5 连。 */
function fiveAt(board, size, x, y) {
  const f = board[y * size + x];
  if (!f) return false;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    let cx = x + dx, cy = y + dy;
    while (cx >= 0 && cy >= 0 && cx < size && cy < size && board[cy * size + cx] === f) { n++; cx += dx; cy += dy; }
    if (n >= 5) return true;
  }
  return false;
}
/** 独立实现：全盘扫描任意 ≥5 连，返回命中的起点或 null。 */
function hasAnyFive(board, size) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (fiveAt(board, size, x, y)) return { x, y };
  return null;
}

/** 剥离 JS 注释（IR-3a 检测需排除注释里对 Math.random 的文档性提及）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 复现主干 1Hz interval 循环体（net.js / index.js），供 seam 验证。 */
function intervalLoopStep(w) {
  if (w._mode.tickDriver !== 'interval') return { skipped: 'driver' };
  if (Object.keys(w.players).length === 0) return { skipped: 'no-players' };
  if (w.paused) return { skipped: 'paused' };           // 主干：暂停即跳过，不调 step
  const events = [];
  const step = w._mode.intervalStep || w._mode.tick;    // 主干按注册表取一步
  if (!step) return { skipped: 'no-step' };
  const r = step(w, events);
  return { changed: !(r && r.changed === false), events: events };
}

// ---------- A. 规则：四方向判胜 ----------

test('GQA-01 竖向五连 → 黑胜（engineer 未覆盖的方向）', () => {
  const w = seated();
  const seq = [
    [1, 7, 3], [2, 0, 0],
    [1, 7, 4], [2, 1, 0],
    [1, 7, 5], [2, 2, 0],
    [1, 7, 6], [2, 3, 0],
    [1, 7, 7],   // (7,3..7) 竖五连
  ];
  let last = null;
  for (const [pid, x, y] of seq) last = w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
  assert.equal(last.win, true);
  assert.equal(w.gomoku.result.reason, 'five');
  assert.equal(w.gomoku.result.winner, 1);
  assert.equal(w.gomoku.result.line.length, 5);
  for (const c of w.gomoku.result.line) assert.equal(c.x, 7, '命中连线应在同一列');
});

test('GQA-02 副对角（↙）五连 → 黑胜（engineer 未覆盖的方向）', () => {
  const w = seated();
  const seq = [
    [1, 3, 7], [2, 0, 0],
    [1, 4, 6], [2, 1, 0],
    [1, 5, 5], [2, 2, 0],
    [1, 6, 4], [2, 3, 0],
    [1, 7, 3],   // 副对角 x+y=10
  ];
  let last = null;
  for (const [pid, x, y] of seq) last = w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
  assert.equal(last.win, true);
  assert.equal(w.gomoku.result.winner, 1);
  assert.equal(w.gomoku.result.line.length, 5);
  for (const c of w.gomoku.result.line) assert.equal(c.x + c.y, 10, '命中连线应满足 x+y=10');
});

// ---------- A. 规则：4 连不算 / ≥5 算 / 断线不误判 ----------

test('GQA-03 恰好 4 连 → 不算胜，对局继续（换手给黑）', () => {
  const w = seated();
  const seq = [
    [1, 0, 0], [2, 0, 1],
    [1, 1, 0], [2, 1, 1],
    [1, 2, 0], [2, 2, 1],
    [1, 3, 0], [2, 3, 1],   // 黑白各 4 连，均不到 5
  ];
  for (const [pid, x, y] of seq) {
    const r = w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
    assert.equal(r.win, undefined, '4 连不得判胜');
  }
  assert.equal(w.gomoku.result, null);
  assert.equal(w.gomoku.moveNo, 8);
  assert.equal(w.gomoku.turn, 1, '第 8 手后应轮到黑');
  assert.equal(hasAnyFive(w.gomoku.board, SIZE), null, 'QA 独立扫描：盘上不应存在 ≥5 连');
});

test('GQA-04 长连（6 连 overline）→ 仍算胜，命中线长 6', () => {
  const w = seated();
  // 先摆成 X X X _ X X（5 子、中间留空），再补中间 → 6 连
  put(w, 0, 0, 1); put(w, 1, 0, 1); put(w, 3, 0, 1); put(w, 4, 0, 1); put(w, 5, 0, 1);
  assert.equal(hasAnyFive(w.gomoku.board, SIZE), null, '摆位阶段不应已有五连');
  const r = w.applyGomokuIntent(1, { lx: 2, ly: 0 }, []);
  assert.equal(r.win, true);
  assert.equal(w.gomoku.result.reason, 'five');
  assert.equal(w.gomoku.result.line.length, 6, '≥5 连应判胜且命中线为 6');
});

test('GQA-05 断线（中间留空）→ 不误判为五连', () => {
  const w = seated();
  put(w, 0, 0, 1); put(w, 1, 0, 1); put(w, 2, 0, 1); put(w, 3, 0, 1);   // 4 连
  const r = w.applyGomokuIntent(1, { lx: 5, ly: 0 }, []);              // 跳过 (4,0) → 不成五连
  assert.equal(r.win, undefined);
  assert.equal(w.gomoku.result, null);
  assert.equal(hasAnyFive(w.gomoku.board, SIZE), null);
});

test('GQA-06 被敌子截断的连子 → 不误判', () => {
  const w = seated();
  put(w, 0, 0, 1); put(w, 1, 0, 1); put(w, 2, 0, 1); put(w, 3, 0, 1);   // 黑 4 连
  put(w, 4, 0, 2);                                                     // 白子截断
  const r = w.applyGomokuIntent(1, { lx: 5, ly: 0 }, []);              // 黑在截断外侧再落
  assert.equal(r.win, undefined);
  assert.equal(w.gomoku.result, null);
});

// ---------- A. 规则：满盘平局 ----------

test('GQA-07 满盘无五连 → 平局（QA 独立图案 + 独立扫描器交叉验证）', () => {
  const w = seated();
  // 周期图案 v=(2x+y)%4<2 ? 1 : 2：横 1 连、竖/斜皆 ≤2 连（无 5 连）。留 (0,0) 作最后一手。
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x === 0 && y === 0) continue;
      put(w, x, y, ((2 * x + y) % 4) < 2 ? 1 : 2);
    }
  }
  assert.equal(hasAnyFive(w.gomoku.board, SIZE), null, 'QA 独立扫描：填充图案不得含 ≥5 连');
  w.gomoku.moveNo = SIZE * SIZE - 1;
  const r = w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []);
  assert.equal(r.draw, true);
  assert.equal(w.gomoku.result.reason, 'draw');
  assert.equal(w.gomoku.result.winner, null);
  assert.equal(w.gomoku.moveNo, SIZE * SIZE);
  assert.equal(hasAnyFive(w.gomoku.board, SIZE), null, '终局后仍应无 ≥5 连');
});

// ---------- B. 错误路径 ----------

test('GQA-08 非法格式 → bad_move，棋盘不变', () => {
  const w = seated();
  for (const bad of [null, undefined, {}, { lx: 5 }, { ly: 5 }, { lx: '5', ly: 3 }, { lx: 3, ly: '2' }, 42, 'x']) {
    const r = w.applyGomokuIntent(1, bad, []);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'bad_move');
  }
  assert.equal(w.gomoku.moveNo, 0);
  assert.equal(w.gomoku.board.every((v) => v === 0), true, '棋盘应保持全空');
});

test('GQA-09 未就座玩家 → not_seated，棋盘不变', () => {
  const w = seated();
  const r = w.applyGomokuIntent(999, { lx: 7, ly: 7 }, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_seated');
  assert.equal(w.gomoku.moveNo, 0);
});

test('GQA-10 暂停门控：applyGomokuIntent 被拒 + 主干循环跳过 step（棋盘/计时均不变）', () => {
  const w = seated();
  w.paused = true;
  const r = w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'paused');
  const before = Array.from(w.gomoku.board);
  const ticksBefore = w.gomoku.turnTicks;
  // 复现主干 1Hz 循环：paused → 直接 continue（不调用 step）
  for (let i = 0; i < 3; i++) {
    const r2 = intervalLoopStep(w);
    assert.equal(r2.skipped, 'paused');
  }
  assert.deepEqual(Array.from(w.gomoku.board), before, '暂停时棋盘不得改变');
  assert.equal(w.gomoku.turnTicks, ticksBefore, '暂停时计时不得推进');
  // 解冻后可正常落子
  w.paused = false;
  assert.equal(w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []).ok, true);
});

test('GQA-11 越界 / 占位 / 非本回合 三连拒（棋盘不变）', () => {
  const w = seated();
  assert.equal(w.applyGomokuIntent(1, { lx: 15, ly: 0 }, []).reason, 'oob');
  assert.equal(w.applyGomokuIntent(1, { lx: 0, ly: 15 }, []).reason, 'oob');
  assert.equal(w.applyGomokuIntent(2, { lx: 7, ly: 7 }, []).reason, 'not_your_turn');   // 白先手
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  assert.equal(w.applyGomokuIntent(2, { lx: 7, ly: 7 }, []).reason, 'occupied');
  assert.equal(w.gomoku.moveNo, 1);
});

// ---------- B. routeIntent / snapshot ----------

test('GQA-12 routeIntent 三态：本模式 intent / 他模式 silent / 被拒附事件', () => {
  const w = seated();
  const ev = [];
  const ok = gomokuDef.routeIntent(w, 1, { gomoku: { lx: 7, ly: 7 } }, ev);
  assert.equal(ok.handled, true);
  assert.equal(ok.silent, undefined);
  assert.equal(ok.result.ok, true);
  // 非本模式 intent → silent（不入 rts 队列、不广播）
  for (const other of [{ move: { dx: 1, dy: 0 } }, { go: { lx: 1, ly: 1 } }, { weiqi: { lx: 1, ly: 1 } }, {}, { chat: 'hi' }]) {
    assert.deepEqual(gomokuDef.routeIntent(w, 1, other, ev), { handled: true, silent: true });
  }
  // 被拒（占位）→ result.ok=false + 补一条 gomoku_reject（含落点）
  const ev2 = [];
  const bad = gomokuDef.routeIntent(w, 2, { gomoku: { lx: 7, ly: 7 } }, ev2);
  assert.equal(bad.handled, true);
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.reason, 'occupied');
  const rej = ev2.find((e) => e.type === 'gomoku_reject');
  assert.ok(rej, '被拒应产生 gomoku_reject 事件');
  assert.deepEqual({ lx: rej.lx, ly: rej.ly, reason: rej.reason, playerId: rej.playerId }, { lx: 7, ly: 7, reason: 'occupied', playerId: 2 });
});

test('GQA-13 snapshot 固定 `.go` 键：gomoku 切片完整可序列化；rts 的 `.go` 为 null', () => {
  const w = seated();
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);
  const s = w.snapshot();
  assert.equal(s.mode, 'gomoku');
  assert.ok(s.go && typeof s.go === 'object', '模式切片必须落在固定键 .go');
  assert.equal(s.go.size, 15);
  assert.equal(s.go.board.length, 225);
  assert.equal(s.go.board[IX(7, 7)], 1);
  assert.equal(s.go.win, 5);
  assert.equal(s.go.phase, 'play');
  assert.equal(s.go.seats.length, 2);
  assert.equal(s.go.turn, 2);
  assert.equal(s.go.lastMove.x, 7);
  assert.doesNotThrow(() => JSON.stringify(s), '快照必须可 JSON 序列化');
  // rts 世界：模式切片为 null（无 snapshot 钩子）
  const r = new World('rts_qa', 1, 5, { mode: 'rts' });
  r._skipAIFill = true;
  assert.equal(r.snapshot().go, null);
});

// ---------- C. 注册表 / 隔离性 ----------

test('GQA-14 注册表元数据 + 驱动方式隔离（gomoku 无 intervalStep，go 才有）', () => {
  assert.equal(getMode('gomoku').id, 'gomoku');
  assert.equal(getMode('gomoku').tickDriver, 'interval');
  assert.equal(getMode('gomoku').intervalMs, 1000);
  assert.equal(boardMaxForMode('gomoku'), 15);
  assert.deepEqual(availableVictoryLinesForMode('gomoku'), ['territory']);
  assert.equal(normalizeMode('gomoku'), 'gomoku');
  assert.equal(normalizeMode('不存在的模式'), 'rts');
  const ids = listModes().map((m) => m.id);
  assert.ok(ids.includes('gomoku') && ids.includes('weiqi'));
  // go（演化的 interval 模式）提供 intervalStep；gomoku / weiqi 只提供 tick。
  assert.equal(typeof goDef.intervalStep, 'function', 'go 应提供 intervalStep');
  assert.equal(typeof gomokuDef.intervalStep, 'undefined', 'gomoku 不应提供 intervalStep（否则会被误用于其它模式）');
  assert.equal(typeof weiqiDef.intervalStep, 'undefined');
  // 世界实例持的是本模式插件，且主干的 step 取法对本模式回退到 tick
  const w = seated();
  assert.equal(w._mode, gomokuDef);
  assert.equal(w._mode.intervalStep || w._mode.tick, gomokuDef.tick);
});

test('GQA-15 隔离性：步进 gomoku 世界不得触碰 weiqi / go 容器', () => {
  const w = seated();
  w.addAI();  // 次座 AI，保证 tick 会尝试落子
  assert.equal(w.go, null, 'gomoku 世界不应有 go 容器');
  assert.equal(w.weiqi, undefined, 'gomoku 世界不应初始化 weiqi 容器');
  for (let i = 0; i < 4; i++) intervalLoopStep(w);
  assert.equal(w.go, null, '驱动 gomoku 不得创建/推进 go 状态');
  assert.equal(w.weiqi, undefined, '驱动 gomoku 不得创建 weiqi 状态');
  assert.ok(w.gomoku.moveNo >= 0);
});

// ---------- D. 确定性 / IR-3a ----------

test('GQA-16 IR-3a：server/modes/gomoku.js 无 Math.random / Date.now（去注释后严格检测）', () => {
  // 注意：源码注释里会**提到** Math.random（文档说明），须先去注释再检测，避免误报。
  const raw = readFileSync('server/modes/gomoku.js', 'utf8');
  const code = stripComments(raw);
  assert.ok(!/Math\s*\.\s*random/.test(code), '代码（非注释）不得出现 Math.random');
  assert.ok(!/Date\s*\.\s*now/.test(code), '代码（非注释）不得出现 Date.now');
  // 反向自检：本助手确实能剥离注释中的提及
  assert.ok(/Math\.random/.test(raw), '前提：原始源码注释中确有 Math.random 字样');
  assert.ok(!/Math\s*\.\s*random/.test(code), '去注释后不应命中');
});

test('GQA-17 确定性：同 seed / 同意图序列 → 棋盘与快照逐格一致', () => {
  function run(seed) {
    const w = seated(seed);
    const seq = [[1, 7, 7], [2, 7, 8], [1, 8, 8], [2, 6, 6], [1, 8, 7], [2, 6, 8]];
    for (const [pid, x, y] of seq) w.applyGomokuIntent(pid, { lx: x, ly: y }, []);
    return { board: Array.from(w.gomoku.board), moveNo: w.gomoku.moveNo, turn: w.gomoku.turn };
  }
  assert.deepEqual(run(2024), run(2024));
});

test('GQA-18 确定性：同 seed 两个 AI 世界逐手一致（种子 rng，非 Math.random）', () => {
  function aiWorld(seed) {
    const w = new World('gomoku_qa_ai_' + seed, 1, seed, { mode: 'gomoku' });
    w._skipAIFill = true;
    w.addAI(); w.addAI();
    return w;
  }
  const a = aiWorld(99), b = aiWorld(99);
  for (let i = 0; i < 6; i++) { a._gomokuMaybeAIMove([]); b._gomokuMaybeAIMove([]); }
  assert.equal(a.gomoku.moveLog.length, 6, '3 手/方不足以成五连，应恰好走满 6 手');
  assert.deepEqual(a.gomoku.moveLog, b.gomoku.moveLog, '同 seed AI 出手应逐手一致');
  // 首手应落在天元（确定性：与 rng 无关），证明走了真实 AI 路径而非空实现
  assert.deepEqual(a.gomoku.moveLog[0], { n: 1, f: 1, x: 7, y: 7 });
});

// ---------- E. 主干 seam ----------

test('GQA-19 主干 seam：1Hz 循环按注册表驱动 gomoku（AI 出手 / 计时推进 / changed）', () => {
  const w = new World('gomoku_qa_seam', 1, 3, { mode: 'gomoku' });
  w._skipAIFill = true;
  w.addPlayer(1, 'Human');           // 黑（人类，先手）
  const ai = w.addAI();              // 白（AI）
  w._gomokuInit();
  w.applyGomokuIntent(1, { lx: 7, ly: 7 }, []);   // 人类落子 → 轮到白 AI
  assert.equal(w.gomoku.seats[w.gomoku.turnIdx], ai.id);
  const before = w.gomoku.moveNo;

  const s1 = intervalLoopStep(w);    // AI 回合 → 自动落一手
  assert.equal(s1.changed, true, '循环应报告 changed（触发广播）');
  assert.equal(w.gomoku.moveNo, before + 1, '轮到 AI 应自动落一手');
  assert.equal(w.gomoku.turn, 1, 'AI 落子后换回人类');

  const ticks = w.gomoku.turnTicks;
  const s2 = intervalLoopStep(w);    // 人类回合 → 仅计时
  assert.equal(s2.changed, true);
  assert.equal(w.gomoku.moveNo, before + 1, '人类回合 AI 不应落子');
  assert.equal(w.gomoku.turnTicks, ticks + 1, '计时应推进');

  // 非 interval 模式（rts）不应被该循环驱动
  const r = new World('rts_seam', 1, 1, { mode: 'rts' });
  r._skipAIFill = true; r.addPlayer(1, 'P');
  assert.equal(intervalLoopStep(r).skipped, 'driver');
});
