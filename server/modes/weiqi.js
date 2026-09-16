// server/modes/weiqi.js — 标准围棋（weiqi）模式插件。
//
// 纯围棋规则（与 go 模式**不同**：**无康威/元胞演化**）：
//   · 19×19 棋盘；双方轮流落子，**每手 1 子**。
//   · 4-邻"气"；气尽提子（提掉无气的敌团）。
//   · 禁自杀：落子后自身（整团）无气、且未提掉任何敌子 → 非法。
//   · 劫（ko）禁立即回提：禁止下一手立刻回到上一手之前的同形局面（简单劫）。
//   · 双方连续 pass（各一次）→ 终局。
//   · 计分：**中国规则数子**（己方子数 + 围住的空点）+ **贴目 komi 7.5**（19×19）。
//
// 设计要点：
//   · 本插件自带棋盘容器（this.weiqi），**不复用** go.js 的演化逻辑，也不触碰主干。
//   · 模拟路径禁用 Math.random / Date.now（IR-3a）：AI 平票打破走种子化 this._rng。
//   · 方法族以 `_weiqi*` 前缀命名空间挂载（install 钩子，mixin 只挂自己的方法）。
import { registerMode } from './index.js';

const WEIQI_SIZE = 19;      // 标准 19×19（默认棋盘边长，board=null 时）
const WEIQI_KOMI = 7.5;     // 贴目（19×19 用 7.5）
// 容器内"墙"哨兵：形状外/虚空/越界（来自编辑器形状）→ 不可落子 + 不计气 + 阻断连通。
// 取值 3 与棋子 0/1/2 不相交；groupOf/areaScore 天然把非 0 非本方色当作阻断且不计气/不计地，
// 故无需改动纯函数即可让"墙"生效（与 go 的 board 遮罩语义一致）。
const WEIQI_WALL = 3;
const NEI4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---------------- 纯函数（操作任意棋盘数组，便于落子与 AI 共用） ----------------

/** 行优先线性下标：idx = y*size + x。 */
function idx(size, x, y) { return y * size + x; }
/** 是否在 [0,size) 方形盘内。 */
function inBounds(size, x, y) { return x >= 0 && y >= 0 && x < size && y < size; }

/**
 * 求 (x,y) 所在 4-连通同色团的子集与气数。
 * @param {Int8Array} board
 * @param {number} size
 * @param {number} x @param {number} y
 * @returns {{stones:number[], libs:number, color:number}}
 */
function groupOf(board, size, x, y) {
  const color = board[idx(size, x, y)];
  if (!color) return { stones: [], libs: 0, color: 0 };
  const seen = new Uint8Array(size * size);
  const libSeen = new Uint8Array(size * size);
  const stones = [];
  const stack = [[x, y]];
  seen[idx(size, x, y)] = 1;
  let libs = 0;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    stones.push(idx(size, cx, cy));
    for (const [dx, dy] of NEI4) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(size, nx, ny)) continue;
      const k = idx(size, nx, ny);
      const v = board[k];
      if (v === 0) { if (!libSeen[k]) { libSeen[k] = 1; libs++; } }
      else if (v === color && !seen[k]) { seen[k] = 1; stack.push([nx, ny]); }
    }
  }
  return { stones, libs, color };
}

/**
 * 求 (x,y) 所在团"唯一的气"坐标（仅当恰好 1 口气时返回）。
 * @returns {{x:number,y:number}|null}
 */
function loneLibertyOf(board, size, x, y) {
  const g = groupOf(board, size, x, y);
  if (g.libs !== 1) return null;
  const stoneSet = new Set(g.stones);
  for (const k of g.stones) {
    const cx = k % size, cy = (k / size) | 0;
    for (const [dx, dy] of NEI4) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(size, nx, ny)) continue;
      const nk = idx(size, nx, ny);
      if (board[nk] === 0 && !stoneSet.has(nk)) return { x: nx, y: ny };
    }
  }
  return null;
}

/**
 * 中国规则数子：己方子数 + 被己方唯一围住的空点数（4-邻洪水填充）。
 * 一个空区恰好被单一阵营 4-邻接触 → 全归它；接触 0 或 ≥2 个阵营 → 中立。
 * 纯函数、无随机、O(size²)。
 * @param {Int8Array} board
 * @param {number} size
 * @param {number} komi 贴目（计入白方）
 * @returns {{blackStones:number, whiteStones:number, blackTerr:number, whiteTerr:number,
 *            black:number, white:number, komi:number}}
 */
function areaScore(board, size, komi) {
  let bs = 0, ws = 0;
  for (let k = 0; k < board.length; k++) {
    if (board[k] === 1) bs++;
    else if (board[k] === 2) ws++;
  }
  const seen = new Uint8Array(size * size);
  let bt = 0, wt = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = idx(size, x, y);
      if (board[k] !== 0 || seen[k]) continue;
      const stack = [[x, y]];
      seen[k] = 1;
      let cnt = 0, touchB = false, touchW = false;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cnt++;
        for (const [dx, dy] of NEI4) {
          const nx = cx + dx, ny = cy + dy;
          if (!inBounds(size, nx, ny)) continue;
          const nk = idx(size, nx, ny);
          const v = board[nk];
          if (v === 0) { if (!seen[nk]) { seen[nk] = 1; stack.push([nx, ny]); } }
          else if (v === 1) touchB = true;
          else if (v === 2) touchW = true;
        }
      }
      if (touchB && !touchW) bt += cnt;
      else if (touchW && !touchB) wt += cnt;
    }
  }
  return { blackStones: bs, whiteStones: ws, blackTerr: bt, whiteTerr: wt, black: bs + bt, white: ws + wt + komi, komi };
}

/**
 * 计算当前行动方的最优落点（启发式，确定性）。提子 > 气 > 邻子 > 中心；平票走种子化 rng。
 * 棋盘较小（361 点），穷举所有合法点即可。
 * @param {import('../engine.js').World} engine
 * @returns {{x:number,y:number}|null} 落点；无合法点 → null（AI 应 pass）
 */
function bestWeiqiMove(engine) {
  const g = engine._weiqiInit();
  const size = g.size, B = g.board, f = g.turn;
  const opp = f === 1 ? 2 : 1;
  const mid = (size - 1) / 2;
  let best = null, bestS = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = idx(size, x, y);
      if (B[k] !== 0) continue;
      if (g.ko && g.ko.x === x && g.ko.y === y) continue;
      // 在副本上模拟：落子 → 提敌 → 自杀判定
      const tmp = B.slice();
      tmp[k] = f;
      let captured = 0;
      for (const [dx, dy] of NEI4) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(size, nx, ny)) continue;
        const nk = idx(size, nx, ny);
        if (tmp[nk] === opp) {
          const grp = groupOf(tmp, size, nx, ny);
          if (grp.libs === 0) { for (const s of grp.stones) tmp[s] = 0; captured += grp.stones.length; }
        }
      }
      const own = groupOf(tmp, size, x, y);
      if (captured === 0 && own.libs === 0) continue;   // 非法自杀
      let near = 0;
      for (const [dx, dy] of NEI4) {
        const nx = x + dx, ny = y + dy;
        if (inBounds(size, nx, ny) && B[idx(size, nx, ny)] !== 0) near++;
      }
      let s = captured * 80 + Math.min(own.libs, 6) * 3 + near * 2
        + (size - (Math.abs(x - mid) + Math.abs(y - mid))) * 0.1
        + engine._rng() * 0.05;
      if (s > bestS) { bestS = s; best = { x, y }; }
    }
  }
  return best;
}

// ---------------- 挂到 World.prototype 的方法族 ----------------

const proto = {
  /**
   * 惰性初始化围棋状态容器。棋盘为**自带** Int8Array（不复用 rts 生命层 / 无演化）。
   * 尺寸：若房主用编辑器配了棋盘（this.board / this._bmp）→ 取 max(cfg.w, cfg.h)；
   *       否则默认 19×19（board=null → 无墙，行为与改造前逐字节一致）。
   * 形状外/虚空/越界格标记为 WEIQI_WALL（3），使编辑的"形状外/虚空"对落子/提子/气生效。
   */
  _weiqiInit() {
    const cfg = this.board || null;
    const size = cfg ? Math.max(cfg.w | 0, cfg.h | 0) : WEIQI_SIZE;
    const rev = this._boardRev || 0;
    if (this.weiqi && this.weiqi.size === size && this.weiqi.rev === rev) return this.weiqi;
    if (!this.weiqiSeatIds) this.weiqiSeatIds = [];
    this.weiqi = {
      size,
      rev,
      board: new Int8Array(size * size),   // 0 空 / 1 黑 / 2 白 / 3 墙，行优先
      seats: [],
      seatF: [],
      turnIdx: 0,
      turn: 1,
      moveNo: 0,
      turnTicks: 0,
      passes: 0,                            // 连续 pass 计数（≥2 → 终局）
      ko: null,                             // {x,y} 劫禁着点
      lastMove: null,                       // {x,y,f}
      captured: { 1: 0, 2: 0 },             // 各方累计提子数
      result: null,
      moveLog: [],                          // [{n,f,x,y,captured}]
    };
    // 若配置了棋盘形状：把墙（形状外/虚空/越界）在容器上标为 WEIQI_WALL。
    // board=null（this._bmp=null）→ 不标任何墙 → 标准 19×19 行为逐字节不变。
    if (this._bmp) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (this._isWall(x, y)) this.weiqi.board[idx(size, x, y)] = WEIQI_WALL;
        }
      }
    }
    this._weiqiSyncSeats();
    return this.weiqi;
  },

  /** 把 weiqiSeatIds 同步到容器 seats（支持中途加入/移除）。 */
  _weiqiSyncSeats() {
    const g = this._weiqiInit();
    if (!this.weiqiSeatIds) this.weiqiSeatIds = [];
    const prevTurnId = g.seats[g.turnIdx] != null ? g.seats[g.turnIdx] : null;
    const ids = this.weiqiSeatIds.filter((id) => this.players && this.players[id]);
    g.seats = ids;
    g.seatF = ids.map((id) => this._factionOf(id));
    let i = prevTurnId != null ? ids.indexOf(prevTurnId) : -1;
    if (i < 0) i = Math.min(g.turnIdx || 0, Math.max(0, ids.length - 1));
    g.turnIdx = Math.max(0, i);
    g.turn = g.seatF[g.turnIdx] != null ? g.seatF[g.turnIdx] : 1;
    return g;
  },

  /** 就座：按加入顺序追加到 weiqiSeatIds（= 行动顺序），幂等。 */
  _weiqiSeat(p) {
    if (!p) return;
    if (!this.weiqiSeatIds) this.weiqiSeatIds = [];
    if (this.weiqiSeatIds.indexOf(p.id) === -1) this.weiqiSeatIds.push(p.id);
    this._weiqiSyncSeats();
  },

  /** 结束一手：换到下一位未认输的行动方。 */
  _weiqiAdvance() {
    const g = this._weiqiInit();
    const seats = g.seats || [];
    if (seats.length === 0) return;
    let step = 0;
    do {
      g.turnIdx = (g.turnIdx + 1) % seats.length;
      step++;
    } while (step <= seats.length && this.players[seats[g.turnIdx]] && this.players[seats[g.turnIdx]].lost);
    g.turn = g.seatF[g.turnIdx] != null ? g.seatF[g.turnIdx] : 0;
    g.turnTicks = 0;
  },

  /**
   * 落一子（含提子 / 禁自杀 / 劫）。原子结算，失败自动回滚。
   * @param {number} f 阵营（1 = 黑 / 2 = 白）
   * @param {number} x @param {number} y
   * @param {object[]} [events]
   * @returns {{ok:boolean, captured?:number, reason?:string}}
   */
  _weiqiPlay(f, x, y, events) {
    const g = this._weiqiInit();
    const size = g.size, B = g.board;
    if (!inBounds(size, x, y)) return { ok: false, reason: 'oob' };
    const k = idx(size, x, y);
    if (B[k] === WEIQI_WALL) return { ok: false, reason: 'wall' };   // 编辑器形状外/虚空 → 不可落子
    if (B[k] !== 0) return { ok: false, reason: 'occupied' };
    if (g.ko && g.ko.x === x && g.ko.y === y) return { ok: false, reason: 'ko' };
    const opp = f === 1 ? 2 : 1;
    const backup = B.slice();            // 自杀回滚用
    B[k] = f;
    // 提掉相邻无气敌团（去重）
    let captured = 0;
    const tried = new Set();
    for (const [dx, dy] of NEI4) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(size, nx, ny)) continue;
      const nk = idx(size, nx, ny);
      if (B[nk] !== opp || tried.has(nk)) continue;
      tried.add(nk);
      const grp = groupOf(B, size, nx, ny);
      if (grp.libs === 0) { for (const s of grp.stones) B[s] = 0; captured += grp.stones.length; }
    }
    // 禁自杀：未提子且自身整团无气 → 回滚
    if (captured === 0) {
      const own = groupOf(B, size, x, y);
      if (own.libs === 0) { g.board = backup; return { ok: false, reason: 'suicide' }; }
    }
    // 劫：单子提且自身单子仅 1 气 → 记劫禁着（下一手不得立即回提）
    g.ko = null;
    if (captured === 1) {
      const own = groupOf(B, size, x, y);
      if (own.stones.length === 1 && own.libs === 1) {
        const lp = loneLibertyOf(B, size, x, y);
        if (lp) g.ko = { x: lp.x, y: lp.y };
      }
    }
    g.moveNo++;
    g.passes = 0;
    g.lastMove = { x, y, f };
    g.captured[f] = (g.captured[f] || 0) + captured;
    g.moveLog.push({ n: g.moveNo, f, x, y, captured });
    if (events) events.push({ type: 'weiqi_move', playerId: null, lx: x, ly: y, faction: f, captured, moveNo: g.moveNo });
    return { ok: true, captured };
  },

  /** 中国规则数子（含贴目）。返回子数/空点/总分与领先方。 */
  _weiqiScore() {
    const g = this._weiqiInit();
    const sc = areaScore(g.board, g.size, WEIQI_KOMI);
    const winnerF = sc.black > sc.white ? 1 : (sc.white > sc.black ? 2 : 0);
    return { ...sc, winnerF, margin: Math.abs(sc.black - sc.white) };
  },

  /**
   * 终局结算：按中国规则数子（子数 + 围住空点 + 贴目）定胜负；分差为 0 → 平局。
   * @param {string} reason 'pass' | 'resign'
   * @param {object[]} [events]
   */
  _weiqiFinish(reason, events) {
    const g = this._weiqiInit();
    const sc = this._weiqiScore();
    const pidFor = (fac) => { const i = g.seatF.indexOf(fac); return i >= 0 ? g.seats[i] : null; };
    let winner = null;
    if (sc.winnerF === 1) winner = pidFor(1);
    else if (sc.winnerF === 2) winner = pidFor(2);
    // 认输情形：剔除认输方后若仅剩一方，直接判其胜（避免"认输方分数更高"的荒谬结果）
    if (reason === 'resign') {
      const alive = (g.seats || []).filter((pid) => !(this.players[pid] && this.players[pid].lost));
      winner = alive.length === 1 ? alive[0] : winner;
    }
    g.result = {
      winner: winner != null ? winner : null,
      reason,
      black: sc.black, white: sc.white, komi: sc.komi,
      blackStones: sc.blackStones, whiteStones: sc.whiteStones,
      blackTerr: sc.blackTerr, whiteTerr: sc.whiteTerr,
      moves: g.moveNo,
    };
    if (winner != null) {
      const p = this.players[winner];
      if (p) { p.won = true; p.winReason = 'weiqi'; }
    }
    if (events) {
      events.push({
        type: 'weiqi_end', winner: g.result.winner, reason,
        black: sc.black, white: sc.white, komi: sc.komi, moves: g.moveNo,
      });
    }
  },

  /**
   * 处理围棋落子 / 停一手 / 认输意图。
   * @param {*} playerId
   * @param {object} data {lx,ly} | {pass:true} | {resign:true}
   * @param {object[]} [events]
   * @returns {{ok:boolean, reason?:string, pass?:boolean, resign?:boolean, captured?:number}}
   */
  applyWeiqiIntent(playerId, data, events) {
    const evts = events || [];
    const g = this._weiqiSyncSeats();
    if (this.paused) return { ok: false, reason: 'paused' };
    if (g.result) return { ok: false, reason: 'ended' };
    if (!data || typeof data !== 'object') return { ok: false, reason: 'bad_move' };
    const seatIdx = (g.seats || []).indexOf(playerId);
    if (seatIdx === -1) return { ok: false, reason: 'not_seated' };
    if (g.seatF[seatIdx] !== g.turn) return { ok: false, reason: 'not_your_turn' };

    // 认输
    if (data.resign) {
      const p = this.players[playerId];
      if (p) { p.lost = true; p.lostReason = 'resign'; }
      this._weiqiFinish('resign', evts);
      return { ok: true, resign: true };
    }
    // 停一手（pass）：双方连续各 pass 一次 → 终局
    if (data.pass) {
      g.passes = (g.passes || 0) + 1;
      g.ko = null;                       // pass 亦解除劫禁着
      if (events) events.push({ type: 'weiqi_pass', playerId, moveNo: g.moveNo });
      if (g.passes >= 2) { this._weiqiFinish('pass', evts); }
      else { this._weiqiAdvance(); }
      return { ok: true, pass: true };
    }
    // 落子（每手 1 子）
    if (typeof data.lx !== 'number' || typeof data.ly !== 'number') return { ok: false, reason: 'bad_move' };
    const r = this._weiqiPlay(g.turn, data.lx | 0, data.ly | 0, evts);
    if (!r.ok) return r;
    const evt = evts.length ? evts[evts.length - 1] : null;
    if (evt && evt.type === 'weiqi_move') evt.playerId = playerId;
    this._weiqiAdvance();
    return { ok: true, captured: r.captured };
  },

  /** 若当前行动方是 AI（或掉线代打），则落一手 / 停一手。由 1Hz tick 调用。 */
  _weiqiMaybeAIMove(events) {
    const g = this._weiqiSyncSeats();
    if (g.result || (g.seats || []).length === 0) return false;
    const pid = g.seats[g.turnIdx];
    const p = pid != null ? this.players[pid] : null;
    if (!p || p.lost) return false;
    if (!(p.isAI === true || p.botControlled === true)) return false;
    const mv = bestWeiqiMove(this);
    if (!mv) { this.applyWeiqiIntent(pid, { pass: true }, events); return true; }   // 无合法点 → pass
    this.applyWeiqiIntent(pid, { lx: mv.x, ly: mv.y }, events);
    return true;
  },

  /**
   * 围棋 1 秒计时步进：推进计时，轮到 AI 时自动出手。
   * @param {object[]} [events]
   * @returns {{events:object[], tickMs:number}}
   */
  _weiqiTick(events) {
    const evts = events || [];
    const g = this._weiqiSyncSeats();
    if (g.result) { this.events = []; return { events: [], tickMs: 0 }; }
    this.tick++;
    g.turnTicks++;
    this._weiqiMaybeAIMove(evts);
    this.events = evts;
    return { events: evts, tickMs: 0 };
  },

  /** 围棋快照切片（注入 engine.snapshot() 的 mode 字段）。 */
  _weiqiSnapshot() {
    const g = this._weiqiSyncSeats();
    const sc = this._weiqiScore();
    const turnPid = g.seats[g.turnIdx] != null ? g.seats[g.turnIdx] : null;
    const seats = (g.seats || []).map((pid, i) => {
      const p = this.players[pid];
      const fac = g.seatF[i];
      const detail = fac === 1
        ? { stones: sc.blackStones, empty: sc.blackTerr, score: sc.black }
        : (fac === 2 ? { stones: sc.whiteStones, empty: sc.whiteTerr, score: sc.white } : { stones: 0, empty: 0, score: 0 });
      return {
        playerId: pid,
        name: p ? p.name : String(pid),
        color: p ? p.color : '#888',
        isAI: !!(p && p.isAI),
        botControlled: !!(p && p.botControlled),
        lost: !!(p && p.lost),
        faction: fac,
        isTurn: pid === turnPid,
        ...detail,
      };
    });
    const winnerName = g.result && g.result.winner != null
      ? ((this.players[g.result.winner] || {}).name || null) : null;
    return {
      size: g.size,
      board: Array.from(g.board),
      turn: turnPid,
      turnF: g.turn,
      turnIdx: g.turnIdx,
      seats,
      moveNo: g.moveNo,
      passes: g.passes || 0,
      ko: g.ko,
      captured: { black: g.captured[1] || 0, white: g.captured[2] || 0 },
      lastMove: g.lastMove,
      komi: WEIQI_KOMI,
      phase: g.result ? 'over' : 'play',
      score: g.result ? {
        black: g.result.black, white: g.result.white, komi: g.result.komi,
        blackStones: g.result.blackStones, whiteStones: g.result.whiteStones,
        blackTerr: g.result.blackTerr, whiteTerr: g.result.whiteTerr,
      } : {
        black: sc.black, white: sc.white, komi: sc.komi,
        blackStones: sc.blackStones, whiteStones: sc.whiteStones,
        blackTerr: sc.blackTerr, whiteTerr: sc.whiteTerr,
      },
      result: g.result ? { ...g.result, winnerName } : null,
    };
  },
};

// ---------------- 模式插件契约 ----------------

const def = {
  id: 'weiqi',
  label: '标准围棋',
  tickDriver: 'interval',
  intervalMs: 1000,
  boardMax: WEIQI_SIZE,     // 标准 19×19
  growLifeLayer: false,
  availableVictoryLines: ['territory'],

  install(World) {
    const P = World.prototype;
    P._weiqiInit = proto._weiqiInit;
    P._weiqiSyncSeats = proto._weiqiSyncSeats;
    P._weiqiSeat = proto._weiqiSeat;
    P._weiqiAdvance = proto._weiqiAdvance;
    P._weiqiPlay = proto._weiqiPlay;
    P._weiqiScore = proto._weiqiScore;
    P._weiqiFinish = proto._weiqiFinish;
    P.applyWeiqiIntent = proto.applyWeiqiIntent;
    P._weiqiMaybeAIMove = proto._weiqiMaybeAIMove;
    P._weiqiTick = proto._weiqiTick;
    P._weiqiSnapshot = proto._weiqiSnapshot;
    World.WEIQI_SIZE = WEIQI_SIZE;
    World.WEIQI_KOMI = WEIQI_KOMI;
    World.WEIQI_WALL = WEIQI_WALL;
  },

  // 模拟步进：interval 的一步 = 先 AI（轮到 AI 时出手 / pass）→ 再推进计时（turnTicks++）。
  // 主干 1Hz 循环按注册表调用（优先 intervalStep，回退 tick）；返回 { changed:true } 触发广播。
  tick(engine, events) {
    engine._weiqiTick(events);
    return { changed: true, events: events || [] };
  },

  onAddPlayer(engine, p) {
    engine.players[p.id] = p;
    p.weiqiTimeouts = 0;
    engine._weiqiSeat(p);
    if (engine.hostId == null) engine.hostId = p.id;
  },
  onAddAI(engine, ai) {
    ai.weiqiTimeouts = 0;
    engine._weiqiSeat(ai);
  },

  routeIntent(engine, pid, intent, events) {
    if (!(intent && intent.weiqi && typeof intent.weiqi === 'object')) {
      return { handled: true, silent: true };
    }
    let r;
    try { r = engine.applyWeiqiIntent(pid, intent.weiqi, events); }
    catch (e) { return { handled: true, result: { ok: false, reason: 'weiqi_intent_failed' } }; }
    if (!r.ok && r.reason && r.reason !== 'oob') {
      const wi = intent.weiqi || {};
      if (typeof wi.lx === 'number' && typeof wi.ly === 'number') {
        events.push({ type: 'weiqi_reject', reason: String(r.reason), lx: wi.lx | 0, ly: wi.ly | 0, playerId: pid });
      }
    }
    return { handled: true, result: r };
  },

  snapshot(engine) { return engine._weiqiSnapshot(); },
};

registerMode(def);
export default def;
