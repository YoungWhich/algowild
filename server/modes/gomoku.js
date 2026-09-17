// server/modes/gomoku.js — 五子棋（gomoku）模式插件。
//
// 标准规则（freestyle，无禁手）：
//   · 15×15 棋盘；黑先（第一席位），双方轮流落子，**每手 1 子**。
//   · 任意一方在 **横 / 竖 / 斜** 方向先连成 5 子（含 5 连以上）即胜。
//   · 棋盘下满且无五连 → 平局。
//   · 无提子、无"气"、无演化（与 go 的康威演化完全无关）。
//
// 设计要点：
//   · 本插件自带棋盘容器（this.gomoku），**不复用** rts 生命层，也不触碰主干。
//   · 模拟路径禁用 Math.random / Date.now（IR-3a）：AI 平票打破走种子化 this._rng。
//   · 方法族以 `_gomoku*` 前缀命名空间挂载（install 钩子，mixin 只挂自己的方法）。
//   · routeIntent 只消费 {gomoku:{...}} 意图；其余意图返回 silent（既不入 rts 队列也不广播）。
import { registerMode } from './index.js';
import { aiDifficultyOf, aiTune } from '../ai.js';

const GOMOKU_SIZE = 15;   // 15×15（默认棋盘边长，board=null 时）
const GOMOKU_WIN = 5;     // 5 连即胜（含 5 连以上）
// 容器内"墙"哨兵：形状外/虚空/越界（来自编辑器形状）→ 不可落子 + 阻断连线。
// 取值 99，**落在阵营号 1..8 之外**（`_factionOf` 只返回 1..8，故墙绝不可能与任何玩家阵营撞值）；
// 纯函数（checkWinAt/lineRun/moveScore）天然把非 0 非本方色当作阻断，故无需改动即可让"墙"生效
// （与 go 的 board 遮罩语义一致）。容器为 Int8Array，99 不溢出（范围 -128..127）。
const GOMOKU_WALL = 99;
// 4 个方向：横 / 竖 / 主对角 / 副对角（正反两向在检查时对称扫描）。
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// ---------------- 纯函数（无 this，便于测试与复用） ----------------

/** 行优先线性下标：idx = y*size + x。 */
function idx(size, x, y) { return y * size + x; }
/** 是否在 [0,size) 方形盘内。 */
function inBounds(size, x, y) { return x >= 0 && y >= 0 && x < size && y < size; }

/**
 * 检查 (x,y) 落子后是否形成长度 ≥ GOMOKU_WIN 的连线。
 * @param {Int8Array} board 行优先棋盘
 * @param {number} size 边长
 * @param {number} x @param {number} y 落子点
 * @returns {Array<{x:number,y:number}>|null} 命中的连线格（含落子点）或 null
 */
function checkWinAt(board, size, x, y) {
  const f = board[idx(size, x, y)];
  if (!f) return null;
  for (const [dx, dy] of DIRS) {
    const line = [{ x, y }];
    let nx = x + dx, ny = y + dy;
    while (inBounds(size, nx, ny) && board[idx(size, nx, ny)] === f) {
      line.push({ x: nx, y: ny }); nx += dx; ny += dy;
    }
    nx = x - dx; ny = y - dy;
    while (inBounds(size, nx, ny) && board[idx(size, nx, ny)] === f) {
      line.unshift({ x: nx, y: ny }); nx -= dx; ny -= dy;
    }
    if (line.length >= GOMOKU_WIN) return line;
  }
  return null;
}

/**
 * 从候选点沿某方向数同色连续子（不含候选点本身），并报告远端是否为空。
 * @returns {{cnt:number, open:boolean}}
 */
function lineRun(board, size, x, y, f, dx, dy) {
  let cnt = 0;
  let cx = x + dx, cy = y + dy;
  while (inBounds(size, cx, cy) && board[idx(size, cx, cy)] === f) { cnt++; cx += dx; cy += dy; }
  const open = inBounds(size, cx, cy) && board[idx(size, cx, cy)] === 0;
  return { cnt, open };
}

/** 单方向评分：把候选点当成已落 f 子，评估该方向的连子价值（越长/越开放越高）。 */
function evalDir(board, size, x, y, f, dx, dy) {
  const a = lineRun(board, size, x, y, f, dx, dy);
  const b = lineRun(board, size, x, y, f, -dx, -dy);
  const run = a.cnt + b.cnt + 1;                       // +1 = 候选子
  const openEnds = (a.open ? 1 : 0) + (b.open ? 1 : 0);
  let s = run * run;
  if (openEnds >= 1) s *= 1.5;
  if (openEnds >= 2) s *= 1.4;
  return s;
}

/** 候选点综合评分 = 己方进攻价值 + 0.9 × 拦截对手价值（简化但有效）。 */
function moveScore(board, size, x, y, f, opp) {
  let own = 0, def = 0;
  for (const [dx, dy] of DIRS) {
    own += evalDir(board, size, x, y, f, dx, dy);
    def += evalDir(board, size, x, y, opp, dx, dy);
  }
  return own + def * 0.9;
}

/**
 * 计算当前行动方的最优落点（启发式，确定性）。
 * 空盘 → 直接下天元（居中，避免首手贴边）。平票用种子化 rng 打破。
 * @param {import('../engine.js').World} engine
 * @returns {{x:number,y:number}|null} 落点；无空位（盘满）→ null
 */
function bestGomokuMove(engine) {
  const g = engine._gomokuInit();
  const size = g.size, board = g.board, f = g.turn;
  const opp = f === 1 ? 2 : 1;
  if (g.moveNo === 0) {
    const c = Math.floor(size / 2);
    if (board[idx(size, c, c)] === 0) return { x: c, y: c };
  }
  const mid = (size - 1) / 2;
  // 强度：噪声幅度 / 失误概率（diff=3 → 0.01 / 0，与现状一致）
  const diff = aiDifficultyOf(engine);
  const noiseAmp = aiTune(diff, [0.06, 0.03, 0.01, 0.005, 0.002]);
  const blunderRate = aiTune(diff, [0.5, 0.25, 0, 0, 0]);
  let best = null, bestS = -Infinity;
  let second = null, secondS = -Infinity;    // 次优手（低难度失误时改用）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (board[idx(size, x, y)] !== 0) continue;
      let s = moveScore(board, size, x, y, f, opp);
      s += (size - (Math.abs(x - mid) + Math.abs(y - mid))) * 0.0001;  // 轻微向中心偏好
      s += engine._rng() * noiseAmp;                                    // 种子化平票打破
      if (s > bestS) { secondS = bestS; second = best; bestS = s; best = { x, y }; }
      else if (s > secondS) { secondS = s; second = { x, y }; }
    }
  }
  // 失误判定（仅低难度）：blunderRate>0 短路，diff>=3 不多消耗 rng。
  if (blunderRate > 0 && second && engine._rng() < blunderRate) return second;
  return best;
}

// ---------------- 挂到 World.prototype 的方法族 ----------------

const proto = {
  /**
   * 惰性初始化五子棋状态容器。棋盘为**自带** Int8Array（不复用 rts 生命层）。
   * 尺寸：若房主用编辑器配了棋盘（this.board / this._bmp）→ 取 max(cfg.w, cfg.h)；
   *       否则默认 15×15（board=null → 无墙，行为与改造前逐字节一致）。
   * 形状外/虚空/越界格标记为 GOMOKU_WALL（99），使编辑的"形状外/虚空"对落子/连线生效。
   * @returns {object} this.gomoku
   */
  _gomokuInit() {
    const cfg = this.board || null;
    const size = cfg ? Math.max(cfg.w | 0, cfg.h | 0) : GOMOKU_SIZE;
    const rev = this._boardRev || 0;
    if (this.gomoku && this.gomoku.size === size && this.gomoku.rev === rev) return this.gomoku;
    if (!this.gomokuSeatIds) this.gomokuSeatIds = [];
    this.gomoku = {
      size,
      rev,
      board: new Int8Array(size * size),   // 0 空 / 1 黑 / 2 白 / 99 墙，行优先 idx=y*size+x
      seats: [],                           // [playerId, ...] 行动顺序
      seatF: [],                           // 与 seats 平行的 faction 数组（1..8）
      turnIdx: 0,
      turn: 1,                             // 当前行动方 faction（1 = 黑 = 首座）
      moveNo: 0,                           // 已完成手数
      turnTicks: 0,                        // 本手已用秒数（1Hz 计时）
      lastMove: null,                      // {x,y,f}
      result: null,                        // {winner, reason, line, moves}
      moveLog: [],                         // [{n,f,x,y}] 复盘
    };
    // 若配置了棋盘形状：把墙（形状外/虚空/越界）在容器上标为 GOMOKU_WALL。
    // board=null（this._bmp=null）→ 不标任何墙 → 15×15 行为逐字节不变。
    if (this._bmp) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (this._isWall(x, y)) this.gomoku.board[idx(size, x, y)] = GOMOKU_WALL;
        }
      }
    }
    this._gomokuSyncSeats();
    return this.gomoku;
  },

  /** 把 gomokuSeatIds 同步到容器 seats（支持中途加入/移除；行动顺序尽量保持在同一玩家身上）。 */
  _gomokuSyncSeats() {
    const g = this._gomokuInit();
    if (!this.gomokuSeatIds) this.gomokuSeatIds = [];
    const prevTurnId = g.seats[g.turnIdx] != null ? g.seats[g.turnIdx] : null;
    const ids = this.gomokuSeatIds.filter((id) => this.players && this.players[id]);
    g.seats = ids;
    g.seatF = ids.map((id) => this._factionOf(id));
    let i = prevTurnId != null ? ids.indexOf(prevTurnId) : -1;
    if (i < 0) i = Math.min(g.turnIdx || 0, Math.max(0, ids.length - 1));
    g.turnIdx = Math.max(0, i);
    g.turn = g.seatF[g.turnIdx] != null ? g.seatF[g.turnIdx] : 1;
    return g;
  },

  /** 就座：按加入顺序追加到 gomokuSeatIds（= 行动顺序），幂等。 */
  _gomokuSeat(p) {
    if (!p) return;
    if (!this.gomokuSeatIds) this.gomokuSeatIds = [];
    if (this.gomokuSeatIds.indexOf(p.id) === -1) this.gomokuSeatIds.push(p.id);
    this._gomokuSyncSeats();
  },

  /**
   * 是否已无任何可落的**非墙**空点（0 = 空；1/2 = 子；3 = 墙）。
   * 平局判定用它取代 `moveNo >= size²`：地图编辑器挖出的"形状外/虚空"墙格不可落子，
   * **不得**计入"下满"阈值（否则形状盘永远到不了 size²，平局判定语义错误）。
   * board=null（无墙）时"无非墙空点" ≡ "所有格均已占用" ≡ `moveNo === size²`，逐字节等价。
   * @returns {boolean} true = 棋盘上再无任何可落的非墙空点（应判平局）
   */
  _gomokuNoEmpty() {
    const g = this._gomokuInit();
    const b = g.board;
    for (let i = 0; i < b.length; i++) if (b[i] === 0) return false;
    return true;
  },

  /** 结束一手：换到下一位未认输的行动方。 */
  _gomokuAdvance() {
    const g = this._gomokuInit();
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
   * 终局结算。
   * @param {*|null} winnerPid 胜者 playerId（null = 平局）
   * @param {string} reason 'five' | 'resign' | 'draw' | 'no_move'
   * @param {Array<{x:number,y:number}>|null} line 命中连线
   * @param {object[]} events
   */
  _gomokuFinish(winnerPid, reason, line, events) {
    const g = this._gomokuInit();
    g.result = { winner: winnerPid != null ? winnerPid : null, reason, line: line || null, moves: g.moveNo };
    if (winnerPid != null) {
      const p = this.players[winnerPid];
      if (p) { p.won = true; p.winReason = 'gomoku'; }
    }
    if (events) events.push({ type: 'gomoku_end', winner: g.result.winner, reason, moves: g.moveNo });
  },

  /**
   * 处理五子棋落子 / 认输意图。
   * @param {*} playerId 发起者
   * @param {object} data {lx,ly} | {resign:true}
   * @param {object[]} [events]
   * @returns {{ok:boolean, reason?:string, win?:boolean, draw?:boolean, resign?:boolean}}
   */
  applyGomokuIntent(playerId, data, events) {
    const evts = events || [];
    const g = this._gomokuSyncSeats();
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
      const alive = (g.seats || []).filter((pid) => !(this.players[pid] && this.players[pid].lost));
      if (alive.length <= 1) this._gomokuFinish(alive[0] != null ? alive[0] : null, 'resign', null, evts);
      else this._gomokuAdvance();
      return { ok: true, resign: true };
    }

    // 落子（每手 1 子）
    // 坐标必须是**有限整数**：拒绝 NaN / Infinity / 浮点（否则 `lx|0` 会静默截断为合法格）。
    if (!Number.isInteger(data.lx) || !Number.isInteger(data.ly)) return { ok: false, reason: 'bad_move' };
    const x = data.lx | 0, y = data.ly | 0;
    const size = g.size;
    if (!inBounds(size, x, y)) return { ok: false, reason: 'oob' };
    const k = idx(size, x, y);
    if (g.board[k] === GOMOKU_WALL) return { ok: false, reason: 'wall' };   // 编辑器形状外/虚空 → 不可落子
    if (g.board[k] !== 0) return { ok: false, reason: 'occupied' };

    const f = g.turn;
    g.board[k] = f;
    g.moveNo++;
    g.lastMove = { x, y, f };
    g.moveLog.push({ n: g.moveNo, f, x, y });
    evts.push({ type: 'gomoku_move', playerId, lx: x, ly: y, faction: f, moveNo: g.moveNo });

    const line = checkWinAt(g.board, size, x, y);
    if (line) { this._gomokuFinish(playerId, 'five', line, evts); return { ok: true, win: true }; }
    // 平局 = 棋盘上再无任何可落的**非墙**空点（墙格不计入"下满"）。
    // board=null（无墙）时等价于旧判定 `moveNo >= size²`，行为逐字节不变。
    if (this._gomokuNoEmpty()) { this._gomokuFinish(null, 'draw', null, evts); return { ok: true, draw: true }; }

    this._gomokuAdvance();
    return { ok: true };
  },

  /**
   * 若当前行动方是 AI（或掉线代打），则落一手。由 1Hz tick 调用。
   * @param {object[]} events
   * @returns {boolean} 是否由 AI 完成了一手（含"无子可下 → 认输"）
   */
  _gomokuMaybeAIMove(events) {
    const g = this._gomokuSyncSeats();
    if (g.result || (g.seats || []).length === 0) return false;
    const pid = g.seats[g.turnIdx];
    const p = pid != null ? this.players[pid] : null;
    if (!p || p.lost) return false;
    if (!(p.isAI === true || p.botControlled === true)) return false;
    const mv = bestGomokuMove(this);
    if (!mv) {   // 无空位（理论上盘满已终局）→ 当前 AI 认输，绝不阻塞
      p.lost = true; p.lostReason = 'no_move';
      const alive = (g.seats || []).filter((id) => !(this.players[id] && this.players[id].lost));
      if (alive.length <= 1) this._gomokuFinish(alive[0] != null ? alive[0] : null, 'no_move', null, events);
      return true;
    }
    this.applyGomokuIntent(pid, { lx: mv.x, ly: mv.y }, events);
    return true;
  },

  /**
   * 五子棋 1 秒计时步进：推进计时，轮到 AI 时自动出手。
   * @param {object[]} [events]
   * @returns {{events:object[], tickMs:number}}
   */
  _gomokuTick(events) {
    const evts = events || [];
    const g = this._gomokuSyncSeats();
    if (g.result) { this.events = []; return { events: [], tickMs: 0 }; }
    this.tick++;
    g.turnTicks++;
    this._gomokuMaybeAIMove(evts);
    this.events = evts;
    return { events: evts, tickMs: 0 };
  },

  /** 五子棋快照切片（注入 engine.snapshot() 的 mode 字段）。 */
  _gomokuSnapshot() {
    const g = this._gomokuSyncSeats();
    const turnPid = g.seats[g.turnIdx] != null ? g.seats[g.turnIdx] : null;
    const seats = (g.seats || []).map((pid, i) => {
      const p = this.players[pid];
      return {
        playerId: pid,
        name: p ? p.name : String(pid),
        color: p ? p.color : '#888',
        isAI: !!(p && p.isAI),
        botControlled: !!(p && p.botControlled),
        lost: !!(p && p.lost),
        faction: g.seatF[i],
        isTurn: pid === turnPid,
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
      lastMove: g.lastMove,
      phase: g.result ? 'over' : 'play',
      win: GOMOKU_WIN,
      result: g.result ? { ...g.result, winnerName } : null,
    };
  },
};

// ---------------- 模式插件契约 ----------------

const def = {
  id: 'gomoku',
  label: '五子棋',
  tickDriver: 'interval',   // 回合制：1Hz 计时循环驱动（无 20 TPS tick）
  intervalMs: 1000,
  boardMax: 128,            // 可设 1..128（默认仍 15，见 boardDefault）
  maxSeats: 2,              // 五子棋恒为 2 席（黑/白）；主干据此拒绝第 3 席（人类或电脑）
  growLifeLayer: false,     // 自带棋盘，不扩容 rts 生命层
  availableVictoryLines: ['territory'],

  // 首次加载：把 _gomoku* 方法族挂到 World.prototype（mixin，只挂自己的方法）。
  install(World) {
    const P = World.prototype;
    P._gomokuInit = proto._gomokuInit;
    P._gomokuSyncSeats = proto._gomokuSyncSeats;
    P._gomokuSeat = proto._gomokuSeat;
    P._gomokuAdvance = proto._gomokuAdvance;
    P._gomokuNoEmpty = proto._gomokuNoEmpty;
    P._gomokuFinish = proto._gomokuFinish;
    P.applyGomokuIntent = proto.applyGomokuIntent;
    P._gomokuMaybeAIMove = proto._gomokuMaybeAIMove;
    P._gomokuTick = proto._gomokuTick;
    P._gomokuSnapshot = proto._gomokuSnapshot;
    World.GOMOKU_SIZE = GOMOKU_SIZE;
    World.GOMOKU_WIN = GOMOKU_WIN;
    World.GOMOKU_WALL = GOMOKU_WALL;
  },

  // 模拟步进：interval 的一步 = 先 AI（轮到 AI 时出手）→ 再推进计时（turnTicks++）。
  // 主干 1Hz 循环按注册表调用（优先 intervalStep，回退 tick）；返回 { changed:true } 触发广播。
  tick(engine, events) {
    engine._gomokuTick(events);
    return { changed: true, events: events || [] };
  },

  // 玩家加入：就座、跳过 rts 出生点资源（五子棋只要一个空盘）。
  onAddPlayer(engine, p) {
    engine.players[p.id] = p;
    p.gomokuTimeouts = 0;
    engine._gomokuSeat(p);
    if (engine.hostId == null) engine.hostId = p.id;
  },
  onAddAI(engine, ai) {
    ai.gomokuTimeouts = 0;
    engine._gomokuSeat(ai);
  },

  // 意图路由：只消费 {gomoku:{...}}；其余意图 silent（不入 rts 队列、不广播）。
  routeIntent(engine, pid, intent, events) {
    if (!(intent && intent.gomoku && typeof intent.gomoku === 'object')) {
      return { handled: true, silent: true };
    }
    let r;
    try { r = engine.applyGomokuIntent(pid, intent.gomoku, events); }
    catch (e) { return { handled: true, result: { ok: false, reason: 'gomoku_intent_failed' } }; }
    if (!r.ok && r.reason && r.reason !== 'oob') {
      const gi = intent.gomoku || {};
      if (typeof gi.lx === 'number' && typeof gi.ly === 'number') {
        events.push({ type: 'gomoku_reject', reason: String(r.reason), lx: gi.lx | 0, ly: gi.ly | 0, playerId: pid });
      }
    }
    return { handled: true, result: r };
  },

  snapshot(engine) { return engine._gomokuSnapshot(); },
};

registerMode(def);
export default def;
