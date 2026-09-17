// server/engine.js — 世界引擎主循环（9 阶段 tick 流水线）
import {
  mulberry32, TICK_RATE, TICK_BUDGET_MS, ENTITY_CAP, WORLD_W, WORLD_H,
  CHUNK_W, CHUNK_H, TERRAIN, RESOURCE, clamp, pickSpawn,
} from './util.js';
import { IntentQueue, applyImpulse, elasticCollision } from './intents.js';
import { recognizeEmergent, tickEmergent, SAFE_SPAWN_DIST } from './emergent.js';
import { stepAI, makeAIPlayer, registerGoAI } from './ai.js';
import { getMode, allModeDefs, boardMaxForMode } from './modes/index.js';

// 内核加载器
const kernelRegistry = new Map();
async function loadKernels() {
  if (kernelRegistry.size) return;
  const files = [
    'astar','dijkstra','bfs','dfs','best_first','idastar','mst_prim','topo_sort','bidirectional','jump_point',
    'boids','ant_colony','pso','cellular_automaton','swarm_merge','flock_split',
    'minimax','alphabeta','mcts','expectimax','negamax','monte_carlo_eval','opening_book',
    'hill_climb','simulated_anneal','gradient_descent','nelder_mead',
    'voronoi','delaunay','convex_hull','raycast_2d','line_of_sight',
    'conway_life','rule_30','rule_90','rule_184','langtons_ant',
    'markov_chain','fuzzy_logic','l_system','signal_slot','event_bus',
    'reaction_diffusion','slime_mold','predator_prey','sand_pile',
  ];
  for (const id of files) {
    try {
      const m = await import(`./kernels/${id}.js`);
      const fn = m[id];
      if (fn && fn.__meta && fn.__meta.id === id) kernelRegistry.set(id, fn);
    } catch (e) { /* noop */ }
  }
  // Expose for subsystems (ai.js) without creating a circular import with engine.
  World.kernelRegistry = kernelRegistry;
}

export class World {
  constructor(worldId, ownerId, seed, opts) {
    this.worldId = worldId;
    this.ownerId = ownerId;
    this.seed = seed || 1;
    // 模式：'rts'（默认，行为逐字节不变）| 'go'（回合制 · 演化棋）。
    // go 模式走独立分支：不参与 20 TPS tick、无地形资源、固定 2 座位。
    this.mode = (opts && opts.mode) || 'rts';
    // 模式插件（注册表）：主干通过 this._mode 读取 tickDriver / boardMax / 钩子，不再硬编码 mode 分支。
    // 新增模式 = 在 server/modes/ 放一个插件文件（+ 在注册表加一行 import），engine/net/index 零改动。
    this._mode = getMode(this.mode);
    // 生命层边长（正方形）：rts 恒 32（1 生命格 = 6x6 世界格）；go 跟随棋盘尺寸（_compileBoard 里设定）。
    this.lifeW = World.LIFE_W;
    this.go = null;                 // go 模式状态容器（惰性 _goInit）
    this.goBlackId = null;          // go 首座 playerId（先手；多方局=第一个就座者）
    this.goWhiteId = null;          // go 次座 playerId（兼容保留；多方局以 goSeatIds 为准）
    // ---- 席位模型（两种模式共用）----
    // 房间/世界是"玩家的大厅"：**席位上限由房主设置**（1..8），**电脑玩家也占席位**。
    // AI 只由玩家手动添加（不再自动补位），因此不会出现"AI 把位子偷偷占满"的情况；
    // 只要还有空席，任何玩家都能随时加入（含中途加入）。
    this.maxPlayers = (opts && opts.maxPlayers) || World.MAX_SLOTS;  // 总席位上限（人类 + 电脑），房主设置
    this.maxTotal = World.MAX_SLOTS;                                 // 绝对上限（faction 只有 1..8）
    this.hostId = (opts && opts.hostId != null) ? opts.hostId : ownerId; // 房主：暂停 / 增删 AI
    this.paused = false;            // 房主暂停：暂停时两种模式的时钟都不推进
    this.goSeatIds = [];            // go 模式就座顺序（= 行动顺序），playerId 数组
    this.started = false;           // 房主点过"开始游戏"
    // ---- 房主可调的玩法参数（rts 与 go 共用；由路由层从 opts 透传）----
    // stonesPerTurn：go 模式"一回合可下几颗棋子"（默认 3 = 康威下可存活的最小单位）。
    this.stonesPerTurn = World._clampInt(
      opts && opts.stonesPerTurn, World.STONES_PER_TURN_DEFAULT, 1, World.STONES_PER_TURN_MAX);
    // lonelyDeathDelay：无法存活的孤子"还能撑几个回合才死"（默认 0 = 立即死，恢复标准康威）。
    this.lonelyDeathDelay = World._clampInt(
      opts && opts.lonelyDeathDelay, World.LONELY_DEATH_DELAY_DEFAULT, 0, World.LONELY_DEATH_DELAY_MAX);
    // aiDifficulty：电脑对手强度（1..5，默认 3 = 改动前行为）。
    this.aiDifficulty = World._clampInt(
      opts && opts.aiDifficulty, World.AI_DIFFICULTY_DEFAULT, World.AI_DIFFICULTY_MIN, World.AI_DIFFICULTY_MAX);
    // ---- 房主可配置的胜利条件（constructor 侧双保险：rooms.js 已归一，这里再取一次）----
    // victoryLines：4 个布尔开关（默认仅 territory）；go 模式强制只保留 territory。
    this.victoryLines = World.normVictoryLines(opts && opts.victoryLines, this.mode);
    // victoryThresholds：rts 各线门槛（默认 = 原硬编码常量；go 不消费但仍透传存储）。
    this.victoryThresholds = World.normVictoryThresholds(opts && opts.victoryThresholds);
    // ---- 房主可配的 go 限制（手数上限 / 每手时限 / 超时判负次数）----
    // 构造器侧双保险：rooms.js 已归一，这里再取一次；缺省 → 全默认（与旧硬编码一致，行为不变）。
    this.goLimits = World.normGoLimits(opts && opts.goLimits);
    // ---- 可编辑棋盘（形状 + 虚空格）----
    // 构造器侧双保险：rooms.js 已归一，这里再取一次；board=null → 全走现状矩形（零行为变化）。
    // 运行时层：this.board = 归一配置（供快照回显）；this._bmp = 编译后的位图（生命格粒度）。
    this._compileBoard(opts && opts.board);
    // rts 出生点模式（R7/BE-12）：'random'（默认，离其他玩家最远）| 'pick'（自选坐标）。
    // go 模式无出生点概念（纯轮流落子），这两项对其无影响。
    this._spawnMode = (opts && opts.spawnMode === 'pick') ? 'pick' : 'random';
    const sxy = opts && opts.spawnXY;
    this._spawnXY = (sxy && Number.isFinite(sxy.x) && Number.isFinite(sxy.y))
      ? { x: Math.floor(sxy.x), y: Math.floor(sxy.y) } : null;
    this._rng = mulberry32(this.seed);
    this.tick = 0;
    this.oxic = false;   // 世界含氧量：无氧纪（发酵）→ 大氧化事件 → 有氧纪（生物呼吸的能源革命）
    this.created = Date.now();
    this.players = {}; // playerId -> {x,y,vx,vy,mass,hp,...}
    this.entities = []; // 涌现单位
    this.terrain = this._genTerrain();
    this.resources = this._genResources();
    this.tech = { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0 };
    this.intentQueue = new IntentQueue();
    this.events = [];
    this.dailyTick = 0;
    this.lastTickedAt = Date.now();
    this.kernelRegistry = kernelRegistry; // 供 AI 等子系统取用内核，避免循环依赖
    // Survival tide state machine
    this.tide = {
      phase: 'prep',
      phaseTicks: 0,
      nextPhaseAt: 20 * TICK_RATE,
      surgeCount: 0,
      stormCount: 0,
      lastBossAt: 0,
    };
  }
  _genTerrain() {
    const g = Array.from({ length: WORLD_W }, () => new Uint8Array(WORLD_H));
    const rng = this._rng;
    for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) {
      const v = valueNoise(x * 0.05, y * 0.05, this.seed) + 0.3 * valueNoise(x * 0.15, y * 0.15, this.seed + 1);
      let t = TERRAIN.GRASS;
      if (v < 0.1) t = TERRAIN.WATER;
      else if (v < 0.18) t = TERRAIN.DESERT;
      else if (v < 0.32) t = TERRAIN.GRASS;
      else if (v < 0.5) t = TERRAIN.FOREST;
      else if (v < 0.7) t = TERRAIN.MOUNTAIN;
      g[x][y] = t;
    }
    return g;
  }
  _genResources() {
    const r = Array.from({ length: WORLD_W }, () => new Array(WORLD_H).fill(0));
    const rng = this._rng;
    // 形状感知：board=null → 无条件全图填充（与现状逐字节一致）；
    // board 非空 → 形状外/虚空的格子不生成资源（世界格映射到生命格后判墙）。
    for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) {
      if (this._bmp && !this._isPlayableWorld(x, y)) continue;
      const t = this.terrain[x][y];
      if (t === TERRAIN.FOREST && rng() < 0.10) r[x][y] = RESOURCE.WOOD;
      else if (t === TERRAIN.MOUNTAIN && rng() < 0.075) r[x][y] = RESOURCE.STONE;
      else if (t === TERRAIN.MOUNTAIN && rng() < 0.0375) r[x][y] = RESOURCE.ORE;
      else if (t === TERRAIN.DESERT && rng() < 0.025) r[x][y] = RESOURCE.CRYSTAL;
      else if (t === TERRAIN.GRASS && rng() < 0.0125) r[x][y] = RESOURCE.FOOD;
    }
    return r;
  }
  /** 人类玩家人数（不含电脑玩家）。 */
  humanCount() {
    return Object.values(this.players).filter(q => !q.isAI).length;
  }
  /** 已占席位数（人类 + 电脑玩家，电脑玩家同样占席位）。 */
  seatCount() {
    return Object.keys(this.players).length;
  }
  /**
   * 有效席位数上限 = min(房主设定, 硬上限 8, **模式级上限**)。
   * 模式级上限由注册表元数据注入的 `this._mode.maxSeats` 提供（如 gomoku/weiqi 恒为 2 席，
   * 禁止第 3 席人类或电脑）。主干**不出现任何 `mode === '<某模式>'` 字符串分支** —— 只读注册表。
   * 未声明 maxSeats 的模式（rts/go）→ 上限不受模式约束（Infinity）。
   */
  seatCap() {
    const modeCap = (this._mode && this._mode.maxSeats != null) ? this._mode.maxSeats : Infinity;
    return Math.max(1, Math.min(
      this.maxPlayers || World.MAX_SLOTS,
      this.maxTotal || World.MAX_SLOTS,
      modeCap,
    ));
  }
  /** 是否还有空席位（人类与电脑共用同一池）。 */
  canAcceptHuman() {
    return this.seatCount() < this.seatCap();
  }
  /**
   * 加入一个玩家。
   * - 已存在（含"掉线由 AI 接管"中）→ 幂等返回，并交还控制权（botControlled=false）。
   *   这样"中途离开由电脑接手，回来再接手回去"是无缝的：分数/棋盘/faction 全部保留。
   * - 人类超额 → 返回 { rejected:'room_full' }（调用方负责友好拒绝）。
   * - **不自动补 AI**：AI 只能由玩家手动添加（见 addAI）。
   */
  addPlayer(playerId, name) {
    const existing = this.players[playerId];
    if (existing) {
      // 交还控制权：掉线期间 AI 代为落子，玩家回来即接回原位。
      if (existing.botControlled) existing.botControlled = false;
      return existing;
    }
    if (!this.canAcceptHuman()) return { rejected: 'room_full' };
    // 出生点：远离已有玩家，让多方从地图四角各自发展、中盘相遇。
    // 形状感知：候选点必须落在「可落子」世界格内（形状外 / 虚空被剔除）。
    // R7/BE-12：支持「自选」出生点（this._spawnMode === 'pick' + spawnXY），非法坐标 → 回退随机。
    const isValid = (x, y) => this._isPlayableWorld(x, y);
    let px, py;
    if (this._spawnMode === 'pick' && this._spawnXY
        && Number.isFinite(this._spawnXY.x) && Number.isFinite(this._spawnXY.y)
        && this._isPlayableWorld(Math.floor(this._spawnXY.x), Math.floor(this._spawnXY.y))) {
      px = Math.max(0, Math.min(WORLD_W - 1, Math.floor(this._spawnXY.x)));
      py = Math.max(0, Math.min(WORLD_H - 1, Math.floor(this._spawnXY.y)));
    } else {
      const sp = pickSpawn(this._rng, Object.values(this.players), 24, WORLD_W, WORLD_H, isValid);
      if (sp) { px = sp[0]; py = sp[1]; }
      else {
        // 形状内无可落子格（理论不会，normBoard 已保证至少一格）→ 回退地图中心。
        px = Math.floor(WORLD_W / 2); py = Math.floor(WORLD_H / 2);
      }
    }
    const p = {
      id: playerId, name, x: px, y: py, vx: 0, vy: 0, mass: 1,
      hp: 100, hpMax: 100,
      score: 0, kills: 0, deaths: 0, assists: 0,
      maxCombo: 0, combo: 0, comboDecay: 0,
      dashCharge: 1, dashCooldown: 0,
      hitFlash: 0,
      alive: true, respawnTicks: 0,
      // 出生保护：与复活一致给 3 秒无敌。此前只有复活才设 invulnTicks，
      // 初始出生为 0 → 开局就被聚拢过来的敌对单位贴脸秒杀（反复死亡 → DEATH_LIMIT 出局）。
      invulnTicks: World.INVULN_TICKS,
      regionsOwned: 0, scoreLeadTicks: 0,
      won: false, lost: false, winReason: null, lostReason: null,
      color: `hsl(${(this._rng()*360)|0},70%,55%)`,
      isAI: false,
      botControlled: false,   // true = 该人类已掉线，暂由 AI 代为行动
    };
    // 开局=城邦起跑：跳过部落/村落的空转期，直接进入可争夺的棋盘
    World._stampStartEra(p);
    // 模式钩子：go 等模式在此接管开局（空盘/就座/跳过 rts 出生点资源），
    // rts 无钩子则走下方默认路径（落出生点 + 就座）。
    const m = getMode(this.mode);
    if (m.onAddPlayer) { m.onAddPlayer(this, p); return p; }
    this.players[playerId] = p;
    this._seedOnboarding(px, py, playerId);
    if (this.hostId == null) this.hostId = playerId;
    return p;
  }
  /** go 就座：按加入顺序追加到 goSeatIds（= 行动顺序）。已在座则不动。 */
  _goSeatJoin(p) {
    if (!this.goSeatIds) this.goSeatIds = [];
    if (this.goSeatIds.indexOf(p.id) === -1) this.goSeatIds.push(p.id);
    if (this.goBlackId == null) this.goBlackId = p.id;
    else if (this.goWhiteId == null && p.id !== this.goBlackId) this.goWhiteId = p.id;
    // 座位变化后重新推导行动顺序（含 go 局未开始时的首手归属）
    try { this._goAssignSeatsIfReady && this._goAssignSeatsIfReady(); } catch (e) { /* 防御 */ }
  }
  /**
   * 手动添加一个电脑玩家（玩家主动调用，**不再自动补位**）。
   * **电脑玩家同样占用席位**（与人类共用同一个池，上限 = 房主设置的 maxPlayers）。
   * @returns {object|{rejected:string}} 新玩家对象，或 { rejected }
   */
  addAI() {
    if (!this.canAcceptHuman()) return { rejected: 'room_full' };
    const ai = makeAIPlayer(this, this._rng);
    if (!ai) return { rejected: 'ai_spawn_failed' };
    const m = getMode(this.mode);
    if (m.onAddAI) m.onAddAI(this, ai);
    else World._stampStartEra(ai);
    return ai;
  }
  /** 移除一个电脑玩家（房主操作）。人类玩家不会被此方法移除。 */
  removeAI(playerId) {
    const q = this.players[playerId];
    if (!q || !q.isAI) return false;
    this._lifeWipeFaction && this._lifeWipeFaction(q);
    // 回收 faction 槽位（置 null 复用，**不缩短数组**：_lifeOwner 网格按 faction 号索引）
    const idx = this._lifeOwners ? this._lifeOwners.indexOf(q.id) : -1;
    if (idx >= 0) this._lifeOwners[idx] = null;
    delete this.players[playerId];
    const si = this.goSeatIds ? this.goSeatIds.indexOf(playerId) : -1;
    if (si >= 0) this.goSeatIds.splice(si, 1);
    if (this.goBlackId === playerId) this.goBlackId = null;
    if (this.goWhiteId === playerId) this.goWhiteId = null;
    this.intentQueue.clear(playerId);
    return true;
  }
  /** 掉线/离开 → 由电脑接手（**不删除玩家**：分数、棋盘、faction 全部保留）。 */
  handOverToAI(playerId) {
    const p = this.players[playerId];
    if (!p || p.isAI) return false;
    p.botControlled = true;      // stepAI / goAIMove 会把它当作 AI 驱动
    p._aiGoal = null;
    p._goThink = 0;
    return true;
  }
  _maybeAddAI() {
    // 保留方法仅为向后兼容（旧调用点/旧测试）；**不再自动补位**。
    // 席位策略改为：AI 只能由玩家手动添加（addAI），人类加入永不被 AI 阻挡。
    return;
  }
  // Map resource name -> RESOURCE constant (for seeded onboarding)
  static _STOCK_TO_RES = { wood: 1, stone: 2, ore: 3, crystal: 4, food: 5 };
  _seedOnboarding(px, py, playerId) {
    // Seed 6 starter resources (1 of each basic type) so onboarding has direction,
    // but it is NOT enough to win singularity (which now requires 30 of each).
    const types = ['wood', 'stone', 'ore', 'crystal', 'food'];
    for (let i = 0; i < types.length; i++) {
      const a = (i / types.length) * Math.PI * 2 + this._rng() * 0.5;
      const r = 2 + Math.floor(this._rng() * 4);
      const x = Math.max(0, Math.min(WORLD_W - 1, Math.round(px + Math.cos(a) * r)));
      const y = Math.max(0, Math.min(WORLD_H - 1, Math.round(py + Math.sin(a) * r)));
      const resCode = World._STOCK_TO_RES[types[i]];
      // 形状感知：不把出生资源撒到形状外 / 虚空（board=null → 恒可落，逐字节不变）。
      if (this._bmp && !this._isPlayableWorld(x, y)) continue;
      // Only place if the cell is empty (don't overwrite naturally-generated terrain resources)
      if (this.resources[x] && !this.resources[x][y]) {
        this.resources[x][y] = resCode;
      }
    }
    this._onboarded = this._onboarded || new Set();
    this._onboarded.add(playerId);
  }
  removePlayer(playerId) {
    // M3 断线/离场清理：先擦掉该阵营所有 _life 强细胞/弱痕，避免幽灵势力占区。
    // regionFaction 随每 tick _updateRegionControl 依据强细胞重新过半归 0 / 归中立。
    const p = this.players[playerId];
    if (p) this._lifeWipeFaction(p);
    delete this.players[playerId];
    this.intentQueue.clear(playerId);
  }
  // 9 阶段 tick
  tickOnce() {
    // 房主暂停：两种模式的时钟都不推进（但连接/心跳不受影响，随时可恢复）。
    if (this.paused) return { events: [], paused: true, tickMs: 0 };
    // 模式钩子：由注册表决定本世界的模拟驱动方式。
    // rts = 内置 9 阶段 tick（下方默认路径）；go/其它 interval 模式 = 由 net/index 的 1s 循环调用其 tick 钩子。
    const m = getMode(this.mode);
    if (m.tick) return m.tick(this, this.events);
    const t0 = Date.now();
    this.tick++;
    this.dailyTick++;
    const events = [];
    // 开局保护：房主点"开始游戏"的**那一刻**，给全体在座玩家一次完整的出生无敌。
    // 原因：出生时给的 invulnTicks 可能在房间里等待期间已被 tick 消耗掉；此前只有复活才设置，
    // 导致开局被聚拢的敌对单位贴脸秒杀 → 反复死亡达 DEATH_LIMIT → "开局即出局"。
    // 只触发一次，不引入随机（确定性）。中途加入者由 addPlayer 各自带无敌。
    if (this.started && !this._startInvulnDone) {
      this._startInvulnDone = true;
      for (const pid of Object.keys(this.players)) {
        const q = this.players[pid];
        if (!q) continue;
        q.invulnTicks = Math.max(q.invulnTicks || 0, World.INVULN_TICKS);
      }
    }

    // P1: chunk 加载/淘汰 (96x96 全常驻，简单起见跳过实际 GC)
    // P1.5: AI 玩家决策（注入到同一个 IntentQueue）
    stepAI(this, this.intentQueue);
    // P2: 玩家意图合并 (冲量)
    for (const pid of Object.keys(this.players)) {
      const imp = this.intentQueue.drain(pid);
      const p = this.players[pid];
      if (!p || !p.alive) continue;
      applyImpulse(p, imp);
      // 记录本 tick 的攻击/冲刺意图，供 P6 使用
      p._attackTarget = imp ? imp.attack : null;
      p._plantIntent = !!(imp && imp.plant);
      // 演化纪元能力门：单细胞期(era0)没有"分化组织"能力 → 无种子、不可落子；
      // 多细胞(era≥1)解锁种子经济。解锁的瞬间直接给满种子（演化奖励感）。
      // 落子/种子**从开局就可用**：原实现 era0 每 tick 强制 seeds=0 → 开局 30s 谁都落不了子、
      // AI 也无所事事。现在开局即给满种子并持续回复（演化纪仍给"满把种子"的奖励感）。
      if (!p._seedInit) { p.seeds = World.SEED_MAX; p.seedRegen = 0; p._seedInit = true; }
      if (p.seeds < World.SEED_MAX) {
        p.seedRegen = (p.seedRegen || 0) + 1;
        if (p.seedRegen >= (p.seedRegenTicks || World.SEED_REGEN_TICKS)) { p.seeds++; p.seedRegen = 0; }
      }
      if (imp && imp.dash && p.dashCharge >= 1) {
        // 冲刺：瞬时给一个巨大的冲量。
        // 防御性兜底：dash 的 dx/dy 若为非有限数值（NaN/Infinity，例如绕过 net 校验
        // 的内部路径或畸形 payload），`hypot(Inf)=Inf` → `Inf/Inf=NaN` 会污染 vx/vy →
        // 坐标 NaN → 下一 tick 在 `_life[NaN]` 抛异常，世界 tick 永久崩溃。
        // 故先规整为有限值再计算，非有限一律当 0（不产生位移）。
        const ddx = Number.isFinite(imp.dash.dx) ? imp.dash.dx : 0;
        const ddy = Number.isFinite(imp.dash.dy) ? imp.dash.dy : 0;
        const l = Math.hypot(ddx, ddy) || 1;
        p.vx += (ddx / l) * 2.4;
        p.vy += (ddy / l) * 2.4;
        p.dashCharge = 0;
        p.dashCooldown = 60; // 3s @ 20TPS
        events.push({ type: 'dash', playerId: p.id });
      }
      // 减 dash 冷却
      if (p.dashCooldown > 0) p.dashCooldown--;
      if (p.dashCooldown === 0 && p.dashCharge < 1) p.dashCharge = 1;
      // 减 hit flash
      if (p.hitFlash > 0) p.hitFlash--;
      // 复活保护倒计时（防止复活瞬间被连杀）
      if (p.invulnTicks > 0) p.invulnTicks--;
      // 被动回血：受伤后先锁 5s（_regenLock），之后每 tick 缓慢回复（约 10 HP/s）。
      // 锁定期与 hitFlash 解耦——hitFlash 仅 0.3s，太短会让玩家"刚挨完打就回血"。
      if (p._regenLock > 0) p._regenLock--;
      else if (p.hp < p.hpMax) {
        p.hp = Math.min(p.hpMax, p.hp + World.HP_REGEN_PER_TICK);
      }
      // 减连击衰减
      if (p.combo > 0) {
        p.comboDecay--;
        if (p.comboDecay <= 0) { p.combo = 0; p.comboDecay = 0; }
      }
    }

    // P3: 玩家间弹性碰撞
    const ps = Object.values(this.players);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) elasticCollision(ps[i], ps[j]);

    // P4: 玩家收集资源（被攻击致死后跳过本 tick）
    for (const p of ps) {
      if (!p.alive) continue;
      const ix = Math.floor(p.x), iy = Math.floor(p.y);
      if (ix < 0 || iy < 0 || ix >= WORLD_W || iy >= WORLD_H) continue;
      const res = this.resources[ix][iy];
      if (res) {
        const rname = ['', 'wood', 'stone', 'ore', 'crystal', 'food'][res];
        if (rname) {
          this.tech[rname] = (this.tech[rname] || 0) + 1;
          p.score += 1;
          if (!p._stock) p._stock = { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 };
          p._stock[rname] = (p._stock[rname] || 0) + 1;
          this.resources[ix][iy] = 0;
          events.push({ type: 'gather', playerId: p.id, resource: rname });
        }
      }
    }

    // P5: 涌现信号 + 潮汐推进 + 算法风暴 + 大氧化事件
    this._advanceTide(events);
    this._tickOxidation(events);
    recognizeEmergent(this, this.tick);
    tickEmergent(this);
    this._applyTideSpawns(events);

    // P6: 玩家攻击 + 涌现单位碰撞伤害 + 胜利条件判定
    for (const p of ps) {
      if (!p.alive) continue;
      // 攻击：手动意图优先；无手动时自动锁定最近的敌对涌现单位（短距自动）。
      let atk = p._attackTarget;
      p._attackTarget = null;
      if (!atk && (p._atkCd || 0) <= 0) {
        const R2 = World.AUTO_ATTACK_R * World.AUTO_ATTACK_R;
        let best = null, bd = R2;
        // ① 优先锁定"威胁"（敌对单位 / 标注危险的单位）——避免旁边有只无害单位就不打敌人。
        for (const e of this.entities) {
          if (e.hp <= 0 || !(e.faction === 'hostile' || e.danger)) continue;
          const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
          if (d2 < bd) { bd = d2; best = e; }
        }
        // ② 射程内没有威胁时，**任意涌现单位**都可被攻击（否则被一堆 neutral 单位围着却"打不了"）。
        if (!best) {
          bd = R2;
          for (const e of this.entities) {
            if (e.hp <= 0) continue;
            const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
            if (d2 < bd) { bd = d2; best = e; }
          }
        }
        // 对手玩家/AI（PvP）：复活保护期内不可被锁定，避免刚出生就被秒
        for (const q of ps) {
          if (q === p || !q.alive || (q.invulnTicks || 0) > 0) continue;
          const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
          if (d2 < bd) { bd = d2; best = q; }
        }
        if (best) { atk = { tx: best.x, ty: best.y }; p._atkCd = World.ATK_COOLDOWN; }
      }
      if (atk) {
        let ax, ay;
        if (typeof atk === 'object' && atk.tx !== undefined) { ax = atk.tx; ay = atk.ty; }
        else { ax = p.x; ay = p.y; }
        // 服务端强制攻击落点必须在攻击者可达范围内（防改包客户端远程自瞄/穿距）：
        // 与自动瞄准同距 AUTO_ATTACK_R。超距则把落点沿原方向夹回该范围（保留"手动瞄准"手感，
        // 但杜绝从地图另一端锁敌打人）。net 层已校验 tx/ty 为有限数值，此处 ax/ay 必为有限。
        const reach = World.AUTO_ATTACK_R;
        const ddx = ax - p.x, ddy = ay - p.y;
        const dist = Math.hypot(ddx, ddy);
        if (dist > reach) {
          const k = reach / (dist || 1);
          ax = p.x + ddx * k;
          ay = p.y + ddy * k;
        }
        const R = 3;
        let best = null, bd = R * R;
        for (const e of this.entities) {
          if (e.hp <= 0) continue;   // 不限阵营：任意涌现单位都可被命中
          const d2 = (e.x - ax) ** 2 + (e.y - ay) ** 2;
          if (d2 < bd) { bd = d2; best = e; }
        }
        // PvP：落点附近的对手玩家/AI 也可命中（AI 对玩家的 attack 意图因此真正生效）
        let bestP = null, bdP = R * R;
        for (const q of ps) {
          if (q === p || !q.alive || (q.invulnTicks || 0) > 0) continue;
          const d2 = (q.x - ax) ** 2 + (q.y - ay) ** 2;
          if (d2 < bdP) { bdP = d2; bestP = q; }
        }
        if (bestP && (!best || bdP <= bd)) {
          // 命中对手玩家/AI
          const dmg = World.PVP_DMG;
          bestP.hp -= dmg;
          bestP.hitFlash = 6;
          bestP._regenLock = World.HP_REGEN_LOCK;
          if (!bestP._damagers) bestP._damagers = Object.create(null);
          bestP._damagers[p.id] = this.tick;
          const dx = bestP.x - p.x, dy = bestP.y - p.y; const l = Math.hypot(dx, dy) || 1;
          bestP.vx += (dx / l) * 0.6; bestP.vy += (dy / l) * 0.6;
          events.push({ type: 'hurt', playerId: bestP.id, dmg, by: p.id });
          if (bestP.hp <= 0) this._killPlayer(bestP, p, events);
        } else if (best) {
          const dmg = 8;
          best.hp -= dmg;
          // Track recent damagers so we can credit assists on the kill.
          if (!best._damagers) best._damagers = Object.create(null);
          best._damagers[p.id] = this.tick;
          events.push({ type: 'damage', target: best.id, dmg, by: p.id, kind: best.type });
          const dx = best.x - p.x, dy = best.y - p.y; const l = Math.hypot(dx, dy) || 1;
          best.vx += (dx / l) * 0.6; best.vy += (dy / l) * 0.6;
          if (best.hp <= 0) {
            p.score += 10;
            p.kills += 1;
            p.combo += 1;
            p.comboDecay = 60;
            if (p.combo > p.maxCombo) p.maxCombo = p.combo;
            if (p.combo >= 3) events.push({ type: 'combo', playerId: p.id, combo: p.combo });
            // Assist credit: anyone who damaged it in the last 5s (100 ticks)
            // other than the killer gets an assist and a small score bump.
            for (const pid of Object.keys(best._damagers || {})) {
              if (pid === p.id) continue;
              if (this.tick - best._damagers[pid] > 100) continue;
              const helper = this.players[pid];
              if (!helper) continue;
              helper.assists = (helper.assists || 0) + 1;
              helper.score += 3;
              events.push({ type: 'assist', playerId: pid, entityId: best.id });
            }
            // 击败头目型 = 1 碎片（用于奇点）；普通敌对 = 偶尔 1 碎片（30% 概率）
            const isBoss = best.mass >= 3;
            if (isBoss || this._rng() < 0.3) {
              if (!p._stock) p._stock = { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 };
              p._stock.shard = (p._stock.shard || 0) + 1;
              events.push({ type: 'shard', playerId: p.id, from: best.id });
            }
            events.push({ type: 'kill', playerId: p.id, entityId: best.id, kind: best.type });
          }
        }
      }
      if ((p._atkCd || 0) > 0) p._atkCd--;
      // 敌对涌现单位碰撞：距离 < 1.0 一击 25 HP（复活保护期内免伤）
      if (p.invulnTicks > 0) continue;
      for (const e of this.entities) {
        // 反击：敌对单位 + 标注为杀伤性的单位（火灵·灼烧 / 砂兽·冲撞）都会撞伤玩家。
        // 旧版只认 faction==='hostile' → 那 12 种 neutral 单位围着你却毫无威胁。
        if (e.hp <= 0 || !(e.faction === 'hostile' || e.danger)) continue;
        const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
        if (d2 < 1.0) {
          // 同一敌对单位每秒最多撞 1 次（用 e._hitCd 控制）
          e._hitCd = (e._hitCd || 0);
          if (e._hitCd > 0) continue;
          e._hitCd = 20; // 1s @ 20TPS
          const dmg = 18;   // ~6 hits per life (was 25 = 4 hits, too lethal for a 10min match)
          p.hp -= dmg;
          p.hitFlash = 6;
          p._regenLock = World.HP_REGEN_LOCK;
          events.push({ type: 'hurt', playerId: p.id, dmg, by: e.id });
          if (p.hp <= 0) this._killPlayer(p, null, events);
          break; // 1 tick 最多被 1 个单位撞
        }
      }
    }
    // 5s 后原位复活（HP 回满）
    for (const p of ps) {
      if (!p.alive) {
        // 已出局（棋盘被吃光 wiped / 死亡数达上限 military）不再复活——
        // 否则刚判出局又原地满血，玩家会觉得"根本打不死他"。
        if (p.lost) continue;
        if (p.respawnTicks > 0) p.respawnTicks--;
        if (p.respawnTicks <= 0 && !p.alive) {
          p.alive = true;
          p.hp = p.hpMax;
          p.invulnTicks = World.INVULN_TICKS;   // grace period after respawn
          if (p.deaths >= World.DEATH_LIMIT) {
            p.lost = true; p.lostReason = 'military';
            // 军事出局者不再存活（与 wiped 出局路径对齐）：
            // 上一行复活块刚把 alive=true/hp=hpMax，此处必须收回，否则出局者变成"满血幽灵"，
            // 仍被 P6 攻击循环锁定、可移动/攻击/收资源，与"已出局不再复活"的注释相悖。
            p.alive = false; p.hp = 0;
            // 出局者清空棋盘势力，让土地回归中立、对局可终结（≥30 分钟长局的关键）
            this._lifeWipeFaction(p);
            // F5（QA P2-3）：上一行刚设的 lostReason 必须塞进事件，否则客户端
            // 「military → 12 次死亡」的映射永远是死代码，玩家拿不到可行动信息。
            events.push({ type: 'eliminated', playerId: p.id, reason: p.lostReason || null });
          }
          else { events.push({ type: 'respawn', playerId: p.id }); }
        }
      }
    }

    // P6.5: 生命棋盘（移动即落子 → 定时演化 → 由细胞决定领地）+ 胜利条件
    // Move-to-place: every living player leaves a cell of their faction behind.
    for (const p of ps) if (p.alive) { p.aliveTicks = (p.aliveTicks || 0) + 1; }
    // Walking leaves a weak trail (free); seeds plant strong cells (a real decision).
    // 免费痕迹**只在"真正走了新的一格"时落**（不再每 0.1s 原地无限扩）：
    // 旧版站着不动也每 0.1s 刷一圈，影响范围几乎白送 → 落子（花种子）显得鸡肋。
    if (this.tick % World.SEED_COOLDOWN === 0) {
      for (const p of ps) {
        if (!p.alive) continue;
        const { lx, ly } = this._lifeXY(p.x, p.y);
        if (p._lastTrailLx === lx && p._lastTrailLy === ly) continue;   // 未换格 → 不重复落痕
        p._lastTrailLx = lx; p._lastTrailLy = ly;
        this._lifeTrail(p);
      }
    }
    for (const p of ps) {
      // 落子能力门：era≥1（多细胞）才演化出"组织分化"→ F 落子生效
      if (p.alive && p._plantIntent && (p.seeds || 0) > 0) {
        this._lifePlant(p);
        p.seeds--;
        events.push({ type: 'plant', playerId: p.id });
      } else if (p.alive && p._plantIntent && (p.era || 0) < 1) {
        events.push({ type: 'evolution_locked', playerId: p.id, need: 'village' });
      }
      p._plantIntent = false;
    }
    // Evolve the board on a fixed cadence so growth is visible but not chaotic.
    // （演化 + 死亡宽限 + 棋子近战吞噬都在 _lifeStep 内同拍结算，events 用于广播。）
    if (this.tick % World.LIFE_STEP_TICKS === 0) this._lifeStep(events);
    // 围棋式提子：无气的强细胞团被围死即清除（与演化同拍，保持确定性节奏）
    if (this.tick % World.LIFE_STEP_TICKS === 0) this._captureEnclosed(events);
    // Shapes are detected every tick so the HUD and resistance stay in sync.
    this._detectStrongholds();
    // MST supply network: do strongholds form a linked empire?
    this._updateNetwork();
    if (this.tick % World.STRONGHOLD_BONUS_TICKS === 0) {
      for (const p of ps) {
        // 要塞持续分设上限：防止"占满全图的要塞"每 5s 白嫖海量分数，
        // 把经济胜变成 5 分钟滚雪球（架空 30 分钟长局的领土主线）。
        const sh = Math.min(p.strongholds || 0, 12);
        if (sh) p.score += sh;
        if (p.network) {
          p.score += Math.min(p.strongholds || 0, 12);
          p._netBonus = (p._netBonus || 0) + 1;
          if (p._netBonus % 3 === 0) p.seeds = Math.min(World.SEED_MAX, (p.seeds || 0) + 1);
        }
      }
    }
    this._updateRegionControl();
    // 棋盘被吃光 = 出局（"一条命"，呼应回合围棋模式）：曾建立过规模后被清零 → 直接出局。
    // maxLifeCells 门槛保证刚出生/还没落子的玩家不会被误判出局。
    for (const p of ps) {
      if (p.lost) continue;
      // 康威语义：细胞归零是**常态**（振荡、灭绝都是自然结果），绝不能"当拍归零就出局"。
      // 旧规则会导致：玩家走过留下的痕被康威自然消掉 → 当拍 lifeCells===0 → 误判 wiped 出局
      //（实测：idle 玩家 ~17 tick 即被判出局），玩家根本来不及繁殖/对战。
      // 改为：曾建立过规模（maxLifeCells 达标）且**连续** WIPE_ZERO_TICKS 无强细胞，才判 wiped。
      if ((p.lifeCells || 0) === 0) { if (!p._zeroLifeAt) p._zeroLifeAt = this.tick; }
      else p._zeroLifeAt = 0;
      const zeroFor = p._zeroLifeAt ? (this.tick - p._zeroLifeAt) : 0;
      if ((p.maxLifeCells || 0) >= World.WIPE_ELIM_MIN_CELLS && (p.lifeCells || 0) === 0 &&
          zeroFor >= World.WIPE_ZERO_TICKS) {
        p.lost = true; p.lostReason = 'wiped';
        p.alive = false; p.hp = 0;
        this._lifeWipeFaction(p);
        events.push({ type: 'eliminated', playerId: p.id, reason: 'wiped' });
      }
    }
    this._tickEra(events);
    this._checkVictoryConditions(events);

    // P7: 事件聚合
    this.events = events;

    // P8: 实体上限保护
    if (this.entities.length > ENTITY_CAP) this.entities.length = ENTITY_CAP;

    // P9: tick 预算检查
    const dt = Date.now() - t0;
    if (dt > TICK_BUDGET_MS) events.push({ type: 'overBudget', tickMs: dt });

    this.lastTickedAt = Date.now();
    return { events, tickMs: dt };
  }

  // Tide state machine: prep -> surge -> rest -> prep -> ...
  // During surge, every 5 ticks (0.25s) we spawn hostile entities from the
  // map edge aimed at the nearest player. During prep/rest the world is calm.
  _advanceTide(events) {
    const t = this.tide;
    t.phaseTicks++;
    if (this.tick >= t.nextPhaseAt) {
      if (t.phase === 'prep') {
        t.phase = 'surge'; t.phaseTicks = 0; t.surgeCount++;
        t.nextPhaseAt = this.tick + 20 * TICK_RATE;  // 20s surge
        events.push({ type: 'tide_surge', surge: t.surgeCount });
      } else if (t.phase === 'surge') {
        t.phase = 'rest'; t.phaseTicks = 0;
        t.nextPhaseAt = this.tick + 10 * TICK_RATE;  // 10s rest
        events.push({ type: 'tide_rest' });
      } else {
        t.phase = 'prep'; t.phaseTicks = 0;
        t.nextPhaseAt = this.tick + 20 * TICK_RATE;  // 20s prep
        events.push({ type: 'tide_prep' });
      }
    }
    // Every 90s of in-game time, a "boss surge" doubles spawn count and adds a boss
    if (this.tick - t.lastBossAt >= 90 * TICK_RATE && t.phase === 'surge') {
      t.lastBossAt = this.tick;
      events.push({ type: 'tide_boss', surge: t.surgeCount });
    }
    // Every 5 minutes, an "algorithm storm" speeds up everything for 10s
    if (this.tick > 0 && this.tick % (300 * TICK_RATE) === 0) {
      t.stormCount++;
      events.push({ type: 'tide_storm', storm: t.stormCount });
    }
  }

  // During 'surge' phase: every 5 ticks spawn a hostile entity from the map
  // edge, aimed at the centroid of alive players. The "boss surge" event
  // triggers a 3x burst + one boss unit.
  _applyTideSpawns(events) {
    const t = this.tide;
    if (t.phase !== 'surge') return;
    // 演化纪元门：捕食者(潮汐)只有世界演化到"动植物"纪(era≥2)才出现。
    // 单细胞/多细胞期保留为"安全的演化观察期"。
    if (this.worldEpoch() < World.TIDE_ERA) return;
    const ps = Object.values(this.players).filter(p => p.alive);
    if (ps.length === 0) return;
    if (t.phaseTicks % 20 !== 0) return; // every 1s, not 0.25s
    // Player centroid
    let cx = 0, cy = 0;
    for (const p of ps) { cx += p.x; cy += p.y; }
    cx /= ps.length; cy /= ps.length;
    // Spawn count: base 1 per second, boss event adds 4 in one tick
    const boss = this.events && this.events.find(e => e.type === 'tide_boss');
    const burst = boss ? 5 : 1;
    const hostileTypes = ['sandbeast', 'fire', 'vine', 'ant', 'ring'];
    for (let i = 0; i < burst; i++) {
      const side = (i + this.tick) & 3; // 0/1/2/3
      let sx, sy;
      // 形状感知：board=null → 沿用原边缘生成（逐字节不变）；board 非空 → 边缘点若落在墙内，
      // 沿该边重试命中可通行点（形状外/虚空不生成潮汐）；仍失败 → 换到中心附近可通行点。
      let ok = false;
      for (let attempt = 0; attempt < 8 && !ok; attempt++) {
        if (side === 0) { sx = (attempt === 0 ? 0 : attempt); sy = this._rng() * WORLD_H; }
        else if (side === 1) { sx = WORLD_W - 1 - (attempt === 0 ? 0 : attempt); sy = this._rng() * WORLD_H; }
        else if (side === 2) { sx = this._rng() * WORLD_W; sy = (attempt === 0 ? 0 : attempt); }
        else { sx = this._rng() * WORLD_W; sy = WORLD_H - 1 - (attempt === 0 ? 0 : attempt); }
        ok = this._isPlayableWorld(Math.floor(sx), Math.floor(sy));
      }
      if (!ok) {
        sx = WORLD_W / 2; sy = WORLD_H / 2;
        if (this._bmp && !this._isPlayableWorld(Math.floor(sx), Math.floor(sy))) continue; // 形状外 → 放弃本次生成
      }
      const type = hostileTypes[(i + this.tick) % hostileTypes.length];
      const isBoss = boss && i === 0;
      const e = {
        id: 'tide_' + this.tick + '_' + i,
        type, name: isBoss ? ('头目·' + type) : type,
        x: sx, y: sy, vx: 0, vy: 0,
        hp: isBoss ? 30 : 8, hpMax: isBoss ? 30 : 8,
        mass: isBoss ? 4 : 1.5,
        speed: isBoss ? 0.6 : 0.4,
        color: isBoss ? '#ff3030' : null,
        faction: 'hostile',
        from: 'tide',
        life: isBoss ? 1200 : 600,
        born: this.tick,
        _hitCd: 0,
      };
      this.entities.push(e);
    }
  }

  // ---- Life board: players seed cells by moving; grid evolves by faction-aware
  // Conway rules; territory ownership is DERIVED from which faction dominates each
  // macro region. This replaces the old "stand still and accumulate" system. ----
  static LIFE_W = 32;            // 32x32 life grid (不变)；世界放大后 1 life cell = WORLD/LIFE_W 个世界格
  static MAX_SLOTS = 8;          // 一局最多 8 个玩家（人类 + AI，faction 1..8）
  // ---- 房主可调玩法参数（rts 与 go 共用）----
  // 一回合可下的棋子数：康威规则下三颗摆成 L 形会塌成 2×2 方块、直线三连是永不灭亡的
  // 闪烁器 —— 3 颗即"可存活的最小单位"，故设为默认值。
  static STONES_PER_TURN_DEFAULT = 3;
  static STONES_PER_TURN_MAX = 16;
  // 死亡宽限：孤子这种无法永久存活的单位，可设置"撑几个回合才死"（默认 0 = 立即死）。
  static LONELY_DEATH_DELAY_DEFAULT = 0;
  static LONELY_DEATH_DELAY_MAX = 10;
  // 电脑对手强度（房主可设）：1..5，默认 3 = 改动前行为（噪声 0.5 / 交战半径 12 / 每 tick 决策）。
  static AI_DIFFICULTY_DEFAULT = 3;
  static AI_DIFFICULTY_MIN = 1;
  static AI_DIFFICULTY_MAX = 5;
  // ---- 胜利线开关族（房主可配置；唯一事实源，三端共用）----
  // 键集；默认仅【领土】（避免"开局一方被秒 → 另一方立刻胜"的意外）。
  static VICTORY_LINE_KEYS = ['territory', 'economy', 'singularity', 'survival'];
  static VICTORY_LINE_DEFAULT = { territory: true, economy: false, singularity: false, survival: false };
  // 按模式可用的开关集：rts 4 条；go 仅【领土】（"吃光不算赢"→ go 无 survival）。
  static VICTORY_AVAILABLE = {
    rts: ['territory', 'economy', 'singularity', 'survival'],
    go: ['territory'],
  };
  // 门槛安全区间 [lo, hi]；默认值 = 原硬编码常量（不传时数值与现状一致）。
  static VICTORY_THRESHOLD_SPEC = {
    territoryRegions: { dflt: 16, lo: 6, hi: 40 },      // 原 World.TERRITORY_WIN = 16
    economyLead: { dflt: 600, lo: 200, hi: 2000 },      // 原字面量 600
    economyHoldTicks: { dflt: 1800, lo: 300, hi: 6000 },// 原字面量 1800
    singularityThreshold: { dflt: 30, lo: 6, hi: 200 }, // 原字面量 30
    deathLimit: { dflt: 12, lo: 3, hi: 50 },            // 原 World.DEATH_LIMIT = 12
  };
  /**
   * 该模式下可用的胜利线键集（副本，避免调用方误改常量）。
   * @param {('rts'|'go'|null|undefined)} mode
   * @returns {string[]}
   */
  static availableLines(mode) {
    return getMode(mode).availableVictoryLines.slice();
  }
  /**
   * 胜利线归一：非对象/非法 JSON → 默认；逐键仅接受 boolean；go 下强制关闭不可用线（防越权）。
   * @param {object|string|null|undefined} v
   * @param {('rts'|'go'|null|undefined)} mode
   * @returns {{territory:boolean, economy:boolean, singularity:boolean, survival:boolean}}
   */
  static normVictoryLines(v, mode) {
    let o = v;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    const out = { ...World.VICTORY_LINE_DEFAULT };
    if (o && typeof o === 'object') {
      for (const k of World.VICTORY_LINE_KEYS) if (typeof o[k] === 'boolean') out[k] = o[k];
    }
    // 模式门禁：非本模式可用胜利线强制关闭（如 go 只允许 territory）。
    const allow = getMode(mode).availableVictoryLines;
    for (const k of World.VICTORY_LINE_KEYS) if (!allow.includes(k)) out[k] = false;
    return out;
  }
  /**
   * rts 门槛归一：逐字段 _clampInt 到安全区间；非数字/空/非法 JSON → 默认。
   * @param {object|string|null|undefined} v
   * @returns {{territoryRegions:number, economyLead:number, economyHoldTicks:number,
   *            singularityThreshold:number, deathLimit:number}}
   */
  static normVictoryThresholds(v) {
    let o = v;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    const out = {};
    for (const [k, spec] of Object.entries(World.VICTORY_THRESHOLD_SPEC)) {
      const raw = (o && typeof o === 'object') ? o[k] : undefined;
      out[k] = World._clampInt(typeof raw === 'string' ? Number(raw) : raw, spec.dflt, spec.lo, spec.hi);
    }
    return out;
  }
  // 棋子近战吞噬：强细胞累积到该伤害即被击碎。
  static CELL_ATK_HP = 3;
  // ==================== 可编辑棋盘（形状 + 虚空格）· 单一事实源 ====================
  // 每格三态：0 = 形状外（棋盘之外）；1 = 可落子（形状内）；2 = 虚空格（形状内的"墙"）。
  // 语义（唯一契约）：0 与 2 在「不可落子 / 不计气 / 阻断连通 / 不参与计分」上**完全等价**，
  // 差异只存在于渲染/编辑器（UI 用不同色/底纹区分，见 Q1=a）。所有边界判定统一走 World.isWall。
  static SHAPE_OUT = 0;
  static SHAPE_PLAY = 1;
  static SHAPE_VOID = 2;
  /** 字符 → 三态值（序列化用）。'.'=形状外 '#'=可落子 'x'=虚空。 */
  static SHAPE_CHARS = { '.': 0, '#': 1, 'x': 2 };
  /** 三态值 → 字符（编码用）。索引即取值。 */
  static SHAPE_CHARS_INV = ['.', '#', 'x'];
  /** 画布尺寸上限 / 下限（方格数）。 */
  static BOARD_MAX = 128;          // 棋盘/生命层边长硬上限（与所有模式 boardMax 对齐；128=2^7，128/REGION_W=16 整数）
  static BOARD_MIN = 1;
  /**
   * 唯一墙判定纯函数：(lx,ly) 是否「不可落子 / 墙」——越界 ∪ 形状外 ∪ 虚空 → true。
   * bmp 为 null（未配置棋盘）时**逐字节等价于现状矩形越界判定**（不回归的底线）。
   * @param {Uint8Array|null} bmp 生命格粒度位图（行优先 bmp[ly*w+lx]，值 ∈ {0,1,2}）
   * @param {number} w 位图宽 @param {number} h 位图高
   * @param {number} lx @param {number} ly 生命格坐标
   * @returns {boolean}
   */
  static isWall(bmp, w, h, lx, ly) {
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return true;
    return bmp[ly * w + lx] !== World.SHAPE_PLAY;   // 0 或 2 → 墙
  }
  /**
   * 编码：{w,h,grid} → 紧凑串（行优先，'/' 分行，'.'/'#'/'x'）。grid[ly][lx] ∈ {0,1,2}。
   * @returns {string}
   */
  static encodeBoard(w, h, grid) {
    const rows = [];
    for (let ly = 0; ly < h; ly++) {
      let s = '';
      for (let lx = 0; lx < w; lx++) s += World.SHAPE_CHARS_INV[grid[ly][lx]] || '.';
      rows.push(s);
    }
    return rows.join('/');
  }
  /**
   * 解码：{w,h,shape} 紧凑串 → Uint8Array(w*h)（行优先 bmp[ly*w+lx]）。非法字符 → 形状外(0)。
   * @param {{w:number,h:number,shape:string}} cfg
   * @returns {Uint8Array}
   */
  static decodeBoard(cfg) {
    const w = cfg.w, h = cfg.h;
    const out = new Uint8Array(w * h);
    const rows = String(cfg.shape).split('/');
    for (let ly = 0; ly < h; ly++) {
      const row = rows[ly] || '';
      for (let lx = 0; lx < w; lx++) out[ly * w + lx] = World.SHAPE_CHARS[row[lx]] ?? 0;
    }
    return out;
  }
  /**
   * 棋盘形状归一（唯一实现；rooms.js 只转发，避免环依赖）。
   * 非法 / null / '' / 解析失败 / 行数或列数不符 / 全形状外 → null（回现状矩形）。
   * 字符合法性：非法字符宽容地视为形状外（不整体回默认）；但若没有任何可落子格 → 回默认。
   * @param {object|string|null|undefined} v {w,h,shape} 或 JSON 串
   * @param {('rts'|'go'|null|undefined)} mode 尺寸上限按模式：rts 生命层恒 32（棋盘只做遮罩）；go 1..100
   * @returns {{w:number,h:number,shape:string}|null}
   */
  static normBoard(v, mode) {
    let o = v;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return null; } }
    if (!o || typeof o !== 'object') return null;                    // E1/E12：无 shape → 默认矩形
    // 尺寸上限：由模式插件决定（rts 生命层恒 32；go 棋盘即棋盘 → 100；未指定 → 宽松 100）。
    const maxN = boardMaxForMode(mode);
    const w = World._clampInt(o.w, 0, World.BOARD_MIN, maxN);
    const h = World._clampInt(o.h, 0, World.BOARD_MIN, maxN);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < World.BOARD_MIN || h < World.BOARD_MIN) return null;
    const shape = String(o.shape == null ? '' : o.shape);
    const rows = shape.split('/');
    if (rows.length !== h) return null;                              // 行数不符 → 回默认
    for (const r of rows) if (r.length !== w) return null;           // 列数不符 → 回默认
    let hasPlay = false;
    for (const r of rows) for (const c of r) if (c === '#') { hasPlay = true; break; }
    if (!hasPlay) return null;                                       // E3：全形状外/全虚空 → 默认
    return { w, h, shape };
  }
  // ---- 预设模板（静态几何纯函数；islands 走 mulberry32 种子 rng，禁 Math.random）----
  /** 全可落子（经典矩形）。 */
  static _fillRect(w, h) {
    const g = [];
    for (let ly = 0; ly < h; ly++) { const r = []; for (let lx = 0; lx < w; lx++) r.push(1); g.push(r); }
    return g;
  }
  /** 十字：横竖两条臂（臂宽 = 居中 1/3 带，四角挖空）。 */
  static _genCross(w, h) {
    const g = World._fillRect(w, h);
    const bw = Math.max(1, Math.floor(w / 3));
    const bh = Math.max(1, Math.floor(h / 3));
    const x0 = Math.floor((w - bw) / 2), x1 = x0 + bw - 1;
    const y0 = Math.floor((h - bh) / 2), y1 = y0 + bh - 1;
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      const inX = lx >= x0 && lx <= x1, inY = ly >= y0 && ly <= y1;
      g[ly][lx] = (inX || inY) ? 1 : 0;              // 十字臂内可落子，四角为形状外
    }
    return g;
  }
  /** 城堡：矩形外框（厚墙）+ 内部庭院（可落子），四角留塔。 */
  static _genCastle(w, h) {
    const g = World._fillRect(w, h);
    const t = Math.max(1, Math.floor(Math.min(w, h) / 6));   // 墙厚
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      const edge = lx < t || ly < t || lx >= w - t || ly >= h - t;
      if (edge) g[ly][lx] = 1;                       // 外框（城墙）可落子
      else g[ly][lx] = 2;                            // 内庭挖成虚空（"护城河"）
    }
    // 四角塔（4×4）恢复为可落子，制造"据点感"
    const k = Math.min(t + 1, Math.floor(Math.min(w, h) / 4));
    for (let ly = 0; ly < k; ly++) for (let lx = 0; lx < k; lx++) {
      g[ly][lx] = 1;
      g[ly][w - 1 - lx] = 1;
      g[h - 1 - ly][lx] = 1;
      g[h - 1 - ly][w - 1 - lx] = 1;
    }
    return g;
  }
  /** 双岛：左半与右半两个矩形岛，中间竖带为形状外（隔断）。 */
  static _genTwins(w, h) {
    const g = World._fillRect(w, h);
    const gap = Math.max(1, Math.floor(w / 6));      // 中间隔断带
    const gx0 = Math.floor((w - gap) / 2), gx1 = gx0 + gap - 1;
    const m = Math.max(1, Math.floor(w / 8));         // 岛与边缘留空
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      const inGap = lx >= gx0 && lx <= gx1;
      const onIsland = (lx >= m && lx < gx0) || (lx > gx1 && lx < w - m);
      const onRow = ly >= m && ly < h - m;
      g[ly][lx] = (!inGap && onIsland && onRow) ? 1 : 0;
    }
    return g;
  }
  /** 回字：外环可落子，内圈挖成虚空（中空），再内可选中心小块。 */
  static _genRing(w, h) {
    const g = World._fillRect(w, h);
    const t = Math.max(1, Math.floor(Math.min(w, h) / 5));   // 环厚
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      const edge = lx < t || ly < t || lx >= w - t || ly >= h - t;
      g[ly][lx] = edge ? 1 : 2;                       // 边缘环可落子，内圈虚空
    }
    return g;
  }
  /**
   * 随机岛屿：种子 rng（mulberry32）生成块状可落子区 + 部分内部虚空。
   * 确定性：同 seed + 同尺寸 → 同形状（禁 Math.random / Date.now）。
   * @param {number} w @param {number} h @param {number} seed
   */
  static _genIslands(w, h, seed) {
    const rng = mulberry32((Number.isInteger(seed) && seed) ? seed : 1);
    const g = World._fillRect(w, h);
    // 先全置形状外，再用若干"团块"填充可落子格
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) g[ly][lx] = 0;
    const blobs = Math.max(3, Math.round((w + h) / 8));
    for (let b = 0; b < blobs; b++) {
      const cx = Math.floor(rng() * w), cy = Math.floor(rng() * h);
      const r = 1 + Math.floor(rng() * Math.max(1, Math.min(w, h) / 5));
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = 1;
      }
    }
    // 内部随机挖虚空（约 12% 可落子格）——同样走种子 rng
    for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
      if (g[ly][lx] === 1 && rng() < 0.12) g[ly][lx] = 2;
    }
    // 兜底：若无任何可落子格 → 回退整块矩形（保证 normBoard 不会拒绝）
    let hasPlay = false;
    for (let ly = 0; ly < h && !hasPlay; ly++) for (let lx = 0; lx < w; lx++) if (g[ly][lx] === 1) { hasPlay = true; break; }
    if (!hasPlay) return World._fillRect(w, h);
    return g;
  }
  /** 预设模板表：id → { label, gen(w,h,seed) → grid }。gen 返回 grid[ly][lx] ∈ {0,1,2}。 */
  static BOARD_PRESETS = {
    rect:    { label: '经典矩形', gen: (w, h) => World._fillRect(w, h) },
    cross:   { label: '十字',     gen: (w, h) => World._genCross(w, h) },
    castle:  { label: '城堡',     gen: (w, h) => World._genCastle(w, h) },
    twins:   { label: '双岛',     gen: (w, h) => World._genTwins(w, h) },
    ring:    { label: '回字',     gen: (w, h) => World._genRing(w, h) },
    islands: { label: '随机岛屿', gen: (w, h, seed) => World._genIslands(w, h, seed) },
  };
  /**
   * 生成某预设的形状配置（归一后）。非法 id → 回退经典矩形。
   * @param {string} id
   * @param {number} w @param {number} h @param {number} [seed]
   * @returns {{w:number,h:number,shape:string}|null}
   */
  static presetBoard(id, w, h, seed) {
    const p = World.BOARD_PRESETS[id] || World.BOARD_PRESETS.rect;
    const cw = World._clampInt(w, 0, World.BOARD_MIN, World.BOARD_MAX);
    const ch = World._clampInt(h, 0, World.BOARD_MIN, World.BOARD_MAX);
    if (!cw || !ch) return null;
    const grid = p.gen(cw, ch, seed);
    return World.normBoard({ w: cw, h: ch, shape: World.encodeBoard(cw, ch, grid) }, null);
  }
  // 把可空值收敛为 [lo,hi] 的整数，非法输入回落到默认值。
  static _clampInt(v, dflt, lo, hi) {
    const n = (typeof v === 'number' && Number.isFinite(v)) ? Math.floor(v) : dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  static LIFE_CELL = WORLD_W / 32;  // 6：一个生命格占 6x6 世界格（原 3）
  static LIFE_STEP_TICKS = 12;   // evolve every 12 ticks (0.6s) so growth is visible
  static SEED_COOLDOWN = 2;      // trail drop interval (0.1s)
  static DEATH_CELL_LOSS = 0.05; // fraction of cells lost on death
  // ---- Seeds: the scarce action economy. Walking is free (weak trail), but only a
  // spent seed plants a STRONG cell that holds ground and forms shapes. Choosing
  // WHERE to spend seeds is the core decision — this is what makes it a game.
  static SEED_MAX = 6;
  static SEED_REGEN_TICKS = 45;  // 2.25s per seed（大世界需要更快扩张）
  // 自动攻击：玩家（及 AI）靠近敌对涌现单位时自动开火，无需手动按键。
  // 短距(<=AUTO_ATTACK_R)才触发，配合冷却避免每 tick 全额输出。
  static AUTO_ATTACK_R = 4;
  static ATK_COOLDOWN = 8;        // 0.4s @ 20TPS
  // PvP：攻击（含自动攻击与 AI 的攻击意图）可命中对手玩家/AI。
  // 此前攻击只认 faction==='hostile' 的涌现单位 → 玩家/AI 之间根本无法互相伤害、
  // 也就永远无法让对手出局（AI 打玩家的 attack 意图一直是空转）。
  static PVP_DMG = 6;             // 每 0.4s 一击 → 约 7s 打死 100HP
  static PVP_KILL_SCORE = 25;     // 击杀玩家奖励（击杀涌现单位仅 10）
  // 棋盘被吃光 = 出局（呼应"一条命"）。需曾建立过规模才触发，
  // 避免刚出生/还没落子就被判出局。
  static WIPE_ELIM_MIN_CELLS = 4;
  static WIPE_ZERO_TICKS = 240;  // 细胞连续为 0 达 12s 才判 wiped（康威里归零是常态，不能当拍出局）
  static TRAIL_DECAY = 0.35;     // lone trail cells wither each evolution step
  static STRONGHOLD_BONUS_TICKS = 100;  // score payout cadence for held shapes
  // 势力半径：Voronoi 归属只在强细胞 INFLUENCE_R 生命格内有效，超出为中立。
  // R=3 ≈ 一个大区(4x4 生命格)的半宽：中心一颗强细胞能罩住本区，但罩不住邻区 →
  // 逼玩家每个大区都得有据点，形成真实的"逐区争夺"（R=6 会让一块 2x2 吞掉 9 个区）。
  static INFLUENCE_R = 2;
  // MST 连线预算：要塞彼此总跨度（生命格距离）<= 数量*预算 才算"连成帝国网"。
  static NETWORK_BUDGET = 12;
  static REGION_W = 8;           // 8x8 macro regions（不变：64 区、每区 4x4 生命格）
  static REGION_SIZE = 24;       // each region = WORLD/REGION_W = 24x24 world cells（原 12；随世界放大 2x）
  static REGION_WIN_COUNT = 6;   // regions owned for territory victory
  static TERRITORY_WIN = 16;     // regions needed at empire era to win by territory
  static DEATH_LIMIT = 12;       // deaths before elimination (was 5 — too punishing for a long match)
  // 敌对涌现实体的最小生成距离（世界单位）：候选点距任一存活玩家 < 此值 → 放弃本次生成。
  // 与 emergent.js 的 SAFE_SPAWN_DIST 同源，挂在 World 上供测试/常量查询统一引用。
  static SAFE_SPAWN_DIST = SAFE_SPAWN_DIST;
  static RESPAWN_TICKS = 100;    // 5s
  static INVULN_TICKS = 60;      // 3s grace after respawn (was easy to chain-kill)
  // 玩家被动回血：脱离战斗若干秒后缓慢恢复（解决"玩家不会回血"痛点）。
  // 受伤即触发 _regenLock，锁定期内不回血，避免"边挨打边满血"的滑稽局面。
  static HP_REGEN_LOCK = 100;    // 受伤后 5s 内不回血（@20TPS）
  static HP_REGEN_PER_TICK = 0.5; // 0.5/tick ≈ 10 HP/s，脱离战斗约 10s 回满
  static START_ERA = 0;          // 单细胞起跑：从"原生汤"开始演化，能力随纪元逐级解锁

  // 新玩家/AI 出生=单细胞（era 0）：只能移动+留痕。落子/攻击等能力靠"纪元里程碑"解锁。
  static _stampStartEra(p) {
    const e = World.ERAS[World.START_ERA] || World.ERAS[0];
    p.era = World.START_ERA;
    p.eraName = e.name;
    p.seedRadius = e.seedRadius;
    p.resist = e.resist;
    // 变异累计性状与移动速度上限（单细胞爬得很慢，演化后加快）
    p._speedMul = p._speedMul || 1;
    p._resistBonus = p._resistBonus || 0;
    p._seedMul = p._seedMul || 1;
    p._speedCap = e.maxV * p._speedMul;
    p.aliveTicks = p.aliveTicks || 0;
    p.maxLifeCells = p.maxLifeCells || 0;
    p.maxRegions = p.maxRegions || 0;
  }
  // 当前世界最强谱系的时代（所有玩家同享演化进度）
  worldEpoch() {
    let m = 0;
    for (const p of Object.values(this.players)) m = Math.max(m, p.era || 0);
    return m;
  }

  _lifeInit() {
    if (!this._life) {
      const N = this.lifeW || World.LIFE_W;
      this._life = Array.from({ length: N }, () => new Int8Array(N));
      this._lifeOwners = [];      // factionId-1 => playerId
      this._regionFaction = new Array(World.REGION_W * World.REGION_W).fill(0);
      this._lifeOwner = Array.from({ length: N }, () => new Int8Array(N));
      // 死亡宽限网格：-1 = 尚未获得宽限；>=0 = 剩余宽限回合数（无法存活的单位先撑一会儿）。
      this._lifeDoom = Array.from({ length: N }, () => new Int8Array(N).fill(-1));
      // 棋子伤害网格：强细胞累积的敌方攻击伤害（近战吞噬），>= CELL_ATK_HP 即被击碎。
      this._lifeDmg = Array.from({ length: N }, () => new Int8Array(N));
    }
  }
  // ---- 可编辑棋盘：编译 / 墙判定（生命格粒度）----
  /**
   * 编译棋盘配置为运行时位图。board 非法/为 null → 全走现状矩形（this.board=null, this._bmp=null）。
   * @param {object|string|null|undefined} raw 已归一或原始 board
   */
  _compileBoard(raw) {
    const cfg = World.normBoard(raw, this.mode);
    this._boardRev = (this._boardRev || 0) + 1;   // 形状变更版本号（低频下发用）
    this._boardMapSentRev = null;
    if (!cfg) {
      this.board = null; this._boardW = null; this._boardH = null; this._bmp = null;
      this._setLifeW(World.LIFE_W, false);        // 回默认矩形 → 生命层回 32
      return;
    }
    this.board = cfg;
    this._boardW = cfg.w;
    this._boardH = cfg.h;
    this._bmp = World.decodeBoard(cfg);
    // go 模式：生命层**只涨不缩** —— max(32, 棋盘宽, 棋盘高)。
    // 棋盘 ≤32 时保持 32×32（超出棋盘的部分由 World.isWall 判为墙，行为与改造前逐字节一致）；
    // 棋盘 >32 时扩容到棋盘尺寸，使 100×100 等大盘真正可用（此前会因坐标越界崩溃）。
    // rts：默认 board=null → 生命层回 32（1 生命格 = 6×6 世界格）；自定义棋盘 >32 时随棋盘扩容（max(32,w,h)）。
    // rts 棋盘上限 128（2 的幂：128/REGION_W=16 整数，区域控制对齐；normBoard 已限到 ≤128）。
    this._setLifeW(getMode(this.mode).growLifeLayer ? Math.max(World.LIFE_W, cfg.w, cfg.h) : World.LIFE_W, true);
  }
  /**
   * 设定生命层边长（内部）。若已有生命层且尺寸变化 → 置空触发 _lifeInit 重分配
   * （仅可能在棋局开始前发生：已开局的形状变更被路由层 403 board_locked 拦截）。
   * @param {number} n @param {boolean} followBoard 是否由棋盘推导（仅用于注释/调试）
   */
  _setLifeW(n, followBoard) {
    void followBoard;
    const v = World._clampInt(n, World.LIFE_W, 1, World.BOARD_MAX);
    if (this.lifeW === v) return;
    this.lifeW = v;
    if (this._life && this._life.length !== v) this._life = null;   // → _lifeInit 按新尺寸重建
  }
  /**
   * 实例墙判定便捷法（go/rts 统一用生命格坐标）。
   * board=null 时**逐字节等价**于现状 `lx<0||ly<0||lx>=LIFE_W||ly>=LIFE_W`（不回归底线）。
   * @param {number} lx @param {number} ly
   * @returns {boolean}
   */
  _isWall(lx, ly) {
    if (this._bmp) return World.isWall(this._bmp, this._boardW, this._boardH, lx, ly);
    const N = this.lifeW || World.LIFE_W;
    return lx < 0 || ly < 0 || lx >= N || ly >= N;
  }
  /** (lx,ly) 是否可落子（= 非墙）。 */
  _isPlayable(lx, ly) { return !this._isWall(lx, ly); }
  /**
   * 世界坐标 → 是否可通行（rts 世界格粒度；board=null → 恒 true）。
   * 世界格映射到生命格后判墙，仅用于生成物/出生点/寻路的形状感知。
   * @param {number} wx @param {number} wy 世界格坐标
   * @returns {boolean}
   */
  _isPlayableWorld(wx, wy) {
    if (!this._bmp) return true;
    if (wx < 0 || wy < 0 || wx >= WORLD_W || wy >= WORLD_H) return false;
    const { lx, ly } = this._lifeXY(wx, wy);
    return this._isPlayable(lx, ly);
  }
  _factionOf(playerId) {
    this._lifeInit();
    let i = this._lifeOwners.indexOf(playerId);
    if (i === -1) {
      // FIX-C1：优先复用被回收的空槽（null），避免 faction 号无限膨胀 —— 保证 2 人局
      // 拿到的阵营恒为 1/2；也保证被踢 AI 的空槽能再次利用。
      // ⚠️ _lifeOwners 的长度不能缩短（_lifeOwner 网格 / regionFaction 按 faction 号索引），
      //    只能置 null 复用。
      i = this._lifeOwners.indexOf(null);
      if (i === -1) { this._lifeOwners.push(playerId); i = this._lifeOwners.length - 1; }
      else this._lifeOwners[i] = playerId;
    }
    return i + 1;                 // 0 == empty
  }
  _lifeXY(x, y) {
    const c = World.LIFE_CELL;
    const N = this.lifeW || World.LIFE_W;
    return {
      lx: Math.max(0, Math.min(N - 1, Math.floor(x / c))),
      ly: Math.max(0, Math.min(N - 1, Math.floor(y / c))),
    };
  }
  // Cell encoding: 0 = empty, 1..8 = STRONG cell of faction n, 11..18 = weak TRAIL.
  // Trails are what you get for free by moving; strong cells cost a seed.
  static _isStrong = (v) => v > 0 && v <= 8;
  static _isTrail = (v) => v > 10;
  static _factionOfCell = (v) => (v > 10 ? v - 10 : v);
  // Walking leaves a WEAK trail: free presence that withers unless you spend a
  // seed nearby to anchor it. Cheap to make, easy for enemies to erase.
  _lifeTrail(p) {
    this._lifeInit();
    const { lx, ly } = this._lifeXY(p.x, p.y);
    const f = this._factionOf(p.id);
    const r = p.seedRadius || 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const nx = lx + dx, ny = ly + dy;
        if (this._isWall(nx, ny)) continue;
        // Never paint a trail over an existing strong cell (yours or an enemy's)
        if (World._isStrong(this._life[nx][ny])) continue;
        this._life[nx][ny] = f + 10;
      }
    }
  }
  // Spend a seed: plant ONE STRONG cell（落子 = 1 颗种子 = 1 格，回到"单子落子"）。
  // 需求返工（2026-09-10）：强细胞**不再豁免孤独死亡**，恢复标准康威 B3/S23 —— 单颗
  // 种子会因 0~1 邻而消亡（除非房主设置了死亡宽限 lonelyDeathDelay）。落子要有意义，
  // 需要玩家落下"可存活的最小单位"（成团/成线），这也是 go 模式默认一回合下 3 颗的原因。
  _lifePlant(p) {
    this._lifeInit();
    const { lx, ly } = this._lifeXY(p.x, p.y);
    const f = this._factionOf(p.id);
    // 形状/虚空感知：目标格非可落子（形状外 / 虚空）→ 拒绝落子（不消耗种子）。
    if (this._isWall(lx, ly)) return null;
    const v = this._life[lx][ly];
    // 不覆盖敌方强细胞（保留博弈空间）
    if (World._isStrong(v) && World._factionOfCell(v) !== f) return null;
    this._life[lx][ly] = f;
    return { lx, ly };
  }
  // Faction-aware Conway B3/S23: allies help you survive, enemies eat you.
  // `resist` (from era) makes mature factions harder to wipe out.
  // 需求返工（2026-09-10）：强细胞与弱痕**同一套存活判定**（标准 B3/S23），不再有孤子豁免；
  // 并引入"死亡宽限"（lonelyDeathDelay）与"棋子近战吞噬"（见 _cellCombat）。
  _lifeStep(events) {
    this._lifeInit();
    const W = this.lifeW;
    const resistOf = Object.create(null);
    for (const p of Object.values(this.players)) resistOf[this._factionOf(p.id)] = p.resist || 1.0;
    const sh = this._stronghold;   // undefined until first detection
    const next = Array.from({ length: W }, () => new Int8Array(W));
    // 死亡宽限：doom[x][y] = -1 未获宽限；>=0 剩余宽限回合数
    const doom = this._lifeDoom || Array.from({ length: W }, () => new Int8Array(W).fill(-1));
    const doomNext = Array.from({ length: W }, () => new Int8Array(W).fill(-1));
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        // 形状/虚空感知（★必须新增段落）：格子自身若是「虚空 / 形状外」→ next=0 且永不诞生，
        // 否则邻近细胞会在 n===3 时把棋盘外的格"诞生"出棋子。board=null 时该分支不进入（逐字节不变）。
        if (this._bmp && this._isWall(x, y)) { next[x][y] = 0; doomNext[x][y] = -1; continue; }
        const raw = this._life[x][y];
        const curF = World._factionOfCell(raw);
        let n = 0;
        const counts = Object.create(null);
        let allyStrongNear = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (this._isWall(nx, ny)) continue;
            const v = this._life[nx][ny];
            if (!v) continue;
            n++;
            const f = World._factionOfCell(v);
            counts[f] = (counts[f] || 0) + 1;
            if (World._isStrong(v) && f === curF) allyStrongNear++;
          }
        }
        if (raw) {
          const same = counts[curF] || 0;
          let enemy = 0;
          for (const f in counts) if (+f !== curF) enemy += counts[f];
          // A 2x2 stronghold doubles resistance: concrete payoff for building shape.
          const anchor = sh && sh[x][y] ? 2 : 1;
          const tol = same * (resistOf[curF] || 1.0) * anchor;
          // 标准康威 B3/S23 —— 但邻域**只数己方**（allyN）：敌方格交给 _cellCombat 近战结算。
          // 旧版把敌方也算进 n（n = 己方 + 敌方）→ 贴脸时 n>=4 被判"过拥挤"当拍同归于尽，
          // 于是"棋子打不起来 / 敌人也不打我"（演化先把双方清光，近战永远轮不到）。
          const allyN = same;
          let alive = (allyN === 2 || allyN === 3) && enemy <= tol;
          if (alive && !World._isStrong(raw)) {
            // 弱痕（走过免费留下的）无己方强细胞锚定时会枯萎。
            if (allyStrongNear === 0 && this._rng() < World.TRAIL_DECAY) alive = false;
          }
          // 死亡宽限：无法存活的单位不立即死，先给 lonelyDeathDelay 个回合并逐回合递减。
          if (!alive) {
            let d = doom[x][y];
            if (d < 0) d = this.lonelyDeathDelay;   // 首次失败 → 发放宽限（delay=0 即立即死）
            if (d > 0) { alive = true; doomNext[x][y] = d - 1; }
            else doomNext[x][y] = -1;               // 宽限耗尽 → 死
          } else {
            doomNext[x][y] = -1;                    // 恢复健康 → 宽限清零
          }
          next[x][y] = alive ? raw : 0;
        } else if (n === 3) {
          // 诞生（B3）：三邻居中必须有一方**占多数（≥2）**才诞生。
          // 旧实现用"第一个扫到的阵营"决胜（dx/dy 从 -1 开始），等于给了 (-1,-1) 方向
          // 一个恒定的优先权 —— 这是**坐标系偏序**，违反"算法是世界法则、世界无偏序"。
          // 三方各 1 时无人主导 → 不出生（与"多数决"同源，且完全确定）。
          let bestF = 0, bestC = 0;
          for (const f in counts) if (counts[f] > bestC) { bestC = counts[f]; bestF = +f; }
          if (bestC < 2 || !bestF) { next[x][y] = 0; continue; }
          // 恢复"正常繁殖"（原行为）：三邻居决出多数阵营 → **直接诞生该阵营的活细胞**。
          // 返工曾把"无 ≥2 强亲代"的诞生降级为弱痕（bestF+10），而弱痕在无强细胞锚定时按
          // TRAIL_DECAY 逐拍枯萎 → 玩家看到"细胞不繁殖"。这里还原为标准康威：诞生 = 活细胞。
          next[x][y] = bestF;
        } else next[x][y] = 0;
      }
    }
    this._life = next;
    this._lifeDoom = doomNext;
    // 棋子近战吞噬：在演化之后结算（与演化同拍，保持确定性节奏）
    this._cellCombat(events, resistOf, sh);
  }
  // 棋子近战吞噬（格子对格子磨血）——只在 _lifeStep 内结算（每 0.6s 一拍，非每 tick）。
  //  · 己方强细胞邻接的**敌方弱痕（f+10）直接被打掉**（吞噬，立即清除）；
  //  · 己方强细胞邻接的**敌方强细胞累积伤害**：dmg += max(1, atkIn)；
  //      atkIn = 该格 8 邻中敌方强细胞数（围攻数，越大越快）；
  //    本拍未受攻击的格子缓慢自愈（dmg-1，避免永久留疤）；
  //  · 减伤走"**阈值侧**"（而非旧的伤害侧 floor）：击碎所需累计伤害随 resist 单调提高：
  //      killAt = ceil(CELL_ATK_HP * resist * anchor)，anchor = 2（2×2 要塞内）否则 1；
  //      dmg >= killAt → 强细胞被击碎（清除）。这样 resist 1.0~1.99 也有真实减伤效果（无 floor 死区）。
  _cellCombat(events, resistOf, sh) {
    this._lifeInit();
    const W = this.lifeW;
    const L = this._life;
    const dmg = this._lifeDmg;
    const dir8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    // 阶段一：吞噬敌方弱痕（读取快照，避免迭代中改写棋盘导致的次序依赖）
    const eaten = new Map();   // key(x*W+y) -> { x, y, f, by }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        // 攻击方 = 己方**任意**细胞（强细胞或弱痕）。旧版要求攻击方必须是强细胞，
        // 导致"只是走过留下痕迹"的玩家完全不参与战斗（与"细胞应该会攻击"相悖）。
        const atkVal = L[x][y];
        if (!atkVal) continue;                      // 空格不是攻击方
        const atkF = World._factionOfCell(atkVal);
        for (const [dx, dy] of dir8) {
          const nx = x + dx, ny = y + dy;
          if (this._isWall(nx, ny)) continue;
          const v = L[nx][ny];
          if (!World._isTrail(v)) continue;         // 只吞噬弱痕
          const tf = v - 10;
          if (tf === atkF) continue;                // 己方弱痕不吞噬
          const key = nx * W + ny;
          if (!eaten.has(key)) eaten.set(key, { x: nx, y: ny, f: tf, by: atkF });
        }
      }
    }
    for (const e of eaten.values()) {
      L[e.x][e.y] = 0;
      if (events) events.push({ type: 'cell_eaten', x: e.x, y: e.y, f: e.f, by: e.by });
    }
    // 阶段二：对敌方强细胞累积伤害 / 击碎；未被攻击的强细胞缓慢自愈。
    // ⚠ 去"棋盘坐标偏序"（铁律：算法是世界法则，世界法则不该有坐标系偏序）：
    //   本阶段**先全部累加、再统一判定清除**——任何清除都不影响本拍的攻击计数，
    //   故 1v1 贴脸的两方会在**同一拍双双被清除**（同拍互灭），不再出现"谁下标小谁先死"。
    const ndGrid = Array.from({ length: W }, () => new Int32Array(W));   // 本拍结算后的伤害值（临时）
    const killFlag = Array.from({ length: W }, () => new Uint8Array(W)); // 本拍是否被击碎
    const atkFlag = Array.from({ length: W }, () => new Uint8Array(W));  // 本拍是否受到攻击
    // 2-A：只计算（读"未做任何阶段二清除"的棋盘，保证攻击计数与本拍清除无关）
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        const raw = L[x][y];
        if (!World._isStrong(raw)) continue;   // 非强细胞：ndGrid/flags 默认 0
        const defF = raw;
        let atkIn = 0;
        for (const [dx, dy] of dir8) {
          const nx = x + dx, ny = y + dy;
          if (this._isWall(nx, ny)) continue;
          const v = L[nx][ny];
          if (World._isStrong(v) && v !== defF) atkIn++;
        }
        if (atkIn <= 0) {
          // 本拍未受攻击 → 缓慢自愈
          ndGrid[x][y] = Math.max(0, dmg[x][y] - 1);
          continue;
        }
        atkFlag[x][y] = 1;
        const anchor = sh && sh[x][y] ? 2 : 1;
        // 减伤在"阈值侧"：击碎所需累计伤害随 resist 单调提高（无 floor 死区）。
        // killAt = ceil(CELL_ATK_HP * resist * anchor)：resist 1.0→3、1.15→4、1.5→5、2.0→6、3.0→9；
        // 2×2 要塞(anchor=2) 阈值翻倍（6/7/9/12/18…）。
        const killAt = Math.ceil(World.CELL_ATK_HP * (resistOf[defF] || 1.0) * anchor);
        const incoming = Math.max(1, atkIn);   // 伤害仅与围攻数相关（atkIn≥1），≥1/拍
        const nd = dmg[x][y] + incoming;
        ndGrid[x][y] = nd;
        if (nd >= killAt) killFlag[x][y] = 1;
      }
    }
    // 2-B：统一结算（清除 + 写回 + 事件）——与 2-A 的攻击计数完全分离，去掉坐标偏序。
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        if (killFlag[x][y]) {
          const f = L[x][y];
          L[x][y] = 0;
          dmg[x][y] = 0;
          if (events) events.push({ type: 'cell_hit', x, y, f, dmg: ndGrid[x][y], killed: true });
        } else if (atkFlag[x][y]) {
          dmg[x][y] = ndGrid[x][y];
          if (events) events.push({ type: 'cell_hit', x, y, f: L[x][y], dmg: ndGrid[x][y] });
        } else {
          dmg[x][y] = ndGrid[x][y];   // 未受攻击（自愈）或非强细胞（=0）
        }
      }
    }
  }
  // 围棋式提子（气/围死规则）：强细胞团若 8 邻全无"气"（既无空格、也无己方细胞），
  // 即被围死 → 整团清除，围杀方（邻接最多的敌方）得分。这就是"把对手围死"的可读博弈。
  _captureEnclosed(events) {
    this._lifeInit();
    const L = this._life;
    const W = L.length;
    const seen = Array.from({ length: W }, () => new Uint8Array(W));
    const dir4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const dir8 = dir4.concat([[1, 1], [-1, 1], [1, -1], [-1, -1]]);
    for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
      const v = L[x][y];
      if (!World._isStrong(v) || seen[x][y]) continue;
      // 4-连通收集同势力团
      const comp = [];
      seen[x][y] = 1;
      const stack = [[x, y]];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        comp.push([cx, cy]);
        for (const [dx, dy] of dir4) {
          const nx = cx + dx, ny = cy + dy;
          if (this._isWall(nx, ny)) continue;
          if (!seen[nx][ny] && L[nx][ny] === v) { seen[nx][ny] = 1; stack.push([nx, ny]); }
        }
      }
      // 数气 + 统计邻接敌势力（用于归功）
      let libs = 0;
      const neighF = {};
      for (const [cx, cy] of comp) {
        for (const [dx, dy] of dir8) {
          const nx = cx + dx, ny = cy + dy;
          if (this._isWall(nx, ny)) continue;
          const nv = L[nx][ny];
          if (nv === 0) libs++;               // 空格 = 气
          else if (nv === v) libs++;          // 己方细胞 = 气（不算自杀）
          else neighF[World._factionOfCell(nv)] = (neighF[World._factionOfCell(nv)] || 0) + 1;
        }
      }
      if (libs > 0 || comp.length === 0) continue;
      // 无气 → 提子
      for (const [cx, cy] of comp) L[cx][cy] = 0;
      let capF = 0, best = 0;
      for (const nf in neighF) if (neighF[nf] > best) { best = neighF[nf]; capF = +nf; }
      const capPid = capF ? this._lifeOwners[capF - 1] : null;
      const cp = capPid ? this.players[capPid] : null;
      if (cp) {
        const pts = comp.length * 5;
        cp.score += pts;
        if (cp._stock) cp._stock.shard = (cp._stock.shard || 0) + comp.length; // 提子=夺碎块
      }
      if (events && capPid) events.push({ type: 'capture', playerId: capPid, cells: comp.length, lx: x, ly: y });
    }
  }
  // Detect 2x2 blocks of strong cells ("strongholds"). This is the shape players
  // aim for: it anchors ground, resists being eaten, and scores over time.
  _detectStrongholds() {
    this._lifeInit();
    const W = this.lifeW;
    if (!this._stronghold) this._stronghold = Array.from({ length: W }, () => new Uint8Array(W));
    for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) this._stronghold[x][y] = 0;
    const perFaction = Object.create(null);
    this._strongholdReps = {};
    for (let x = 0; x < W - 1; x++) {
      for (let y = 0; y < W - 1; y++) {
        const a = this._life[x][y];
        if (!World._isStrong(a)) continue;
        if (a === this._life[x + 1][y] && a === this._life[x][y + 1] && a === this._life[x + 1][y + 1]) {
          this._stronghold[x][y] = 1; this._stronghold[x + 1][y] = 1;
          this._stronghold[x][y + 1] = 1; this._stronghold[x + 1][y + 1] = 1;
          perFaction[a] = (perFaction[a] || 0) + 1;
          (this._strongholdReps[a] = this._strongholdReps[a] || []).push({ x, y });
        }
      }
    }
    for (const p of Object.values(this.players)) {
      p.strongholds = perFaction[this._factionOf(p.id)] || 0;
    }
  }

  // MST supply network: a player's strongholds connected via Prim's MST within a distance
  // budget form a "linked empire" that earns a bonus. Rewards deliberate base-building:
  // cluster your 2x2 strongholds so they're mutually reachable, not scattered.
  _updateNetwork() {
    const fn = World.kernelRegistry && World.kernelRegistry.get('mst_prim');
    for (const p of Object.values(this.players)) p.network = false;
    if (!fn || !this._strongholdReps) return;
    for (const p of Object.values(this.players)) {
      const f = this._factionOf(p.id);
      const reps = this._strongholdReps[f] || [];
      if (reps.length < 2) continue;
      const nodes = reps.map((_, i) => i);
      const edges = [];
      for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) {
        const d = Math.hypot(reps[i].x - reps[j].x, reps[i].y - reps[j].y);
        edges.push([i, j, d]);
      }
      const mst = fn(null, this._rng, { nodes, edges }).edges || [];
      const connected = mst.length === reps.length - 1;
      let total = 0; for (const e of mst) total += e[1];   // mst_prim 返回 [vertex, weight]
      p.network = connected && total <= reps.length * World.NETWORK_BUDGET;
    }
  }
  // 击杀玩家/AI：统一的死亡结算（复活倒计时、扣分、损失细胞）+ 击杀者奖励。
  // 抽成公共方法的原因：此前死亡结算只写在"敌对涌现单位碰撞"分支里，
  // 导致 PvP 把对手打到 hp<=0 时不会真正死亡（一直卡在负血、也不会计入 deaths）。
  _killPlayer(p, killer, events) {
    if (!p.alive) return;
    p.alive = false; p.deaths += 1;
    p.hp = 0;
    p.respawnTicks = World.RESPAWN_TICKS;
    p.score = Math.max(0, p.score - 20); // 死亡扣分
    // Death penalty: lose 30% of living cells + 10% shard.
    this._lifePenalty(p, World.DEATH_CELL_LOSS);
    if (p._stock && p._stock.shard > 0) {
      p._stock.shard = Math.floor(p._stock.shard * 0.9);
    }
    events.push({ type: 'death', playerId: p.id });
    if (killer && killer !== p) {
      killer.score += World.PVP_KILL_SCORE;
      killer.kills += 1;
      killer.combo += 1;
      killer.comboDecay = 60;
      if (killer.combo > killer.maxCombo) killer.maxCombo = killer.combo;
      events.push({ type: 'kill', playerId: killer.id, victimId: p.id, kind: 'player' });
    }
  }
  // Death costs board position: wipe a fraction of the player's living cells.
  _lifePenalty(p, ratio) {
    this._lifeInit();
    const f = this._factionOf(p.id);
    for (let x = 0; x < this.lifeW; x++) {
      for (let y = 0; y < this.lifeW; y++) {
        if (this._life[x][y] === f && this._rng() < ratio) this._life[x][y] = 0;
      }
    }
  }
  // Elimination (out of the match): wipe ALL of the faction's cells so their land
  // returns to neutral and the survivors can still reach a territory victory.
  _lifeWipeFaction(p) {
    // 从未上过棋盘（_life 未初始化）的玩家无可擦：直接返回，避免为离场者新建
    // 阵营槽位/数组（_factionOf 会向 _lifeOwners push）。
    if (!this._life) return;
    const f = this._factionOf(p.id);
    for (let x = 0; x < this.lifeW; x++) {
      for (let y = 0; y < this.lifeW; y++) {
        // F3（QA P2-1）：弱痕（f+10）也要擦。只擦强细胞会留下 ~10 格弱痕，而弱痕
        // 仍参与 _lifeStep 的邻域计数，n===3 时能再生出强细胞 → 幽灵势力低概率复活
        // 并污染 regionFaction。（_lifePenalty 仍只作用于强细胞：死亡惩罚不该顺带清痕迹。）
        const v = this._life[x][y];
        if (v === f || v === f + 10) {
          this._life[x][y] = 0;
          // 同时复位该格的宽限与伤害状态（避免残留影响复用该槽位的新势力）。
          if (this._lifeDoom) this._lifeDoom[x][y] = -1;
          if (this._lifeDmg) this._lifeDmg[x][y] = 0;
        }
      }
    }
  }
  // 个体的"影响范围"（Voronoi 归属半径）随演化纪元逐步扩大：
  // 单细胞 1 → 多细胞 2 → 动植物 3 → 生态 4（见 ERAS.influenceR）。
  // 并且会"退化"：棋盘势力被吃崩（当前强细胞数不足该纪元门槛的一半）时影响力萎缩一级。
  _influenceR(p) {
    const era = Math.max(0, Math.min(World.ERAS.length - 1, p.era || 0));
    let r = World.ERAS[era].influenceR;
    const need = World.ERAS[era].cells || 0;
    if (need > 0 && (p.lifeCells || 0) * 2 < need) r = Math.max(1, r - 1);
    return r;
  }
  // Territory = which faction owns each macro region, where ownership is decided by a
  // Voronoi partition of the life board: every life cell belongs to the faction of its
  // NEAREST STRONG cell (within INFLUENCE_R), else it is neutral. This makes borders
  // smooth and contestable — drop a strong cell near the enemy line and you flip ground.
  // This is the "Go/Chess-like" spatial game: WHERE you plant matters, not just that you plant.
  _updateVoronoi(rOverride) {
    this._lifeInit();
    const W = this.lifeW;
    if (!this._lifeOwner) this._lifeOwner = Array.from({ length: W }, () => new Int8Array(W));
    // Collect strong-cell sites (faction 1..8) as Voronoi seeds.
    const sites = [];
    for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
      const v = this._life[x][y];
      if (World._isStrong(v) && !(this._bmp && this._isWall(x, y))) sites.push({ x, y, f: v });
    }
    if (!sites.length) {
      for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) this._lifeOwner[x][y] = 0;
      this._regionFaction.fill(0);
      return;
    }
    const fn = World.kernelRegistry && World.kernelRegistry.get('voronoi');
    const owner = fn ? fn(null, this._rng, { sites, w: W, h: W }).cells
                     : Array.from({ length: W }, () => new Array(W).fill(-1));
    // 影响范围按阵营（演化纪元）分别计算：纪元越高范围越大；势力被吃崩时会退化。
    // rOverride != null（go 模式的呼吸半径）时，所有阵营统一用该值：
    // 领地边界随之"涨潮/退潮"——这是 go 模式"不可预测的数学"机制之一。
    const r2ByF = Object.create(null);
    for (const p of Object.values(this.players)) {
      const r = (rOverride != null) ? rOverride : this._influenceR(p);
      p.influenceR = r;                       // 供 HUD 显示"当前影响范围"
      r2ByF[this._factionOf(p.id)] = r * r;
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
      // 形状/虚空感知：墙格（形状外 / 虚空）不参与势力归属（否则 Voronoi 会蔓延到棋盘外）。
      if (this._bmp && this._isWall(x, y)) { this._lifeOwner[x][y] = 0; continue; }
      const si = owner[x][y];
      if (si < 0) { this._lifeOwner[x][y] = 0; continue; }
      const s = sites[si];
      const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
      const r2 = r2ByF[s.f] != null ? r2ByF[s.f] : World.INFLUENCE_R * World.INFLUENCE_R;
      this._lifeOwner[x][y] = d2 <= r2 ? s.f : 0;   // beyond radius -> neutral
    }
  }

  // Territory = which faction has the most owned life cells in each macro region.
  _updateRegionControl() {
    this._lifeInit();
    const W = this.lifeW;
    // 1) Voronoi ownership of every life cell.
    this._updateVoronoi();
    const owner = this._lifeOwner;
    // 2) Strong-cell counts -> lifeCells; per-region ownership -> regionFaction.
    const cellCounts = Object.create(null);
    const perRegion = this.lifeW / World.REGION_W;  // 32/8 = 4 life cells per region side（与 REGION_SIZE/世界格 无关，随生命格推导）
    const counts = Array.from({ length: World.REGION_W * World.REGION_W }, () => Object.create(null));
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        // 形状/虚空感知：墙格不计入区域归属与强细胞数（形状外/虚空不参与区域争夺）。
        if (this._bmp && this._isWall(x, y)) continue;
        const v = this._life[x][y];
        if (World._isStrong(v)) cellCounts[v] = (cellCounts[v] || 0) + 1;
        const f = owner[x][y];
        if (!f) continue;
        const rid = Math.floor(y / perRegion) * World.REGION_W + Math.floor(x / perRegion);
        counts[rid][f] = (counts[rid][f] || 0) + 1;
      }
    }
    // 只有真正占到大区过半格（8/16）才算拥有该区——否则单颗孤子伸进去一格就占区，
    // 会让"逐区争夺"失去意义（一块 2x2 就能翻遍半张图）。
    const regionCells = perRegion * perRegion;   // 16
    for (let i = 0; i < counts.length; i++) {
      let bestF = 0, bestC = 0;
      for (const f in counts[i]) if (counts[i][f] > bestC) { bestC = counts[i][f]; bestF = +f; }
      this._regionFaction[i] = bestC >= regionCells / 2 ? bestF : 0;
    }
    for (const p of Object.values(this.players)) {
      const f = this._factionOf(p.id);
      let n = 0;
      for (const o of this._regionFaction) if (o === f) n++;
      p.regionsOwned = n;
      p.maxRegions = Math.max(p.maxRegions || 0, n);
      p.lifeCells = cellCounts[f] || 0;
      p.maxLifeCells = Math.max(p.maxLifeCells || 0, p.lifeCells);
    }
  }
  // ---- Eras（演化纪元）：单细胞 → 多细胞 → 动植物 → 生态系统。
  // 时代推进 = 能力解锁：era0 锁种子（无"分化组织"能力）→ era1 解锁 F 落子
  // → era2 潮汐捕食者出现（TIDE_ERA）→ era3 领土胜开放。
  // 门槛以"存活时间"为主：era0→1 仅需 30s 存活（cells=0，避免无法落子卡死）；
  // era1→2/3 要求细胞与大区，由玩家主动演化达成。Ticks 为 20 TPS。
  // 单局时长校准（2026-02，用户反馈"太长谁都赢不了"）：
  //   原 era3 empire = 64000 tick ≈ 53 分钟 → 长到双方都够不到胜利线、对局永不终结。
  //   目标：一个**正常发育**的玩家 15–20 分钟内能升到 era3 并触碰领土/经济胜利线。
  //   ticks 64000→24000（20 分钟）；cells 140→90、regions 8→6 相应下调，
  //   使 era3 可在合理发育节奏内达成（保留"必须真正扩张/占地才能晋级"的设计意图）。
  //   实测依据：ai capture 探针中 AI 在 3000 tick 内已达 lifeCells≈42 / regions≈18；
  //   正常人类玩家 20 分钟内的 cell/region 上限远高于 90/6。
  // era1 600 tick（30s）、era2 city 5400 tick（4.5min，开放潮汐捕食）保持不变。
  static ERAS = [
    { name: 'tribe',   ticks: 0,     cells: 0,   regions: 0, seedRadius: 0, resist: 1.0, maxV: 0.7,  influenceR: 1 },
    { name: 'village', ticks: 600,   cells: 0,   regions: 0, seedRadius: 0, resist: 1.5, maxV: 1.0,  influenceR: 2 },
    { name: 'city',    ticks: 5400,  cells: 60,  regions: 2, seedRadius: 1, resist: 2.0, maxV: 1.45, influenceR: 2 },
    { name: 'empire',  ticks: 24000, cells: 90,  regions: 6, seedRadius: 1, resist: 3.0, maxV: 1.9,  influenceR: 2 },
  ];
  // 演化晋升时的随机变异池（确定性 RNG 掷出，每局演化出的"性状"不同）
  static MUTATIONS = [
    { key: 'speed', label: '鞭毛初现：游动更快', effect: 'speed' },
    { key: 'membrane', label: '细胞膜增厚：抗吞噬 +0.15', effect: 'resist' },
    { key: 'metabolism', label: '代谢加快：种子回速 +25%', effect: 'seed' },
  ];
  // 潮汐（敌对捕食者）从"动植物"纪（era2）才开始从边缘涌入
  static TIDE_ERA = 2;
  // 大氧化事件：90s（1800 tick）时由"蓝细菌"把世界带入有氧纪（类比 ~2.4 Ga GOE）。
  // 有氧代谢的产能远高于无氧发酵 → 有氧纪后生物更快、抗吞噬更强、种子回速更快。
  static OXIC_TICK = 1800;
  // 大氧化事件：无氧纪 → 有氧纪的世界级跃迁（确定性，仅按 tick 触发一次）
  _tickOxidation(events) {
    if (this.oxic || this.tick < World.OXIC_TICK) return;
    this.oxic = true;
    // 有氧呼吸产能远高于无氧发酵：速度/代谢/耐氧全面提升（只惠及已"多细胞"的谱系）
    for (const p of Object.values(this.players)) {
      if (!p || (p.era || 0) < 1) continue;
      p._speedMul = (p._speedMul || 1) + 0.15;
      p._seedMul = (p._seedMul || 1) + 0.5;
      p._resistBonus = (p._resistBonus || 0) + 0.2;
      p._oxic = true;
    }
    if (events) events.push({ type: 'oxidation', tick: this.tick });
  }
  _tickEra(events) {
    for (const p of Object.values(this.players)) {
      if (p.era === undefined) p.era = 0;
      const prevEra = p.era;
      let target = p.era;
      for (let i = World.ERAS.length - 1; i > p.era; i--) {
        const e = World.ERAS[i];
        if ((p.aliveTicks || 0) >= e.ticks && (p.maxLifeCells || 0) >= e.cells && (p.maxRegions || 0) >= e.regions) { target = i; break; }
      }
      // Eras never regress — a temporary cell drought shouldn't undo progress.
      if (target > p.era) p.era = target;
      p.eraName = World.ERAS[p.era].name;
      p.seedRadius = World.ERAS[p.era].seedRadius;
      // 变异累计性状 + 随纪元的移动速度（演化 → 运动能力涌现）
      p._speedMul = p._speedMul || 1;
      p._resistBonus = p._resistBonus || 0;
      p._seedMul = p._seedMul || 1;
      p._speedCap = World.ERAS[p.era].maxV * p._speedMul;
      p.resist = World.ERAS[p.era].resist + p._resistBonus;
      p.seedRegenTicks = Math.max(12, Math.round(World.SEED_REGEN_TICKS / p._seedMul));
      if (p.era > prevEra && events) {
        // 随机变异（确定性 RNG，非 Math.random）：晋升时掷一个生物性状，每局不同
        let mutation = null;
        if (p.era >= 1) {
          const m = World.MUTATIONS[Math.floor(this._rng() * World.MUTATIONS.length)];
          if (m) {
            if (m.effect === 'speed') p._speedMul += 0.12;
            else if (m.effect === 'resist') p._resistBonus += 0.15;
            else p._seedMul += 0.25;
            p._mutations = (p._mutations || 0) + 1;
            mutation = m.label;
            p._speedCap = World.ERAS[p.era].maxV * p._speedMul;
            p.resist = World.ERAS[p.era].resist + p._resistBonus;
            p.seedRegenTicks = Math.max(12, Math.round(World.SEED_REGEN_TICKS / p._seedMul));
          }
        }
        // 演化里程碑：客户端借此弹"你演化出了新能力"的醒目提示
        events.push({ type: 'evolution', playerId: p.id, era: p.era, eraName: p.eraName, mutation });
      }
    }
  }
  _regionId(x, y) {
    const rx = Math.max(0, Math.min(World.REGION_W - 1, Math.floor(x / World.REGION_SIZE)));
    const ry = Math.max(0, Math.min(World.REGION_W - 1, Math.floor(y / World.REGION_SIZE)));
    return ry * World.REGION_W + rx;
  }
  _checkVictoryConditions(events) {
    const ps = Object.values(this.players).filter(p => !p.lost);
    if (ps.length === 0) return;
    // 房主可配置的开关与门槛（缺失时回退默认；默认门槛 = 原硬编码常量，保证数值不传时不变）。
    const V = this.victoryLines || World.VICTORY_LINE_DEFAULT;
    const T = this.victoryThresholds || World.normVictoryThresholds(null);
    // Singularity: each player has 6 resources at >= threshold (raised from 20 -> mid-game goal)
    if (V.singularity) {
      const SINGULARITY_THRESHOLD = T.singularityThreshold;
      for (const p of ps) {
        if (p.won) continue;
        const stock = p._stock || { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 };
        if (stock.wood >= SINGULARITY_THRESHOLD && stock.stone >= SINGULARITY_THRESHOLD && stock.ore >= SINGULARITY_THRESHOLD && stock.crystal >= SINGULARITY_THRESHOLD && stock.food >= SINGULARITY_THRESHOLD && stock.shard >= SINGULARITY_THRESHOLD) {
          p.won = true; p.winReason = 'singularity';
          events.push({ type: 'victory', playerId: p.id, reason: 'singularity' });
        }
      }
    }
    // Territory: reach empire era AND own >= T.territoryRegions regions.
    // Requiring the era means you must GROW before you can win — this is what
    // stretches a match to minutes instead of seconds.
    if (V.territory) {
      for (const p of ps) {
        if (p.won) continue;
        if ((p.era || 0) >= 3 && (p.regionsOwned || 0) >= T.territoryRegions) {
          p.won = true; p.winReason = 'territory';
          events.push({ type: 'victory', playerId: p.id, reason: 'territory' });
        }
      }
    }
    // Economy: leading by >= T.economyLead for >= T.economyHoldTicks ticks AND controlling
    // >= 10 regions AND reached the ecosystem era (era≥3). All victory lines converge
    // on the final era so a 30+ min match cannot be ended by an early snowball.
    if (V.economy) {
      if (ps.length > 1) {
        ps.sort((a, b) => b.score - a.score);
        const lead = ps[0].score - ps[1].score;
        if (lead >= T.economyLead && (ps[0].regionsOwned || 0) >= 10 && (ps[0].era || 0) >= 3) ps[0].scoreLeadTicks = (ps[0].scoreLeadTicks || 0) + 1;
        else ps[0].scoreLeadTicks = 0;
        if (ps[0].scoreLeadTicks >= T.economyHoldTicks && !ps[0].won) {
          ps[0].won = true; ps[0].winReason = 'economy';
          events.push({ type: 'victory', playerId: ps[0].id, reason: 'economy' });
        }
      }
    } else {
      // A5（PRD Q2/E3）：经济线关闭时清零累计计数器，避免"关掉攒条、打开即胜"。
      for (const p of ps) if (p.scoreLeadTicks) p.scoreLeadTicks = 0;
    }
    // Survival: if everyone else is eliminated (deaths → lost), the last faction
    // standing wins. (Only fires when there WAS a rival — solo sandboxes
    // with no opponents don't auto-declare.)
    if (V.survival) {
      if (ps.length === 1 && Object.keys(this.players).length > 1) {
        const sole = ps[0];
        if (!sole.won && !sole.lost) {
          sole.won = true; sole.winReason = 'survival';
          events.push({ type: 'victory', playerId: sole.id, reason: 'survival' });
        }
      }
    }
  }
  // 稀疏的"棋子伤害"列表：只含 dmg>0 的生命格 [x,y,dmg]。两种模式都可调用（无伤害则空数组）。
  _lifeHits() {
    this._lifeInit();
    const out = [];
    const dmg = this._lifeDmg;
    if (!dmg) return out;
    for (let x = 0; x < this.lifeW; x++) {
      const col = dmg[x];
      for (let y = 0; y < this.lifeW; y++) {
        const d = col[y];
        if (d > 0) out.push([x, y, d]);
      }
    }
    return out;
  }
  snapshot(includeEntities = false) {
    this._lifeInit();
    const players = Object.values(this.players);
    const tideRemaining = Math.max(0, this.tide.nextPhaseAt - this.tick);
    // ⚠️ 顺序关键：go 快照会把「就近归属」网格写回 _lifeOwner（让底色与数子同口径），
    //    而 lifeOwner 在下面**较早**就被序列化 —— 因此必须在构造返回对象前先算一次 go 状态，
    //    否则序列化到的是旧的 Voronoi 底色（地图颜色会与结算对不上）。
    const m = getMode(this.mode);
    const modeState = m.snapshot ? m.snapshot(this) : null;
    return {
      worldId: this.worldId,
      tick: this.tick,
      mode: this.mode,
      // 房主可调玩法参数（rts 与 go 共用；顶层，与 mode 平级）。
      settings: {
        stonesPerTurn: this.stonesPerTurn,
        lonelyDeathDelay: this.lonelyDeathDelay,
        aiDifficulty: this.aiDifficulty,
        // 胜利条件（房主可配置）：开关 + rts 门槛 + 该模式可用开关集。
        victoryLines: this.victoryLines,
        victoryThresholds: this.victoryThresholds,
        goLimits: this.goLimits,
        availableLines: World.availableLines(this.mode),
        // 棋盘形状（房主可配置）：每帧下发小对象 {w,h,shape} 或 null（默认矩形）。绝不下发 100×100 数组。
        board: this.board,
      },
      // 棋子伤害（稀疏）：只含 dmg>0 的格子 [x,y,dmg]，供客户端显示"挨打的棋子"。两种模式都要有。
      lifeHits: this._lifeHits(),
      tide: { phase: this.tide.phase, ticksToNext: tideRemaining, surgeCount: this.tide.surgeCount },
      oxic: !!this.oxic,
      terrainSum: this.terrainSample(),
      resourcesCount: this.resourcesFlat().filter(Boolean).length,
      playerCount: players.length,
      // ---- 房间/席位（两种模式共用）----
      hostId: this.hostId != null ? this.hostId : null,
      paused: !!this.paused,
      started: !!this.started,
      maxPlayers: this.seatCap(),
      maxTotal: this.maxTotal,
      seatCount: players.length,
      seatCap: this.seatCap(),
      humanCount: players.filter(p => !p.isAI).length,
      aiCount: players.filter(p => p.isAI).length,
      emergentCount: this.entities.length,
      emergentTotal: this.entities.length,
      tech: { ...this.tech },
      // Life board: 32x32 grid of faction ids (0 = empty). This is what the player sees.
      lifeGrid: this._life.map(col => Array.from(col)),
      lifeW: this.lifeW,
      // factionId-1 => playerId, so the client can map grid values to colors
      lifeOwners: this._lifeOwners.slice(),
      // 势力归属：rts = Voronoi 影响力；go = 「就近归属」（由 _goSnapshotState 写回，与数子同口径）。
      lifeOwner: this._lifeOwner ? this._lifeOwner.map(c => Array.from(c)) : null,
      // 8x8 region ownership by faction id (0 = unowned)
      regionFaction: this._regionFaction.slice(),
      regionW: World.REGION_W,
      players: players.map(p => ({
        id: p.id, name: p.name, color: p.color, isAI: !!p.isAI,
        botControlled: !!p.botControlled,   // 掉线由电脑代管中（UI 显示"电脑代打"）
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), vx: +p.vx.toFixed(3), vy: +p.vy.toFixed(3),
        hp: p.hp, hpMax: p.hpMax, alive: p.alive, deaths: p.deaths, respawnTicks: p.respawnTicks,
        invulnTicks: p.invulnTicks || 0,
        score: p.score, kills: p.kills, deaths: p.deaths, assists: p.assists || 0, combo: p.combo, maxCombo: p.maxCombo,
        dashCharge: p.dashCharge, dashCooldown: p.dashCooldown,
        hitFlash: p.hitFlash,
        regionsOwned: p.regionsOwned || 0,
        lifeCells: p.lifeCells || 0,
        maxLifeCells: p.maxLifeCells || 0,
        era: p.era || 0, eraName: p.eraName || 'tribe',
        seeds: p.seeds === undefined ? World.SEED_MAX : p.seeds,
        strongholds: p.strongholds || 0,
        network: !!p.network,
        aliveTicks: p.aliveTicks || 0,
        scoreLeadTicks: p.scoreLeadTicks || 0,
        stock: p._stock || { wood: 0, stone: 0, ore: 0, crystal: 0, food: 0, shard: 0 },
        won: !!p.won, lost: !!p.lost, winReason: p.winReason || null, lostReason: p.lostReason || null,
      })),
      entities: includeEntities ? this.entities.map(e => ({ id: e.id, type: e.type, name: e.name, x: +e.x.toFixed(2), y: +e.y.toFixed(2), vx: +e.vx.toFixed(3), vy: +e.vy.toFixed(3), hp: e.hp, hpMax: e.hpMax, color: e.color, mass: e.mass, speed: e.speed, faction: e.faction || 'neutral', behavior: e.behavior || '', effect: e.effect || '', shape: e.shape || '' })) : null,
      lastTickedAt: this.lastTickedAt,
      // go 模式专属字段（rts 下为 null，零开销）。复用同一批 lifeGrid / lifeOwner /
      // lifeOwners / regionFaction 字段，客户端零改动即可显示棋子与势力底色。
      go: modeState,
      // ---- 世界可见性：地形与资源点 ----
      // 之前只发 terrainSum/resourcesCount 两个数字，客户端根本画不出世界
      // （玩家看不见资源 → 不知道要干什么）。地形静态：低频重发；资源稀疏 + 每秒重算。
      terrainStr: (this.tick <= 1 || this.tick % 20 === 1) ? this._terrainString() : null,
      resPoints: this._resourcePoints(),
      // 棋盘形状位图串（编译位图 = shape）——**低频**下发（tick<=1 或 board 变更时），
      // 其余帧 null（参照 terrainStr 范式）。rts 生命层恒 32×32 → 快照零增长。
      boardMap: (this.board && (this.tick <= 1 || this._boardMapSentRev !== this._boardRev))
        ? (this._boardMapSentRev = this._boardRev, this.board.shape) : null,
    };
  }
  // 地形打包成字符串（每字符一格，0-5）—— 一次约 9KB，低频下发
  _terrainString() {
    if (this._terrainCache == null) {
      let s = '';
      for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) s += this.terrain[x][y];
      this._terrainCache = s;
    }
    return this._terrainCache;
  }
  // 稀疏资源点 [x, y, type]，每秒（20 tick）重算一次，其余 tick 复用缓存
  _resourcePoints() {
    if (this._resCache == null || this.tick - (this._resTick || -99) >= 20) {
      const pts = [];
      for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) {
        const v = this.resources[x][y];
        if (v) pts.push([x, y, v]);
      }
      this._resCache = pts;
      this._resTick = this.tick;
    }
    return this._resCache;
  }
  terrainSample() {
    let s = 0; for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) s = (s + this.terrain[x][y]) | 0;
    return s;
  }
  resourcesFlat() {
    const out = []; for (let x = 0; x < WORLD_W; x++) for (let y = 0; y < WORLD_H; y++) out.push(this.resources[x][y]);
    return out;
  }
}

// 简单 value noise（确定性，无状态）
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  function h(a, b) {
    let s = (a * 374761393 + b * 668265263 + seed * 982451653) | 0;
    s = (s ^ (s >>> 13)) * 1274126177; s = s ^ (s >>> 16);
    return ((s >>> 0) % 100000) / 100000;
  }
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export { loadKernels, kernelRegistry };

// 把各模式插件的方法族挂到 World.prototype（mixin）。每个插件的 install 钩子负责自己的挂载，
// 主干不感知具体模式 —— 新增模式只需在 server/modes/ 放一个插件文件，无需改动此处。
for (const def of allModeDefs()) {
  try { if (def.install) def.install(World); } catch (e) { console.error('[modes] install failed:', def.id, e); }
}
// go 模式 AI 决策入口（避免 engine ↔ go 循环依赖，挂在 World 上）。
registerGoAI(World);