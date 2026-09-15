// server/go.js — 回合制模式（go）专属逻辑隔离
//
// 本文件把"回合制 · 演化棋"的全部逻辑从 engine.js 中抽离，避免主引擎膨胀。
// 设计要点（见 docs/go-mode-arch.md）：
//   1) 铁律：算法是世界法则，单位是涌现。本模式**不新增任何命名单位**；
//      "会行走的图案 / 振荡图案"只是**现象**，仅给目数与提示，不生成实体、不进 EMERGENTS。
//   2) 模拟内**禁用** Math.random() / Date.now()：一切随机走 this._rng（种子化 mulberry32）。
//   3) rts 路径逐字节不变：本文件所有方法只在 mode === 'go' 时被调用，不改动任何 rts 行为。
//
// 实现方式：以 mixin 形式把方法挂到 World.prototype（installGoMode(World)），
// engine.js 在文件末尾调用一次。这样 engine.js 无需 import 本文件的方法，避免循环依赖。

const NEI4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEI8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

// 世界事件档位（4 态，由 markov_chain 抽取）。0 正常 / 1 繁盛 / 2 寒潮 / 3 拥挤突变
const GO_EVENTS = ['calm', 'flourish', 'frost', 'mutate'];

/**
 * 把 go 模式的方法族安装到 World 类上。
 * @param {Function} World World 类（engine.js 导出）
 */
export function installGoMode(World) {
  const P = World.prototype;

  // ---------- 常量（挂在 World 上，供 engine / net / 测试统一引用） ----------
  World.GO_BOARD_W = 32;            // 与 World.LIFE_W 一致（断言相等）
  World.GO_TURN_MS = 30000;         // 每手上限（毫秒）
  World.GO_MAX_MOVES = 150;         // 手数上限
  World.GO_PASS_END = 2;            // 连续 pass 终局
  World.GO_MAX_TIMEOUTS = 3;        // 累计超时判负
  World.GO_BREATH = [3, 4, 5];      // 影响半径呼吸取值（R ∈ {3,4,5}）
  World.GO_BREATH_EVERY = 10;       // 每 10 手呼吸一次
  World.GO_EVENT_EVERY = 25;        // 每 25 手世界事件一次
  World.GO_PATTERN_MAX_SIZE = 12;   // 图案奖：只检查团大小 ≤ 12 的团

  // ---------- 状态容器 ----------

  /**
   * 惰性初始化 go 模式状态容器。
   * N 方（2..8）：seats = 就座顺序（= 行动顺序），每人一个 faction（1..8）。
   * 注意：不调用 _seedOnboarding / _genResources（go 只要一个空棋盘）。
   * @returns {object} this.go
   */
  P._goInit = function _goInit() {
    if (this.go) return this.go;
    this._lifeInit();
    if (!this.goSeatIds) this.goSeatIds = [];
    const seats = this.goSeatIds.filter(id => this.players && this.players[id]);
    const seatF = seats.map(id => this._factionOf(id));
    this.go = {
      seats,                          // [playerId, ...] 行动顺序
      seatF,                          // 与 seats 平行的 faction 数组
      turnIdx: 0,                     // 当前行动者在 seats 中的下标
      turn: seatF.length ? seatF[0] : 0,
      // 兼容字段（两方局语义：blackF = 首座，whiteF = 次座；多方局以 seats 为准）
      blackF: seatF[0] != null ? seatF[0] : 0,
      whiteF: seatF[1] != null ? seatF[1] : 0,
      blackId: seats[0] != null ? seats[0] : null,
      whiteId: seats[1] != null ? seats[1] : null,
      passStreak: 0,
      _turnInitialized: seatF.length > 0,
      moveNo: 1,
      turnTicks: 0,                   // 已用 tick（_goTick 每秒 +1）
      passes: 0,                      // 连续 pass 计数（全员各 pass 一次 → 终局）
      ko: null,                       // {lx, ly} 劫禁着点
      prevPos: null,                  // 上一手之后的棋盘快照（保留字段，兼容快照/调试）
      _oneAgo: null,                  // 上一手落子之前的棋盘
      _twoAgo: null,                  // 两拍前（用于简单劫判定）
      breathState: 0,
      _breathR: World.GO_BREATH[0],
      eventState: 0,
      _evt: null,                     // 本回合世界事件档位（0 = 正常）
      lastEvent: null,
      lastPlaced: null,               // {x,y} 本回合最后落下一颗（兼容字段）
      lastPlacedKeys: new Set(),      // 本回合**全部**刚落下的格子（key=x*W+y），演化当回合豁免死亡
      placedThisTurn: 0,              // 本回合当前行动方已落下的棋子数（用于 stonesLeft 语义）
      scoredPatterns: [],             // 已发奖图案签名（去重）
      result: null,                   // 终局结算
      moveLog: [],                    // [{n,f,lx,ly,captured}] 供复盘
    };
    return this.go;
  };

  /**
   * 把 goSeatIds 同步到 g.seats（支持**中途加入**与中途移除）。
   * 幂等；行动顺序保持在同一个玩家身上（该玩家还在座则 continue，否则顺延）。
   * @returns {object} this.go
   */
  P._goSyncSeats = function _goSyncSeats() {
    this._lifeInit();
    const g = this._goInit();
    if (!this.goSeatIds) this.goSeatIds = [];
    const prevTurnId = (g.seats && g.seats[g.turnIdx] != null) ? g.seats[g.turnIdx] : null;
    const prevSeats = g.seats || [];
    const ids = this.goSeatIds.filter(id => this.players && this.players[id]);
    // 座位集合是否变化（中途加入/离开）→ 只有变化时才重置连续 pass 计数，
    // 否则每次换手都会把 passStreak 清零，"全员 pass 终局"永远无法达成。
    const changed = ids.length !== prevSeats.length || ids.some((id, i) => prevSeats[i] !== id);
    g.seats = ids;
    g.seatF = ids.map(id => this._factionOf(id));
    g.blackF = g.seatF[0] != null ? g.seatF[0] : 0;
    g.whiteF = g.seatF[1] != null ? g.seatF[1] : 0;
    g.blackId = ids[0] != null ? ids[0] : null;
    g.whiteId = ids[1] != null ? ids[1] : null;
    let idx = prevTurnId != null ? ids.indexOf(prevTurnId) : -1;
    if (idx < 0) idx = Math.min(g.turnIdx || 0, Math.max(0, ids.length - 1));
    g.turnIdx = Math.max(0, idx);
    g.turn = g.seatF[g.turnIdx] != null ? g.seatF[g.turnIdx] : 0;
    if (ids.length > 0) g._turnInitialized = true;
    // 同步兼容字段（旧两方语义）
    this.goBlackId = ids[0] != null ? ids[0] : this.goBlackId;
    this.goWhiteId = ids[1] != null ? ids[1] : this.goWhiteId;
    // 新加入者尚未 pass：座位变化时重置连续 pass 计数，避免"新玩家一进来就终局"
    if (changed) g.passStreak = 0;
    if (g.passStreak == null) g.passStreak = 0;
    return g;
  };

  // ---------- 4-邻气 / 提子（正统围棋语义，不复用 _captureEnclosed） ----------

  /**
   * 返回 (x,y) 所在 4-连通同色团的 4-邻空点数（"气"）。
   * 与 _captureEnclosed 的关键差异：只用 4 邻域数**空点**，不把己方细胞也算作气。
   * @returns {number} 气数（0 = 无气）
   */
  P._goLiberties = function _goLiberties(x, y) {
    const L = this._life, W = World.LIFE_W;
    const f = L[x][y];
    if (!f) return 0;
    const seen = new Set();
    const stack = [[x, y]];
    let libs = 0;
    seen.add(x * W + y);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      for (const [dx, dy] of NEI4) {
        const nx = cx + dx, ny = cy + dy;
        if (this._isWall(nx, ny)) continue;
        const key = nx * W + ny;
        if (seen.has(key)) continue;
        const v = L[nx][ny];
        if (v === 0) { seen.add(key); libs++; }
        else if (v === f) { seen.add(key); stack.push([nx, ny]); }
      }
    }
    return libs;
  };

  /**
   * 提掉 (x,y) 所在 4-连通同色团（前提：该团无气）。
   * @returns {number} 被提格数（0 = 未提，因为该团尚有气或该点为空）
   */
  P._goTryCapture = function _goTryCapture(x, y) {
    const L = this._life, W = World.LIFE_W;
    const f = L[x][y];
    if (!f) return 0;
    if (this._goLiberties(x, y) !== 0) return 0;
    const seen = new Set();
    const stack = [[x, y]];
    const comp = [];
    seen.add(x * W + y);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      comp.push([cx, cy]);
      for (const [dx, dy] of NEI4) {
        const nx = cx + dx, ny = cy + dy;
        if (this._isWall(nx, ny)) continue;
        const key = nx * W + ny;
        if (!seen.has(key) && L[nx][ny] === f) { seen.add(key); stack.push([nx, ny]); }
      }
    }
    for (const [cx, cy] of comp) L[cx][cy] = 0;
    return comp.length;
  };

  // ---------- 一手棋 ----------

  /**
   * 棋盘快照（拍平成 Uint8Array 的列数组），供劫判定比较。
   * @returns {Uint8Array[]}
   */
  P._goSnapshot = function _goSnapshot() {
    return this._life.map(col => Uint8Array.from(col));
  };

  /**
   * 比较两份棋盘快照是否完全相同。
   * @returns {boolean}
   */
  P._goSameAs = function _goSameAs(a, b) {
    if (!a || !b) return false;
    const W = World.LIFE_W;
    for (let x = 0; x < W; x++) {
      const ca = a[x], cb = b[x];
      for (let y = 0; y < W; y++) if (ca[y] !== cb[y]) return false;
    }
    return true;
  };

  /**
   * 计算 (lx,ly) 所在团的相对坐标签名（用于图案去重 / 振荡检测）。
   * 签名 = 团内各格相对包围盒最小角的坐标拼串。
   * @returns {string} 形如 "0,0|1,0|1,1"
   */
  P._goGroupSig = function _goGroupSig(lx, ly) {
    const L = this._life, W = World.LIFE_W;
    const f = L[lx][ly];
    if (!f) return null;
    const seen = new Set([lx * W + ly]);
    const stack = [[lx, ly]];
    const comp = [];
    let minX = lx, minY = ly;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      comp.push([cx, cy]);
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      for (const [dx, dy] of NEI4) {
        const nx = cx + dx, ny = cy + dy;
        if (this._isWall(nx, ny)) continue;
        const key = nx * W + ny;
        if (!seen.has(key) && L[nx][ny] === f) { seen.add(key); stack.push([nx, ny]); }
      }
    }
    comp.sort((a, b) => (a[0] - minX) - (b[0] - minX) || (a[1] - minY) - (b[1] - minY));
    return comp.map(([cx, cy]) => (cx - minX) + ',' + (cy - minY)).join('|');
  };

  /**
   * 落一子（含提子 / 禁自杀 / 劫）。原子结算，失败自动回滚。
   * @param {number} f 阵营（1=黑，2=白）
   * @param {number} lx 生命格 x
   * @param {number} ly 生命格 y
   * @param {object[]} events 事件收集数组
   * @returns {{ok:boolean, captured?:number, reason?:string}}
   */
  /**
   * 单子落子（兼容旧接口）：内部走批处理 `_goPlayBatch`，只下一颗。
   * @param {number} f 阵营
   * @param {number} lx 生命格 x
   * @param {number} ly 生命格 y
   * @param {object[]} events
   * @returns {{ok:boolean, captured?:number, placed?:number, reason?:string}}
   */
  P._goPlay = function _goPlay(f, lx, ly, events) {
    return this._goPlayBatch(f, [{ lx, ly }], events);
  };

  /**
   * 一回合落**多颗**棋子（需求返工 2026-09-10）。结算顺序：
   *   ① 校验整批（在盘内、整数、互不重复、目标为空、非劫禁着）
   *   ② 一次性落下全部棋子
   *   ③ 统一结算提子（4 邻无气敌团整团清除；提子优先于自杀）
   *   ④ 把整批当成一个整体判断自杀：整批落完后若**全部**落点仍无气、且未提掉任何敌子 → 非法回滚
   *   ⑤ 单子批保留原"劫"判定；多子批不设劫禁着（避免复杂状态，语义见报告）
   * @param {number} f 阵营
   * @param {Array<{lx:number,ly:number}>} moves 本批落点（1..stonesPerTurn，互不重复）
   * @param {object[]} events
   * @returns {{ok:boolean, captured?:number, placed?:number, reason?:string}}
   */
  P._goPlayBatch = function _goPlayBatch(f, moves, events) {
    const g = this._goInit();
    const L = this._life, W = World.LIFE_W;
    if (!Array.isArray(moves) || moves.length === 0) return { ok: false, reason: 'bad_move' };
    if (moves.length > this.stonesPerTurn) return { ok: false, reason: 'too_many_stones' };
    // ① 校验整批（原子性：任一非法则整批拒绝，棋盘不变）
    const seen = new Set();
    for (const m of moves) {
      if (!m || typeof m.lx !== 'number' || typeof m.ly !== 'number') return { ok: false, reason: 'bad_move' };
      const lx = m.lx | 0, ly = m.ly | 0;
      // 形状/虚空感知：越界 ∪ 形状外 ∪ 虚空 → 不可落子（统一复用 oob，前端零改动）。
      if (this._isWall(lx, ly)) return { ok: false, reason: 'oob' };
      const key = lx * W + ly;
      if (seen.has(key)) return { ok: false, reason: 'duplicate' };
      seen.add(key);
      if (L[lx][ly] !== 0) return { ok: false, reason: 'occupied' };
      if (g.ko && g.ko.lx === lx && g.ko.ly === ly) return { ok: false, reason: 'ko' };
    }
    const before = this._goSnapshot();   // 落子前棋盘（供诊断/劫判定保留）
    // ② 一次性落下全部棋子
    const pts = moves.map(m => ({ lx: m.lx | 0, ly: m.ly | 0 }));
    for (const p of pts) L[p.lx][p.ly] = f;
    // ③ 统一结算提子：对本批**所有落点** 4 邻的敌方团，无气则整团清除（去重，避免重复提）
    let captured = 0;
    const tried = new Set();
    for (const p of pts) {
      for (const [dx, dy] of NEI4) {
        const nx = p.lx + dx, ny = p.ly + dy;
        if (this._isWall(nx, ny)) continue;
        const v = L[nx][ny];
        if (!v || v === f) continue;
        const k = nx * W + ny;
        if (tried.has(k)) continue;
        tried.add(k);
        captured += this._goTryCapture(nx, ny);
      }
    }
    // ④ 整批自杀判定：未提子，且**全部**落点所在团都无气 → 非法，整批回滚
    if (captured === 0) {
      let anyLib = false;
      for (const p of pts) if (this._goLiberties(p.lx, p.ly) > 0) { anyLib = true; break; }
      if (!anyLib) {
        for (const p of pts) L[p.lx][p.ly] = 0;
        return { ok: false, reason: 'suicide' };
      }
    }
    // ⑤ 劫判定：仅在"单子批"下沿用标准简单劫（多子批不设劫禁着）
    g.ko = null;
    if (pts.length === 1) {
      const p = pts[0];
      if (captured === 1 && this._goLiberties(p.lx, p.ly) === 1) {
        const lone = this._goLoneLiberty(p.lx, p.ly);
        if (lone && L[lone.lx][lone.ly] === 0) g.ko = { lx: lone.lx, ly: lone.ly };
      }
    }
    g._oneAgo = before;
    g.prevPos = before;
    g.lastPlaced = { x: pts[pts.length - 1].lx, y: pts[pts.length - 1].ly };
    g.lastPlacedKeys = new Set(pts.map(p => p.lx * W + p.ly));
    const pid = this._lifeOwners[f - 1] != null ? this._lifeOwners[f - 1] : null;
    const lastPt = pts[pts.length - 1];
    // 兼容旧字段 lx/ly（= 本批最后一颗），并新增 pts 数组（本批全部落点）。
    g.moveLog.push({ n: g.moveNo, f, lx: lastPt.lx, ly: lastPt.ly, pts: pts.map(p => ({ lx: p.lx, ly: p.ly })), captured });
    if (events) {
      for (const p of pts) {
        events.push({ type: 'go_move', playerId: pid, lx: p.lx, ly: p.ly, captured, moveNo: g.moveNo });
      }
    }
    return { ok: true, captured, placed: pts.length };
  };

  /**
   * 找到 (x,y) 所在团唯一的气点（仅当恰好 1 口气时返回该点坐标）。
   * @returns {{lx:number, ly:number}|null}
   */
  P._goLoneLiberty = function _goLoneLiberty(x, y) {
    const L = this._life, W = World.LIFE_W;
    const f = L[x][y];
    if (!f) return null;
    const seen = new Set([x * W + y]);
    const stack = [[x, y]];
    const libs = [];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      for (const [dx, dy] of NEI4) {
        const nx = cx + dx, ny = cy + dy;
        if (this._isWall(nx, ny)) continue;
        const key = nx * W + ny;
        if (seen.has(key)) continue;
        const v = L[nx][ny];
        if (v === 0) { seen.add(key); libs.push({ lx: nx, ly: ny }); }
        else if (v === f) { seen.add(key); stack.push([nx, ny]); }
      }
    }
    return libs.length === 1 ? libs[0] : null;
  };

  // ---------- 康威演化（阵营感知 B3/S23） ----------

  /**
   * 跑本回合演化（受世界事件档位影响）。
   * @param {number} mode 0 正常 / 1 繁盛(2~3 步) / 2 寒潮(0 步) / 3 拥挤突变(诞生阈值 5)
   * @param {object[]} events
   */
  P._goEvolve = function _goEvolve(mode = 0, events) {
    const bornThresh = mode === 3 ? 5 : 3;               // 拥挤突变 → 诞生阈值改 5
    // 步数：正常 1 步 / 寒潮 0 步 / 繁盛 2~3 步（FIX-6：用种子化 RNG 在 2/3 间选，
    // 让"内容不可预期"更明显 —— 必须仍走 this._rng()，禁 Math.random）。
    let steps;
    if (mode === 1) steps = this._rng() < 0.5 ? 2 : 3;   // 繁盛：2 或 3 步
    else if (mode === 2) steps = 0;                      // 寒潮：暂停演化
    else steps = 1;                                      // 正常
    if (steps === 0) {
      if (events) events.push({ type: 'go_evolve', mode, steps: 0 });
      return;
    }
    for (let s = 0; s < steps; s++) this._goEvolveOnce(bornThresh);
    if (events) events.push({ type: 'go_evolve', mode, steps });
  };

  /**
   * 演化一步（写入 this._life，非环形边界：越界视为死区）。
   * 规则：存活 n===2||n===3；诞生 n===bornThresh 且阵营取 8 邻多数派（平票掷 this._rng）；
   *      本回合刚落的子豁免死亡。
   * @param {number} bornThresh 诞生阈值
   */
  P._goEvolveOnce = function _goEvolveOnce(bornThresh) {
    const L = this._life, W = World.LIFE_W;
    const g = this.go, jp = g && g.lastPlacedKeys;
    const next = Array.from({ length: W }, () => new Int8Array(W));
    // 死亡宽限网格（与 rts 共用同一语义）：-1 未获宽限；>=0 剩余宽限步数。
    const doom = this._lifeDoom || Array.from({ length: W }, () => new Int8Array(W).fill(-1));
    const doomNext = Array.from({ length: W }, () => new Int8Array(W).fill(-1));
    // 阵营计数槽：1..8（多方局最多 8 方）。索引 0 恒为 0（空格不算阵营）。
    const cnt = new Array(9).fill(0);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        // 形状/虚空感知（★必须新增段落，呼应 PRD G7）：格子自身若是「虚空 / 形状外」→
        // next=0 且永不诞生（否则邻近细胞会在 n===bornThresh 时把棋盘外的格"诞生"出棋子）。
        // board=null 时该分支不进入（逐字节不变）。
        if (this._bmp && this._isWall(x, y)) { next[x][y] = 0; doomNext[x][y] = -1; continue; }
        let n = 0;
        for (let i = 0; i < 9; i++) cnt[i] = 0;
        for (const [dx, dy] of NEI8) {
          const nx = x + dx, ny = y + dy;
          // 非环形边界：越界 / 形状外 / 虚空视为死区（围棋棋盘有天然边界，环形会让"角"失去意义）
          if (this._isWall(nx, ny)) continue;
          const v = L[nx][ny];
          if (v > 0 && v < cnt.length) { n++; cnt[v]++; }
        }
        const cur = L[x][y];
        if (cur) {
          // 本回合刚落的子豁免死亡（你这手不会被自己这手的演化撤销）；
          // 豁免只作用于**本回合**，下一回合起必须满足标准规则（或消耗死亡宽限）。
          if (jp && jp.has(x * W + y)) { next[x][y] = cur; continue; }
          // 需求返工（2026-09-10）：取消"孤子不死"设计，恢复标准康威 B3/S23 ——
          //   n===2||n===3 存活，否则死亡（除非房主设置了死亡宽限 lonelyDeathDelay）。
          let alive = (n === 2 || n === 3);
          // 死亡宽限：无法存活的棋子先撑 lonelyDeathDelay 个回合再死（delay=0 即立即死）。
          if (!alive) {
            let d = doom[x][y];
            if (d < 0) d = this.lonelyDeathDelay;
            if (d > 0) { alive = true; doomNext[x][y] = d - 1; }
            else doomNext[x][y] = -1;
          } else {
            doomNext[x][y] = -1;
          }
          next[x][y] = alive ? cur : 0;
        } else if (n === bornThresh) {
          // 阵营取 8 邻多数派（1..8）。
          // ⚠ 平票在默认 bornThresh=3 时数学上不可达（两方计数之和为奇数 → 恒不相等）；
          //   多方局下同样由"多数派严格占优"决定。此处保留平票掷种子分支仅为通用性，
          //   真正的不可预测性来自「呼吸 + 世界事件 + 演化混沌」三层。
          let bestF = 0, bestC = 0, tie = false;
          for (let fi = 1; fi < cnt.length; fi++) {
            if (cnt[fi] > bestC) { bestC = cnt[fi]; bestF = fi; tie = false; }
            else if (cnt[fi] === bestC && cnt[fi] > 0) tie = true;
          }
          if (tie && bestF > 0) {
            // 平票：只在并列的阵营里用种子化 RNG 掷（确定性，非 Math.random）
            const cands = [];
            for (let fi = 1; fi < cnt.length; fi++) if (cnt[fi] === bestC && cnt[fi] > 0) cands.push(fi);
            bestF = cands[Math.floor(this._rng() * cands.length)] || bestF;
          }
          next[x][y] = bestF;
        } else {
          next[x][y] = 0;
        }
      }
    }
    this._life = next;
    this._lifeDoom = doomNext;
  };

  // ---------- 呼吸 + 世界事件（内核 markov_chain 驱动） ----------

  /** 影响半径呼吸：breathState ∈ {0,1,2} → _breathR ∈ {3,4,5}。每 10 手一次。 */
  P._goBreathe = function _goBreathe() {
    const g = this.go;
    const fn = World.kernelRegistry && World.kernelRegistry.get('markov_chain');
    if (fn) {
      const r = fn(null, this._rng, {
        state: g.breathState, states: 3,
        mat: [[0.6, 0.3, 0.1], [0.3, 0.4, 0.3], [0.1, 0.3, 0.6]],
        steps: 1,
      });
      g.breathState = r.state;
    } else {
      g.breathState = (g.breathState + 1) % 3;
    }
    g._breathR = World.GO_BREATH[g.breathState] != null ? World.GO_BREATH[g.breathState] : World.GO_BREATH[0];
    return g._breathR;
  };

  /**
   * 世界事件抽签：4 态（0 正常 / 1 繁盛 / 2 寒潮 / 3 拥挤突变）。每 25 手一次。
   * @returns {number} 本回合事件档位
   */
  P._goWorldEvent = function _goWorldEvent() {
    const g = this.go;
    const fn = World.kernelRegistry && World.kernelRegistry.get('markov_chain');
    let st = 0;
    if (fn) {
      const r = fn(null, this._rng, {
        state: g.eventState, states: 4,
        mat: [
          [0.5, 0.2, 0.2, 0.1],
          [0.3, 0.3, 0.2, 0.2],
          [0.3, 0.2, 0.3, 0.2],
          [0.2, 0.2, 0.2, 0.4],
        ],
        steps: 1,
      });
      st = r.state;
    } else {
      st = (g.eventState + 1) % 4;
    }
    g.eventState = st;
    g._evt = st;
    g.lastEvent = GO_EVENTS[st] || 'calm';
    return g._evt;
  };

  // ---------- 图案奖（现象，不命名、不生成实体） ----------

  /**
   * 扫描盘面上的"会行走的图案"与"振荡图案"，一次性 +5 / +2 目。**按阵营**累加（支持 2..8 方）。
   * 同一签名只奖一次（g.scoredPatterns 去重）。
   * @returns {{byF:Object<number,number>, black:number, white:number, hits:object[]}}
   */
  P._goPatternBonus = function _goPatternBonus() {
    const g = this._goInit();
    const L = this._life, W = World.LIFE_W;
    const maxSize = World.GO_PATTERN_MAX_SIZE;
    const byF = Object.create(null);
    const out = { byF, black: 0, white: 0, hits: [] };
    // 按实际在座 faction 建槽，并在写入选槽时兜底（防任何来源的 faction 值导致 undefined.push 崩溃）
    const sigs = {};
    for (const f of (g.seatF || [])) sigs[f] = [];
    sigs[g.blackF] = sigs[g.blackF] || [];
    sigs[g.whiteF] = sigs[g.whiteF] || [];
    // 遍历所有棋子团（4-连通），记录签名与"能否整体平移 1 格仍全活"
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        const f = L[x][y];
        if (!f) continue;
        // 只从"团的最上最左格"出发，避免重复
        if ((x > 0 && L[x - 1][y] === f) || (y > 0 && L[x][y - 1] === f)) continue;
        const seen = new Set([x * W + y]);
        const stack = [[x, y]];
        const comp = [];
        let size = 0;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          comp.push([cx, cy]);
          size++;
          for (const [dx, dy] of NEI4) {
            const nx = cx + dx, ny = cy + dy;
            if (this._isWall(nx, ny)) continue;
            const key = nx * W + ny;
            if (!seen.has(key) && L[nx][ny] === f) { seen.add(key); stack.push([nx, ny]); }
          }
        }
        if (size > maxSize) continue;
        let minX = Infinity, minY = Infinity;
        for (const [cx, cy] of comp) { if (cx < minX) minX = cx; if (cy < minY) minY = cy; }
        const sig = comp
          .map(([cx, cy]) => (cx - minX) + ',' + (cy - minY))
          .sort()
          .join('|');
        // 会行走的图案：3 格拐角形（平移 1 格后仍是 3 格活细胞）
        const walkable = size === 3 && this._goCanShift(comp, minX, minY, f);
        // 振荡图案：横/纵 3 格一线（周期翻转的最小振荡子）
        const osc = size === 3 && this._goIsOscillator(comp, f);
        // FIX-C1②：sigs[f] 兜底 —— 即使 faction 回收修好了，也能防御"其它来源 faction 值"，防同类崩溃复发。
        (sigs[f] || (sigs[f] = [])).push({ f, sig, walkable, osc, minX, minY });
      }
    }
    // 去重发奖（**按阵营**计分：任何在座阵营都计，非在座阵营不计分）
    const scored = g.scoredPatterns;
    const seenSet = new Set(scored);
    const award = (f, pts) => {
      if (!f) return false;
      // 只有"在座"的阵营才计分（防幽灵 faction 白拿分）
      if (g.seatF && g.seatF.indexOf(f) === -1 && f !== g.blackF && f !== g.whiteF) return false;
      byF[f] = (byF[f] || 0) + pts;
      if (f === g.blackF) out.black += pts;
      else if (f === g.whiteF) out.white += pts;
      return true;
    };
    for (const grp of Object.values(sigs)) {
      for (const sg of grp) {
        if (sg.walkable) {
          const key = 'W:' + sg.sig;
          if (!seenSet.has(key)) {
            seenSet.add(key); scored.push(key);
            award(sg.f, 5);
            out.hits.push({ kind: 'walk', f: sg.f });
          }
        }
        if (sg.osc) {
          const key = 'O:' + sg.sig;
          if (!seenSet.has(key)) {
            seenSet.add(key); scored.push(key);
            award(sg.f, 2);
            out.hits.push({ kind: 'osc', f: sg.f });
          }
        }
      }
    }
    return out;
  };

  /**
   * 判断一个 3 格团是否能"整体平移 1 格后仍全部为活细胞"（会行走的图案）。
   * 采用 4 邻平移（上/下/左/右），只要有一个方向平移后 3 格都在盘内且非空即可。
   * @returns {boolean}
   */
  P._goCanShift = function _goCanShift(comp, minX, minY, f) {
    const L = this._life, W = World.LIFE_W;
    void minX; void minY;
    for (const [dx, dy] of NEI4) {
      let ok = 0;
      for (const [cx, cy] of comp) {
        const nx = cx + dx, ny = cy + dy;
        if (this._isWall(nx, ny)) break;
        if (L[nx][ny] !== 0) { ok++; }
      }
      if (ok === comp.length) return true;
    }
    return false;
  };

  /**
   * 判断一个 3 格团是否是横/纵一线的"振荡图案"原型。
   * @returns {boolean}
   */
  P._goIsOscillator = function _goIsOscillator(comp) {
    if (comp.length !== 3) return false;
    const xs = comp.map(c => c[0]).sort((a, b) => a - b);
    const ys = comp.map(c => c[1]).sort((a, b) => a - b);
    const straightX = ys[0] === ys[2];                     // 横向一线
    const straightY = xs[0] === xs[2];                     // 纵向一线
    const contiguous = xs[2] - xs[0] <= 2 && ys[2] - ys[0] <= 2;
    return (straightX || straightY) && contiguous;
  };

  // ---------- 领地与计分 ----------

  /**
   * 目数 = Voronoi 归属格数（含呼吸半径）+ 图案奖。**按阵营**统计（支持 2..8 方）。
   * @returns {{byF:Object<number,number>, black:number, white:number, bonus:object, ranked:object[]}}
   */
  P._goScore = function _goScore() {
    const g = this._goInit();
    const W = World.LIFE_W;
    // 呼吸半径：rts 传 undefined 走原纪元逻辑；go 传数字统一半径
    this._updateVoronoi(g._breathR);
    const own = this._lifeOwner;
    const byF = Object.create(null);
    let b = 0, w = 0;
    for (let x = 0; x < W; x++) {
      const col = own[x];
      for (let y = 0; y < W; y++) {
        const o = col[y];
        if (!o) continue;
        byF[o] = (byF[o] || 0) + 1;
        if (o === g.blackF) b++;
        else if (o === g.whiteF) w++;
      }
    }
    const bonus = this._goPatternBonus();
    for (const f in bonus.byF) {
      byF[f] = (byF[f] || 0) + bonus.byF[f];
      if (+f === g.blackF) b += bonus.byF[f];
      else if (+f === g.whiteF) w += bonus.byF[f];
    }
    // 各方排名（仅统计在座阵营）
    const ranked = (g.seats || []).map((pid, i) => {
      const f = g.seatF[i];
      const p = this.players[pid];
      return {
        playerId: pid, faction: f,
        name: p ? p.name : String(pid),
        isAI: !!(p && p.isAI), botControlled: !!(p && p.botControlled),
        lost: !!(p && p.lost),
        territory: byF[f] || 0,
      };
    }).sort((a, bb) => bb.territory - a.territory);
    return { byF, black: b, white: w, bonus, ranked };
  };

  // ---------- 中国规则数子（子数 + 围住的空点数）· 终局胜负依据 ----------

  /**
   * 4-邻浮空围空（**严格围空口径**）：把盘面所有"连通空区"用洪水填充找出，按 4-邻接触到的阵营去重。
   * 恰好 1 个阵营接触 → 该空区全归它（= 被围住的空点）；接触 0 或 ≥2 个阵营 → 中立。
   * 棋盘边界**不算**归属方（越界不计），避免把"棋盘外"误判为围住。
   * 纯函数、无随机、O(W²)：只在终局调用一次，非 tick 内。
   *
   * ⚠️ 口径说明（2026-09 需求返工）：本函数是**旧的「严格围空」口径**（仿围棋：只有被单一阵营
   *   完全围住的空区才归属）。实测在散点局面下 1024 格里有 964 格判中立、双方围空皆为 0，胜负
   *   退化为"谁落子多"，地盘毫无意义。**已不再用于胜负判定**（_goScoreChinese → _goNearestEmpty）。
   *   此处**保留不删**，仅供对照 / 向后兼容 / 既有 QA（board_editor.qa.test.mjs QA-GO-2）引用。
   * @returns {{byF:Object<number,number>}} faction -> 被该阵营围住的空点数
   */
  P._goEnclosedEmpty = function _goEnclosedEmpty() {
    const W = World.LIFE_W, L = this._life;
    const seen = new Uint8Array(W * W);          // 访问标记（0/1）
    const byF = Object.create(null);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        const key = x * W + y;
        if (L[x][y] !== 0 || seen[key]) continue;  // 只从未访问的空点起 BFS
        // 形状/虚空感知：墙格（形状外 / 虚空）**不可穿越、不并入空区、不计归属**。
        // 不从此格起 BFS（避免把虚空当成空点去归属），后续洪水填充也不进入墙格。
        if (this._isWall(x, y)) { seen[key] = 1; continue; }
        // --- 洪水填充一个连通空区 ---
        const stack = [[x, y]]; seen[key] = 1;
        let cellCount = 0;                         // 本空区空格数
        const borderF = new Set();                 // 接触到的非空阵营（越界/墙不计）
        while (stack.length) {
          const [cx, cy] = stack.pop(); cellCount++;
          for (const [dx, dy] of NEI4) {
            const nx = cx + dx, ny = cy + dy;
            if (this._isWall(nx, ny)) continue;    // 棋盘边 ∪ 形状外 ∪ 虚空 = 无归属（阻断连通）
            const v = L[nx][ny];
            if (v === 0) { const k = nx * W + ny; if (!seen[k]) { seen[k] = 1; stack.push([nx, ny]); } }
            else borderF.add(v);                   // 记录接触到的阵营
          }
        }
        // --- 归属判定：恰好单一阵营围住 → 全部计给它；否则中立 ---
        if (borderF.size === 1) {
          const f = borderF.values().next().value;
          byF[f] = (byF[f] || 0) + cellCount;
        }
      }
    }
    return { byF };
  };

  /**
   * 就近归属（势力范围）空点归属：每个**空点**归属「距离它最近的棋子」所属阵营。
   * 距离 = 4 邻步数（曼哈顿 / 网格步，多源 BFS 求得）。
   *   · 若存在**两个及以上不同阵营**的棋子同时达到最小距离 → 该空点**中立**；
   *   · 若某空点**无法到达任何棋子**（被墙完全隔开等）→ 中立；
   *   · 棋子格本身**不参与**空点归属，只作为 BFS 源点。
   * 实现：对盘面上每个"有子的阵营"各跑一次多源 BFS（源 = 该阵营全部棋子），只向空点扩散
   *      （**不穿墙格、不穿棋子格**）；维护 bestDist（最短距离）与 bestOwn（唯一归属），
   *      对每个空点：d < bestDist → 取该阵营；d === bestDist 且阵营不同 → 置中立（0）。
   * 复杂度 O(F · W²)（F ≤ 8，W = 32），只在终局调用一次，完全可接受。
   * 纯函数、无随机（禁 Math.random / Date.now）。
   * @returns {{byF:Object<number,number>}} faction -> 归属该阵营的空点数
   */
  P._goNearestEmpty = function _goNearestEmpty() {
    const W = World.LIFE_W, L = this._life;
    const N = W * W;
    const byF = Object.create(null);
    // ① 收集盘面上所有出现过的棋子阵营（= BFS 源阵营）。空盘 → 无源 → 直接返回（全中立）。
    const factions = new Set();
    for (let x = 0; x < W; x++) {
      const col = L[x];
      for (let y = 0; y < W; y++) {
        const v = col[y];
        if (v > 0) factions.add(v);
      }
    }
    if (factions.size === 0) return { byF };
    // ② 归属网格：bestDist[k] = 到最近棋子的步数（-1 = 尚未被任何阵营到达）；
    //    bestOwn[k] = 唯一归属阵营（0 = 中立：等距多阵营 / 不可达）。
    const bestDist = new Int16Array(N).fill(-1);
    const bestOwn = new Int8Array(N);
    const dist = new Int16Array(N);            // 单次 BFS 复用：当前阵营到各格的距离
    const queue = new Int32Array(N);           // BFS 顺序队列（每格至多入队一次，无需环形）
    for (const f of factions) {
      dist.fill(-1);
      let head = 0, tail = 0;
      // 多源：把该阵营的**全部棋子**入队（距离 0）。棋子只作源点，本身不计入空点归属。
      for (let x = 0; x < W; x++) {
        const col = L[x];
        for (let y = 0; y < W; y++) {
          if (col[y] === f) { const k = x * W + y; dist[k] = 0; queue[tail++] = k; }
        }
      }
      // 向空点扩散：不穿墙（越界 / 形状外 / 虚空），不穿棋子格（只向值为 0 的格前进）。
      while (head < tail) {
        const k = queue[head++];
        const cx = (k / W) | 0, cy = k % W;
        const d = dist[k];
        for (const [dx, dy] of NEI4) {
          const nx = cx + dx, ny = cy + dy;
          if (this._isWall(nx, ny)) continue;   // 墙格（含越界）不可穿越
          if (L[nx][ny] !== 0) continue;        // 棋子格不可穿越（只扩散到空点）
          const nk = nx * W + ny;
          if (dist[nk] !== -1) continue;        // 已访问
          dist[nk] = d + 1;
          queue[tail++] = nk;
        }
      }
      // 汇总：对每个该阵营可达的空点，按"更近者得、等距者中立"更新唯一归属（顺序无关）。
      for (let x = 0; x < W; x++) {
        const col = L[x];
        for (let y = 0; y < W; y++) {
          if (col[y] !== 0) continue;           // 仅统计空点
          const k = x * W + y;
          const d = dist[k];
          if (d < 0) continue;                  // 该阵营到不了此空点
          const bd = bestDist[k];
          if (bd < 0 || d < bd) { bestDist[k] = d; bestOwn[k] = f; }
          else if (d === bd && bestOwn[k] !== f) { bestOwn[k] = 0; }   // 等距多阵营 → 中立
        }
      }
    }
    // ③ 计分：归属非零的空点数（墙格非空点，天然被上面的 col[y] !== 0 排除）。
    for (let x = 0; x < W; x++) {
      const col = L[x];
      for (let y = 0; y < W; y++) {
        if (col[y] !== 0) continue;
        const o = bestOwn[x * W + y];
        if (o) byF[o] = (byF[o] || 0) + 1;
      }
    }
    return { byF };
  };

  /**
   * 中国规则数子：己方棋子数 + 己方归属的空点数（多者胜，不贴子）。纯函数、无随机、O(W²)。
   * 空点归属口径 = **就近归属（势力范围）**：空点归「距离它最近的棋子」所属阵营，等距则中立
   * （见 _goNearestEmpty）。子数逻辑不变。
   * 与 _goScore()（Voronoi 归属目数，保留给 rts-go 快照 / 旧口径）语义不同 —— 本函数才是
   * go 终局胜负依据。
   * @returns {{byF:Object<number,number>, black:number, white:number,
   *            stoneByF:Object<number,number>, emptyByF:Object<number,number>, ranked:object[]}}
   */
  P._goScoreChinese = function _goScoreChinese() {
    const g = this._goInit();
    const W = World.LIFE_W, L = this._life;
    const stoneByF = Object.create(null);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        const v = L[x][y];
        if (v > 0) stoneByF[v] = (stoneByF[v] || 0) + 1;   // 子数（go 盘只有 1..8）
      }
    }
    const { byF: emptyByF } = this._goNearestEmpty();      // 空点归属（就近归属 / 势力范围）
    const byF = Object.create(null);
    const keys = new Set([...Object.keys(stoneByF), ...Object.keys(emptyByF)]);
    for (const k of keys) byF[k] = (stoneByF[k] || 0) + (emptyByF[k] || 0);
    const black = byF[g.blackF] || 0, white = byF[g.whiteF] || 0;
    const ranked = (g.seats || []).map((pid, i) => {
      const f = g.seatF[i];
      const p = this.players[pid];
      return {
        playerId: pid, faction: f, name: p ? p.name : String(pid),
        isAI: !!(p && p.isAI), botControlled: !!(p && p.botControlled), lost: !!(p && p.lost),
        lostReason: (p && p.lostReason) || null,             // 'wiped' | 'resign' | ...（供胜负池判定）
        score: byF[f] || 0,                                  // 数子总分
        stones: stoneByF[f] || 0,                            // 明细：子数
        empty: emptyByF[f] || 0,                             // 明细：围住空点
        territory: byF[f] || 0,                              // 兼容别名字段（旧前端/旧代码）
      };
    }).sort((a, b) => b.score - a.score);
    return { byF, black, white, stoneByF, emptyByF, ranked };
  };

  // ---------- 回合状态机 / 终局 ----------

  /**
   * 结束当前回合：结算 pass / 手数 / 吃光 / 超时，然后轮到下一位并推进周期机制。
   * N 方规则：**全员各 pass 一次**（连续 passStreak ≥ 在座人数）→ 终局。
   * @param {object|null} played 本回合的落子结果（null = 本回合是 pass）
   * @param {object[]} events
   */
  P._goEndTurn = function _goEndTurn(played, events) {
    const g = this._goSyncSeats();
    const seats = g.seats || [];
    if (seats.length === 0) return;
    if (played === null) { g.passes++; g.passStreak = (g.passStreak || 0) + 1; }
    else { g.passes = 0; g.passStreak = 0; }
    let endReason = null;
    if (g.passStreak >= seats.length) endReason = 'pass';
    else if (g.moveNo >= World.GO_MAX_MOVES) endReason = 'max_moves';

    // 吃光出局（"一条命"）：曾建立规模（≥ WIPE_ELIM_MIN_CELLS）后被清零 → 登记出局。
    // ⚠️ 用户拍板（VC-09/VC-10）：吃光**不算赢**（围棋真规则）。此处的 `wiped` 仅作为
    //    **终局触发器**（等价于"该方已无子可数、棋局实质结束"），**不产生胜者**；
    //    胜负一律由 _goFinish → _goScoreChinese 数子决定。
    //    （若产品希望"清盘后继续下到双方 Pass"，删下一行 `if (!endReason) endReason = 'wiped';` 即可。）
    for (const pid of seats) {
      const p = this.players[pid];
      if (!p || p.lost) continue;
      if ((p.maxLifeCells || 0) >= World.WIPE_ELIM_MIN_CELLS && (p.lifeCells || 0) === 0) {
        p.lost = true; p.lostReason = 'wiped';
        events.push({ type: 'eliminated', playerId: pid, reason: 'wiped' });
        if (!endReason) endReason = 'wiped';
      }
    }
    // 累计超时判负
    for (const pid of seats) {
      const p = this.players[pid];
      if (p && (p.goTimeouts || 0) >= World.GO_MAX_TIMEOUTS && !endReason) endReason = 'timeout';
    }
    // 只剩一方未出局 → 触发终局（胜负仍由 _goFinish 数子排名决定，非"最后一人无条件胜"）
    const aliveSeats = seats.filter(pid => !(this.players[pid] && this.players[pid].lost));
    if (!endReason && aliveSeats.length <= 1 && seats.length > 1) endReason = 'last_standing';
    if (endReason) { this._goFinish(endReason, events); return; }

    // 轮到下一位（跳过已出局者）
    let step = 0;
    do {
      g.turnIdx = (g.turnIdx + 1) % seats.length;
      step++;
    } while (step <= seats.length && this.players[seats[g.turnIdx]] && this.players[seats[g.turnIdx]].lost);
    g.turn = g.seatF[g.turnIdx] != null ? g.seatF[g.turnIdx] : 0;
    g.moveNo++;
    g.turnTicks = 0;
    g.placedThisTurn = 0;   // 换手 → 本回合落子预算复位
    if (g.moveNo % World.GO_BREATH_EVERY === 1) this._goBreathe();
    if (g.moveNo % World.GO_EVENT_EVERY === 1) this._goWorldEvent();
  };

  /**
   * 终局结算：按**中国规则数子**（子数 + 围住空点）排名，唯一最高者胜（并列则平局，不贴子）。
   * 胜利线【领土】关闭时（含全关）→ 不宣告任何胜者（winner=null），只出明细。
   * @param {string} reason 终局原因（pass / max_moves / wiped / timeout / resign / last_standing）
   * @param {object[]} events
   */
  P._goFinish = function _goFinish(reason, events) {
    const g = this._goInit();
    const sc = this._goScoreChinese();          // ← 中国规则数子（取代 Voronoi 目数 _goScore）
    // 参与胜负比较的池：剔除「弃权类出局」（认输/超时判负——这些方已主动放弃，绝不应判胜），
    // 但**保留「被吃光 wiped」方**（用户拍板 VC-09：吃光不算赢，只触发终局）。
    // 被吃光方盘面 0 子 ⇒ 数子恒为 0，保留它只会让「双方同为 0」正确地判为平局（并列），
    // 永远不会让它反超别人（0 分无法高于任何正分），从而杜绝旧的“吃光者对手无条件胜”。
    const pool = sc.ranked.filter(r => !r.lost || r.lostReason === 'wiped');
    const eff = pool.length ? pool : sc.ranked;   // 全员弃权等极端情况退化为全席位排名
    let winner = null;
    // 胜利线【领土】开着才宣告胜者；关掉 → winner=null（E6/VC-02）。
    // go 模式下 victoryLines 恒只含 territory（引擎/归一已 gate），此处只需读 territory。
    const territoryOn = !this.victoryLines || this.victoryLines.territory !== false;
    if (territoryOn && eff.length) {
      const top = eff[0];
      const tie = eff.filter(r => r.score === top.score && r.faction !== top.faction);
      winner = tie.length ? null : top.playerId;  // 唯一最高才算胜；并列 → 平局（不贴子）
    }
    g.result = {
      winner,
      reason,
      ranked: eff.map(r => ({
        playerId: r.playerId, name: r.name, faction: r.faction,
        score: r.score, stones: r.stones, empty: r.empty,
        lost: r.lost, lostReason: r.lostReason,
        territory: r.territory,   // 兼容旧字段名（值口径已由 Voronoi 目数变为数子总分）
      })),
      // 兼容旧字段名（值口径已变更）；新增中国规则口径字段
      blackScore: sc.black, whiteScore: sc.white,
      blackTerritory: sc.black, whiteTerritory: sc.white,
      moves: Math.max(0, g.moveNo - 1),
    };
    events.push({ type: 'go_end', winner, reason, ranked: g.result.ranked,
      blackScore: sc.black, whiteScore: sc.white,
      blackTerritory: sc.black, whiteTerritory: sc.white, moves: g.result.moves });
    if (winner != null) {
      const p = this.players[winner];
      if (p) { p.won = true; p.winReason = 'go'; }   // Q3 裁决：沿用 'go'（无榜单依赖）
    }
  };

  /**
   * go 世界的 1 秒计时步进（由 net / index 的 1s 循环调用，无 20TPS tick）。
   * 超时 = 自动 pass；无连接时由调用方决定是否推进（计时暂停在 net 层）。
   * @returns {{events:object[], tickMs:number}}
   */
  P._goTick = function _goTick() {
    const g = this._goSyncSeats();
    if (g.result) { this.events = []; return { events: [], tickMs: 0 }; }
    const events = [];
    this.tick++;
    g.turnTicks++;
    // 超时 = 自动 pass（不做随机落子），并累计超时次数
    if (g.turnTicks * 1000 >= World.GO_TURN_MS) {
      const pid = (g.seats && g.seats[g.turnIdx] != null) ? g.seats[g.turnIdx] : null;
      const p = pid != null ? this.players[pid] : null;
      if (p) p.goTimeouts = (p.goTimeouts || 0) + 1;
      events.push({ type: 'go_timeout', playerId: pid, moveNo: g.moveNo });
      this._goEndTurn(null, events);
    }
    this.events = events;
    return { events, tickMs: 0 };
  };

  /**
   * 处理 go 落子 / pass / 认输意图（由 net 层直接调用，因为 go 没有 20TPS tick）。
   * @param {*} playerId 发起者
   * @param {object} data {lx,ly} | {pass:true} | {resign:true}
   * @param {object[]} events 事件收集数组
   * @returns {{ok:boolean, reason?:string, captured?:number, pass?:boolean, resign?:boolean}}
   */
  P.applyGoIntent = function applyGoIntent(playerId, data, events) {
    const g = this._goSyncSeats();
    const evts = events || [];
    if (g.result) return { ok: false, reason: 'ended' };
    if (!data || typeof data !== 'object') return { ok: false, reason: 'bad_move' };
    const seatIdx = (g.seats || []).indexOf(playerId);
    if (seatIdx === -1) return { ok: false, reason: 'not_seated' };
    const f = g.seatF[seatIdx];
    if (f !== g.turn) return { ok: false, reason: 'not_your_turn' };
    if (data.pass) { this._goEndTurn(null, evts); return { ok: true, pass: true }; }
    if (data.resign) {
      const p = this.players[playerId];
      if (p) { p.lost = true; p.lostReason = 'resign'; }
      // 认输后若只剩一方 → 终局；否则继续（该玩家被跳过）
      const alive = (g.seats || []).filter(pid => !(this.players[pid] && this.players[pid].lost));
      if (alive.length <= 1) this._goFinish('resign', evts);
      else this._goEndTurn(null, evts);
      return { ok: true, resign: true };
    }
    // 解析落子集合：新格式 {moves:[{lx,ly},...]}；兼容旧格式 {lx,ly}（视为 1 颗的一批）。
    let moves;
    if (Array.isArray(data.moves)) moves = data.moves;
    else if (typeof data.lx === 'number' && typeof data.ly === 'number') moves = [{ lx: data.lx, ly: data.ly }];
    else return { ok: false, reason: 'bad_move' };
    if (moves.length === 0) return { ok: false, reason: 'bad_move' };
    if (moves.length > this.stonesPerTurn) return { ok: false, reason: 'too_many_stones' };
    const r = this._goPlayBatch(f, moves, evts);
    if (!r.ok) return r;
    // 记录本回合已落子数：供 snapshot.go.stonesLeft 反映"本回合还剩几颗可下"
    // （本设计下"一批即一整回合"，落完立即换手，故换手后 stonesLeft 复位为 stonesPerTurn）。
    g.placedThisTurn = r.placed;
    // 落子 → 演化（含本回合世界事件）→ 领土重算 → 换手
    const evtMode = g._evt || 0;
    this._goEvolve(evtMode, evts);
    g._evt = 0;
    this._updateRegionControl();
    this._goEndTurn(r, evts);
    return { ok: true, placed: r.placed, captured: r.captured };
  };

  /**
   * AI 在 go 模式下的出手：若当前行动方是 AI（含**掉线由电脑接手**的角色），
   * 则计算并落一子（或 pass）。由 net / index 的 1s 循环在推进计时前调用。
   * @param {object[]} events
   * @returns {boolean} 是否由 AI 完成了一手
   */
  P._goMaybeAIMove = function _goMaybeAIMove(events) {
    const g = this._goSyncSeats();
    if (g.result) return false;
    const pid = (g.seats && g.seats[g.turnIdx] != null) ? g.seats[g.turnIdx] : null;
    const p = pid != null ? this.players[pid] : null;
    if (!p) return false;
    // "电脑驱动" = 原生 AI 或 掉线被接管
    if (!(p.isAI === true || p.botControlled === true)) return false;
    if (!World.goAIMove) return false;
    const mv = World.goAIMove(this, g.turn);
    if (!mv) { this._goEndTurn(null, events); return true; }
    if (mv.pass) { this._goEndTurn(null, events); return true; }
    // 新契约：AI 返回 { moves: [{lx,ly},...] }（1..stonesPerTurn 颗，一次落一颗或多颗）；
    // 兼容旧契约 { lx, ly }（视为 1 颗的一批）。
    const moves = Array.isArray(mv.moves)
      ? mv.moves
      : (typeof mv.lx === 'number' && typeof mv.ly === 'number' ? [{ lx: mv.lx, ly: mv.ly }] : null);
    if (!moves || moves.length === 0) { this._goEndTurn(null, events); return true; }
    const r = this.applyGoIntent(pid, { moves }, events);
    if (!r.ok) { this._goEndTurn(null, events); }   // 极端情况（AI 选了非法点）→ 视作 pass，绝不阻塞
    return true;
  };

  /**
   * go 座位分配（兼容旧接口）：按 goSeatIds 同步。
   */
  P._goAssignSeats = function _goAssignSeats() {
    this._lifeInit();
    if (!this.goSeatIds || this.goSeatIds.length === 0) this.goSeatIds = Object.keys(this.players);
    return this._goSyncSeats();
  };

  /**
   * go 模式快照字段（供 engine.snapshot() 调用）。**多方**：输出 seats 数组供 UI 排名。
   * @returns {object}
   */
  P._goSnapshotState = function _goSnapshotState() {
    const g = this._goSyncSeats();
    const sc = g.result ? null : this._goScore();
    // 中国规则数子明细（子数 + 围住空点）。局中与终局都输出，供 UI 展示"吃光不算赢"。
    const chinese = this._goScoreChinese();
    const scs = g.result ? null : chinese;   // 局中 = 当前盘面数子；终局 = 用 result 里的快照
    const turnPid = (g.seats && g.seats[g.turnIdx] != null) ? g.seats[g.turnIdx] : null;
    const winnerName = g.result && g.result.winner != null
      ? ((this.players[g.result.winner] || {}).name || null) : null;
    const seats = (g.seats || []).map((pid, i) => {
      const p = this.players[pid];
      const f = g.seatF[i];
      const terr = sc ? (sc.byF[f] || 0) : ((g.result && g.result.ranked.find(r => r.playerId === pid)) || {}).territory || 0;
      return {
        playerId: pid,
        name: p ? p.name : String(pid),
        color: p ? p.color : '#888',
        isAI: !!(p && p.isAI),
        botControlled: !!(p && p.botControlled),
        lost: !!(p && p.lost),
        faction: f,
        territory: terr,
        timeouts: (p && p.goTimeouts) || 0,
        isTurn: pid === turnPid,
      };
    });
    return {
      turn: turnPid,
      turnF: g.turn,
      turnIdx: g.turnIdx,
      seatCount: seats.length,
      seats,
      // 兼容旧字段（两方局）
      blackId: g.blackId, whiteId: g.whiteId,
      moveNo: g.moveNo,
      maxMoves: World.GO_MAX_MOVES,
      msLeft: Math.max(0, World.GO_TURN_MS - g.turnTicks * 1000),
      phase: g.result ? 'over' : 'play',
      passes: g.passStreak || 0,
      passStreak: g.passStreak || 0,
      boardW: World.LIFE_W,
      stonesPerTurn: this.stonesPerTurn,                                          // 每回合可落子数（房主可设，默认 3）
      stonesLeft: Math.max(0, this.stonesPerTurn - (g.placedThisTurn || 0)),      // 本回合还剩几颗可下
      breath: g._breathR,
      nextBreathIn: (World.GO_BREATH_EVERY - ((g.moveNo - 1) % World.GO_BREATH_EVERY)) % World.GO_BREATH_EVERY,
      event: g.lastEvent || 'calm',
      ko: g.ko,
      // 旧口径（Voronoi 归属目数 + 图案奖）：保留不动，rts-go 快照与旧代码仍可读
      territory: sc ? { byF: sc.byF, black: sc.black, white: sc.white, ranked: sc.ranked } : null,
      // 新口径：中国规则数子（子数 + 围住空点）——终局胜负依据，供结算面板展示
      chineseScore: g.result ? {
        black: g.result.blackScore, white: g.result.whiteScore,
        ranked: g.result.ranked,
      } : {
        black: scs.black, white: scs.white,
        stoneByF: scs.stoneByF, emptyByF: scs.emptyByF,
        ranked: scs.ranked.map(r => ({ playerId: r.playerId, name: r.name, faction: r.faction,
          score: r.score, stones: r.stones, empty: r.empty })),
      },
      bonusSeen: (g.scoredPatterns || []).length,
      lastMove: g.moveLog.length ? g.moveLog[g.moveLog.length - 1] : null,
      result: g.result ? { ...g.result, winnerName } : null,
    };
  };

  /**
   * 座位齐备后（≥1 席）初始化 go 状态与先手。幂等：可被反复调用（每多一个玩家就调一次）。
   */
  P._goAssignSeatsIfReady = function _goAssignSeatsIfReady() {
    this._lifeInit();
    return this._goSyncSeats();
  };

  return World;
}

export default installGoMode;
