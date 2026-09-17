# 回合制模式（Go Mode）· 增量架构设计与任务分解

> 上游输入：`docs/go-mode-prd.md`（许清楚 · 增量 PRD）
> 本文档由主理人依据对 `server/` 与 `public/` 的实际代码核对结果编写（架构师角色因平台 429 配额限制中断，改由主理人接手完成设计与分解，未跳过任何设计环节）。
> 目标目录：`D:\workspace\Game`

---

## 0. 核对结论（PRD 点名的接入点，逐条实测）

| PRD 说法 | 实测结果 | 处置 |
|---|---|---|
| 客户端零改动即可显示棋子 | ✅ `public/client.js:836` 起直接读 `state.world.lifeGrid` + `lifeOwners` + `lifeOwner` 渲染 | 渲染函数复用，只加"go 分支"控制可见元素 |
| 复用 Voronoi 做领地 | ✅ `_updateVoronoi()` `server/engine.js:889`，内核 `voronoi` 已注册（`__meta.id==='voronoi'`），调用式 `fn(null, this._rng, {sites,w,h}).cells` | 抽成可传入半径参数 |
| 复用 `_captureEnclosed` 的连通收集 | ⚠️ **不能直接复用**：现有实现用 **8 邻域**数气且把"己方细胞"也计为气（`server/engine.js:750-756`），是"围死"而非围棋"气"。围棋必须是 **4 邻域 + 空点气** | Go 模式**新写** `_goLiberties` / `_goTryCapture`，不动 rts |
| go 世界要排除 20 TPS 后台 tick | ✅ 必须。两条驱动路径都要挡：`server/index.js:100-104` 后台循环、`server/net.js:277-303` 的 `tickList` | 两处都加 `mode==='go'` 跳过，另起 1s 计时循环 |
| 固定 2 座位，绕开 TARGET_SLOTS=4 | ✅ `server/engine.js:122` `TARGET_SLOTS = 4`，`_seedOnboarding` 在 `server/engine.js:149` | `_maybeAddAI` 加 go 分支（TARGET=2）；go 跳过 `_seedOnboarding` |
| 影响半径"呼吸" | ⚠️ 现有 `_influenceR` `server/engine.js:877-883` 是**纪元驱动**的，go 模式没有纪元 | go 模式改用呼吸值，经可选参数注入 `_updateVoronoi` |
| 内核 `markov_chain` 可用 | ✅ `markov_chain(ctx, rng, params)`，params `{state, mat, states, steps}` → `{state, log}` | 呼吸 + 世界事件用它驱动 |
| `seed + 手顺` 可 100% 复盘 | ✅ `worlds` 表已有 `seed INTEGER NOT NULL`（`server/db/schema.sql:10-18`），**不需要新字段** | 不加 mode 列，避免 DB 迁移 |
| `conway_life` 内核用于 go 演化 | ❌ 实测 `server/signals.js` 用的是 `rule_30` / `reaction_diffusion` / `sand_pile`，**`conway_life` 内核在主流程里从未被调用**，且它硬编码 B3/S23、无阵营、是环形边界（`(x+dx+W)%W`），且元数据硬限 `w:96` 而我们有 32×32 | go 演化**不调该内核**，用自写阵营感知演化；棋盘尺寸 32×32 在硬限内，但环形边界与阵营语义都是错的 |

**结论**：`_captureEnclosed` 与 `_lifeStep` 都不适合直接复用做围棋语义 —— 围棋的"气"必须是 4 邻空点。新增 go 专用方法，rts 路径一行不动。

---

## 1. 设计决策（对 PRD §8 六条待确认问题的裁决）

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| Q1 | 棋盘 32×32 还是 24×24 | **32×32**，尺寸写成常量 `World.GO_BOARD_W = 32` 便于后续调 | 零渲染改动；150 手在 1024 格上确实稀疏，但**棋盘不是靠手数填满的**——每回合康威演化会从棋子处向外长出细胞，终局非中立格占比靠"演化覆盖率"达标而非"手数密度" |
| Q2 | AI 几档 | **P0 只做"普通"一档**：启发式打分（提子 > 连接 > 气数 > 靠近敌子 > 占中心），只评估**候选点集合**（邻接已有棋子的空点 + 若空盘则天元），≤0.8s | 候选点 = 棋盘上 1~3 环邻域，典型 <200 个，纯启发式绰绰有余；MCTS 放 P1 |
| Q3 | 悔棋范围 | **本迭代不做**。改为：AI 局允许"再来一局" | 悔棋要处理 ko 记录回滚与演化重放，复杂度与收益不成比例 |
| Q4 | 断线时是否暂停计时 | **暂停**：无任何 live WS 连接时冻结计时器（`_goTick` 不推进 `turnTicks`），恢复连接继续 | 回合制不是"延迟=惯性"的战场——铁律 2 的语境是**实时对冲**。回合制下暂停反而符合直觉（像国际象棋在线对局）。**实现必须放在 net 层判定连接数，不能塞进 engine**，engine 保持纯函数式确定性 |
| Q5 | 后手贴目 | **P0 无贴目**；人机局人类先手；AI 自对弈校准后再定 komi | 先能玩，再平衡 |
| Q6 | 分榜/观战 | **不做**。`scoresRepo` 不迁移（复用 `worldId` 即可区分） | 避免 DB 变更 |

**补充裁决**：
- **落子位置自由** → 任何空点均可落（不限于邻接），符合用户"落子位置可自由选定位置"。
- **没有强弱棋子** → go 模式的 `lifeGrid` **只写 `1` / `2`**，绝不写 `11/12`（弱痕段），避免客户端渲染出"深浅两色"。
- **一条命** → 吃光（`lifeCells === 0` 且历史峰值 ≥ 4）即出局，复用 `World.WIPE_ELIM_MIN_CELLS`。

---

## 2. 规则规格（可实现版本，R1~R8）

### R1 棋盘与棋子
- 32×32 生命棋盘，`_life[x][y] ∈ {0, 1, 2}`。**1 = 黑（先手）**，**2 = 白（后手）**。
- 先手：人机局人类 = 1；多人局由 `mulberry32(seed)` 掷出。
- go 模式下 `_lifeOwners = [blackPlayerId, whitePlayerId]`（`_factionOf` 自然产出 1/2，无需特判）。

### R2 一手 = 4 步原子结算（`_goTryMove(lx, ly, faction)`）
1. **合法性校验**（顺序固定，返回首个失败原因）：
   - 越界 → `oob`
   - 非空 → `occupied`
   - 该手为劫禁着点 → `ko`
   - **禁自杀**：落子后该点所在团无气`且`未提到任何子 → `suicide`
2. **落子**：`_life[lx][ly] = faction`。
3. **提子**：对落点 **4 邻**的每个敌方团，若 4 邻空点数 `=== 0` → 整团清除（`_goTryCapture`）。**提子优先于自杀判定**（先提后判，围棋）。
4. **判定自杀**：若落点所在团 4 邻空点数 `=== 0` → 回滚落子 → `suicide`。
5. **劫**：若本次恰好提走 **1 子**，且回滚后棋盘回到"上一手之后的局面"，则该点记为劫禁着（存 `_goKo = {lx, ly}`，下一手不能立即回提；隔一手后自动解除）。

### R3 康威演化（`_goEvolve()`，紧随落子）
- 使用内核 `cellular_automaton`，规则 `B3/S23`，`ctx=null, rng=this._rng`（**丢弃其返回值，只用它做规则可行性校验/未来扩展点**），实际演化自写以支持阵营：
  - **存活**：`n === 2 || n === 3`（`n` = 8 邻非空数，不分敌我 —— 保持康威纯粹性）
  - **诞生**：`n === 3` 且该点为空 → 阵营取 8 邻**多数派**（平票仅在自定义偶数阈值下可能出现，默认阈值不可达；见 FIX-6 说明）
  - **新落下的子豁免本回合死亡**（`this._goJustPlaced = {x,y}`）→ 杜绝"落下即死"的挫败
  - **禁自杀豁免**：落子本身若靠"提对方"活下来，按 R2 已处理；演化造成的死亡**不算自杀**（演化是自然现象，不是玩家决策）
- 演化结果只写 `0/1/2`，不产生弱痕段。

> **这就是"不可预测的数学"的第一层**：混沌边缘图案 + 呼吸 + 世界事件。玩家能感知"我明明连成一片，却从边上长出一颗对方的子"。
> **FIX-6 修订**：阵营诞生采用 8 邻**多数派**；平票分支在默认 `bornThresh=3` 下数学上不可达（`cnt[1]+cnt[2]=3` 为奇数 → 两方计数恒不等），故不作为对外承诺的随机源，仅作通用性保留（`bornThresh=2` 可测）。真正的不可预测源是三层：**呼吸（每 10 手 R∈{3,4,5}）+ 世界事件（每 25 手，繁盛演化步数 2~3 随机）+ 演化混沌**。

### R4 领地与计分
- 复用 Voronoi（内核 `voronoi`），但**半径改为呼吸值** `this._goBreathR`（见 R6），通过新增可选参数传入：
  - 改 `_updateVoronoi(rOverride)`：`rOverride` 为 null 时保持现有纪元逻辑（**rts 行为逐字节不变**）；为数字时，所有阵营统一用该值。
- **目数 = `_lifeOwner` 中归属自己的格子数**（含棋子和演化出来的细胞所覆盖的影响区）。提子不单独计分 —— 少一条规则。
- 宏观区归属沿用 `_updateRegionControl()` 的"过半才算"逻辑。

### R5 终局与胜负（任一触发）
1. 双方连续 **2 次 pass** → 终局
2. 手数达 **150** → 终局
3. 一方**棋盘被吃光**（`lifeCells===0` 且 `maxLifeCells >= WIPE_ELIM_MIN_CELLS`）→ 该方立即出局，对方胜
4. 某方**累计 3 次超时** → 该方判负
5. 认输（`{go:{resign:true}}`）
- 终局结算：比较 `goTerritory` 目数，多者胜；相同 → 平局。
- 结算数据写入 `world.goResult = { winner, reason, blackTerritory, whiteTerritory, moves }`。

### R6 "不可预测的数学"的四个机制（全部种子化，禁 `Math.random`/`Date.now`）

| # | 机制 | 实现 | 玩家感知 |
|---|---|---|---|
| 1 | **影响半径呼吸** | `markov_chain` 驱动状态在 `{0,1,2}` 间转移 → 半径 `{3,4,5}`；每 **10 手**转移一次 | 领地边界整体"涨潮/退潮"，同一片空地不同回合归属会变 |
| 2 | **世界事件（每 25 手）** | `markov_chain` 抽 1，共 4 态：`0` 正常 / `1` 繁盛（本回合演化跑 **2 步**）/ `2` 寒潮（本回合**不演化**）/ `3` 拥挤突变（本回合诞生阈值改 **5**） | 节奏可预期、内容不可预期；只在结算时广播 `event: {type:'go_world_event'}` |
| 3 | **图案奖** | 识别"会行走的图案"（选中区域内 5 格周期平移）`+5 目`、"振荡图案"（3 格周期翻转）`+2 目`；**同一图案只奖一次** | 把混沌变成**可追逐的正反馈**——玩家会主动去"培育"图案；HUD 高亮获奖区域 |
| 4 | **康威演化本身** | R3 | 边界长出珊瑚/迷宫状结构，双方都不完全可控 |

> **铁律自检**：图案是**现象**不是单位 —— 不命名、不生成实体、不进 `EMERGENTS`。事件与呼吸全部走 `this._rng`。`seed + 手顺` 可完整复盘（重放的是玩家决策，不是算法输出，不违反 IR-3c）。

### R7 时长
- `GO_TURN_MS = 30000`（上限，非均值），`GO_MAX_MOVES = 150`。
- 目标均值 5~8 秒/手 → 150 × 6s ≈ 15 分钟。
- **超时 = 自动 pass**（不做随机落子），并在 `world.players[id].goTimeouts++`。
- AI 出手 ≤ 0.8s。

### R8 断线
- net 层维护每个 go 世界的 live WS 数；`live === 0` 时**不推进 `turnTicks`**（暂停）。恢复后继续。engine 内**不感知连接**。

---

## 3. 文件清单与改动点（精确到行）

| 文件 | 操作 | 内容 |
|---|---|---|
| `server/engine.js` | 改 | ① `constructor` 增 `this.mode`；② `tickOnce()` 开头 `if (this.mode === 'go') return this._goTick();`；③ `_maybeAddAI` 加 go 分支；④ `_updateVoronoi(rOverride)` 加参数；⑤ **新增 §4 的 go 方法族**；⑥ `snapshot()` 条件加入 go 字段；⑦ `addPlayer` go 分支跳过 `_seedOnboarding` |
| `server/go.js` | **新增** | go 模式专属逻辑隔离（提子/演化/呼吸/事件/图案/终局），被 engine 引用，保持 engine 不膨胀 |
| `server/ai.js` | 改 | 新增 `goAIMove(world, faction)`：候选点启发式打分。**不动 `stepAI`** |
| `server/routes.js` | 改 | `POST /api/worlds` 接受 `mode`；go 模式跳过房间容量限制（固定 2 座位） |
| `server/net.js` | 改 | ① `hello` 时按 `w.mode` 决定不加入 `tickList` 的常规 tick，改由 1s 计时循环推进；② intent 通道支持 `{go:{...}}`；③ live 计数用于暂停 |
| `server/index.js` | 改 | 后台循环跳过 `mode==='go'`；新增 1s 计时循环驱动 go 世界 |
| `public/client.js` | 改 | go 渲染分支 / 落子点击 / 倒计时 / 隐藏 rts 元素 / 终局结算面板 |
| `public/index.html` | 改 | 建世界加"模式"下拉；新增 go 专用 HUD 容器 |
| `tests/go_mode.test.mjs` | **新增** | 见 §6 |

---

## 4. 新增方法与数据结构（工程师照此实现）

### 4.1 World 构造器新增
```js
// server/engine.js constructor
this.mode = 'rts';            // 'rts' | 'go'，由 routes/net 在创建后覆写
this.go = null;               // go 模式状态容器（惰性初始化 _goInit）
```

### 4.2 常量（挂在 World 上）
```js
World.GO_BOARD_W = 32;         // 复用 LIFE_W（断言相等）
World.GO_TURN_MS = 30000;      // 每手上限
World.GO_MAX_MOVES = 150;      // 手数上限
World.GO_PASS_END = 2;         // 连续 pass 终局
World.GO_MAX_TIMEOUTS = 3;     // 累计超时判负
World.GO_BREATH = [3, 4, 5];   // 影响半径呼吸取值
```

### 4.3 go 状态容器（`_goInit()`）
```js
_goInit() {
  if (this.go) return this.go;
  this._lifeInit();
  const f1 = this._factionOf(this.goBlackId);
  const f2 = this._factionOf(this.goWhiteId);
  this.go = {
    blackId: this.goBlackId, whiteId: this.goWhiteId,
    blackF: f1, whiteF: f2,
    turn: f1,                 // 当前行动方 faction（先手）
    moveNo: 1,
    turnTicks: 0,             // 已用 tick（1 s = 1）
    passes: 0,                // 连续 pass
    ko: null,                 // {lx, ly} 劫禁着
    prevPos: null,            // 上一手之后的棋盘快照（用于劫判定）
    breathState: 0,
    _breathR: World.GO_BREATH[0],
    eventState: 0,
    _evt: null,               // 本回合世界事件
    lastEvent: null,
    lastPlaced: null,         // {x,y} 本回合刚落下（豁免演化死亡）
    scoredPatterns: [],       // 已发奖图案签名（去重）
    result: null,             // 终局结算
    moveLog: [],              // [{n, f, lx, ly, captured}] 供复盘
  };
  return this.go;
}
```

### 4.4 4-邻气与提子（围棋语义，**不复用 `_captureEnclosed`**）
```js
// 返回 [x,y] 团的 4-邻空点数
_goLiberties(x, y) {
  const L = this._life, W = World.LIFE_W;
  const f = L[x][y];
  if (!f) return 0;
  const seen = new Set(), stack = [[x, y]], dir4 = [[1,0],[-1,0],[0,1],[0,-1]];
  let libs = 0;
  seen.add(x * W + y);
  while (stack.length) {
    const [cx, cy] = stack.pop();
    for (const [dx, dy] of dir4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const v = L[nx][ny], key = nx * W + ny;
      if (v === 0) { if (!seen.has(key)) { seen.add(key); libs++; } }
      else if (v === f && !seen.has(key)) { seen.add(key); stack.push([nx, ny]); }
    }
  }
  return libs;
}
// 提掉 (x,y) 所在团，返回被提格数（0 = 没提到）
_goTryCapture(x, y) {
  const L = this._life, W = World.LIFE_W;
  const f = L[x][y];
  if (!f || this._goLiberties(x, y) !== 0) return 0;
  const seen = new Set(), stack = [[x, y]], comp = [];
  const dir4 = [[1,0],[-1,0],[0,1],[0,-1]];
  seen.add(x * W + y);
  while (stack.length) {
    const [cx, cy] = stack.pop();
    comp.push([cx, cy]);
    for (const [dx, dy] of dir4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const key = nx * W + ny;
      if (!seen.has(key) && L[nx][ny] === f) { seen.add(key); stack.push([nx, ny]); }
    }
  }
  for (const [cx, cy] of comp) L[cx][cy] = 0;
  return comp.length;
}
```

### 4.5 一手棋（`_goPlay`）
```js
_goPlay(f, lx, ly, events) {
  const g = this._goInit();
  const L = this._life, W = World.LIFE_W;
  if (lx < 0 || ly < 0 || lx >= W || ly >= W) return { ok: false, reason: 'oob' };
  if (L[lx][ly] !== 0) return { ok: false, reason: 'occupied' };
  if (g.ko && g.ko.lx === lx && g.ko.ly === ly) return { ok: false, reason: 'ko' };
  const before = this._goSnapshot();       // 劫判定用（Uint8Array 拍平）
  L[lx][ly] = f;
  // 提子（4 邻敌方团）
  const dir4 = [[1,0],[-1,0],[0,1],[0,-1]];
  let captured = 0;
  for (const [dx, dy] of dir4) {
    const nx = lx + dx, ny = ly + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
    const v = L[nx][ny];
    if (v && v !== f) captured += this._goTryCapture(nx, ny);
  }
  // 禁自杀（提子之后才判）
  if (captured === 0 && this._goLiberties(lx, ly) === 0) {
    L[lx][ly] = 0;
    return { ok: false, reason: 'suicide' };
  }
  // 劫：恰好提 1 子且局面回到 bi-before 的镜像
  g.ko = null;
  if (captured === 1 && g.prevPos && this._goSameAs(before, g.prevPos)) g.ko = { lx, ly };
  g.prevPos = before;
  g.lastPlaced = { x: lx, y: ly };
  g.moveLog.push({ n: g.moveNo, f, lx, ly, captured });
  events.push({ type: 'go_move', playerId: this._lifeOwners[f - 1], lx, ly, captured, moveNo: g.moveNo });
  return { ok: true, captured };
}
_goSnapshot() { return this._life.map(c => Uint8Array.from(c)); }
_goSameAs(a, b) {
  const W = World.LIFE_W;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) if (a[x][y] !== b[x][y]) return false;
  return true;
}
```
> 注：劫的严格实现需要"提子前局面"，此处用 `prevPos`（上一手之前）做简化镜像比较，**PRD 已要求"不要太复杂"**。工程师需用 GO-04 的劫用例校验：直接回提必须被拒，隔一手后可回提。

### 4.6 康威演化（`_goEvolve`）
```js
_goEvolve(mode = 0, events) {
  const L = this._life, W = World.LIFE_W;
  const next = Array.from({ length: W }, () => new Int8Array(W));
  const bornThresh = mode === 3 ? 5 : 3;     // 拥挤突变
  const steps = mode === 1 ? 2 : (mode === 2 ? 0 : 1);  // 繁盛 / 寒潮
  for (let s = 0; s < steps; s++) {
    this._goEvolveOnce(next, bornThresh);
  }
  if (mode === 2) return;                    // 寒潮：不演化
  if (events) events.push({ type: 'go_evolve', mode, steps });
}
_goEvolveOnce(next, bornThresh) {
  const L = this._life, W = World.LIFE_W;
  const g = this.go, jp = g && g.lastPlaced;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
    let n = 0; const cnt = [0, 0, 0];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      // 实验性边界：越界视为死区（非环形），让边缘成为天然边界
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const v = L[nx][ny];
      if (v) { n++; cnt[v]++; }
    }
    const cur = L[x][y];
    if (cur) {
      // 本回合刚落的子豁免死亡
      if (jp && jp.x === x && jp.y === y) { next[x][y] = cur; continue; }
      next[x][y] = (n === 2 || n === 3) ? cur : 0;
    } else {
      if (n === bornThresh) {
        // 多数派；平票掷种子
        let f = 0;
        if (cnt[1] > cnt[2]) f = 1;
        else if (cnt[2] > cnt[1]) f = 2;
        else if (cnt[1] > 0 && cnt[1] === cnt[2]) f = this._rng() < 0.5 ? 1 : 2;
        next[x][y] = f;
      } else next[x][y] = 0;
    }
  }
  for (let x = 0; x < W; x++) this._life[x] = next[x];
}
```

### 4.7 呼吸 + 世界事件（内核驱动）
```js
_goBreathe() {
  const g = this.go;
  const fn = World.kernelRegistry && World.kernelRegistry.get('markov_chain');
  if (fn) {
    const r = fn(null, this._rng, {
      state: g.breathState, states: 3,
      mat: [[0.6,0.3,0.1],[0.3,0.4,0.3],[0.1,0.3,0.6]],
      steps: 1,
    });
    g.breathState = r.state;
  } else g.breathState = (g.breathState + 1) % 3;
  g._breathR = World.GO_BREATH[g.breathState];
}
_goWorldEvent() {
  const g = this.go;
  const fn = World.kernelRegistry && World.kernelRegistry.get('markov_chain');
  let st = 0;
  if (fn) {
    const r = fn(null, this._rng, {
      state: g.eventState, states: 4,
      mat: [[0.5,0.2,0.2,0.1],[0.3,0.3,0.2,0.2],[0.3,0.2,0.3,0.2],[0.2,0.2,0.2,0.4]],
      steps: 1,
    });
    st = r.state;
  } else st = (g.eventState + 1) % 4;
  g.eventState = st;
  g._evt = st;
  g.lastEvent = ['calm', 'flourish', 'frost', 'mutate'][st];
  return g._evt;
}
```
- `_goBreathe()` 每 **10 手**调用一次（`moveNo % 10 === 1`）。
- `_goWorldEvent()` 每 **25 手**调用一次（`moveNo % 25 === 1`）。

### 4.8 领地与计分
```js
_goScore() {
  const g = this._goInit();
  const W = World.LIFE_W;
  this._updateVoronoi(g._breathR);      // 呼吸半径；rts 传 undefined 走原逻辑
  const own = this._lifeOwner;
  let b = 0, w = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
    if (own[x][y] === g.blackF) b++; else if (own[x][y] === g.whiteF) w++;
  }
  // 图案奖
  const bonus = this._goPatternBonus();
  return { black: b + bonus.black, white: w + bonus.white, bonus };
}
```
- `_updateVoronoi` 改动（唯一改动点，`server/engine.js:889`）：
  ```js
  _updateVoronoi(rOverride) {
    ...
    const r2ByF = Object.create(null);
    for (const p of Object.values(this.players)) {
      const r = (rOverride != null) ? rOverride : this._influenceR(p);
      p.influenceR = r;
      r2ByF[this._factionOf(p.id)] = r * r;
    }
    ...
  }
  ```
  > `rOverride == null`（rts 调用不传参）→ 行为与现在**完全一致**。

### 4.9 图案奖（`_goPatternBonus`）
- 遍历所有棋子团（4-连通），对每团取其**包围盒**：
  - 若包围盒内该阵营的格子集合能"整体平移 1 格后仍全部为活细胞" → 记为**会行走的图案**（`+5`）；签名 = 包围盒内相对坐标拼串，**同一签名只奖一次**。
  - 若连续 3 手该团签名按 A→B→A 交替 → **振荡图案**（`+2`），同样去重。
- 实现上限：只检查团大小 ≤ 12 的团（避免全盘扫描开销），超限跳过。

### 4.10 go tick（`_goTick`，由 net / index 的 1s 循环调用）
```js
_goTick() {
  const g = this._goInit();
  if (g.result) return { events: [], tickMs: 0 };
  const events = [];
  this.tick++;
  g.turnTicks++;
  // 超时 = 自动 pass
  if (g.turnTicks * 1000 >= World.GO_TURN_MS) {
    const pid = this._lifeOwners[g.turn - 1];
    const p = this.players[pid];
    if (p) p.goTimeouts = (p.goTimeouts || 0) + 1;
    events.push({ type: 'go_timeout', playerId: pid, moveNo: g.moveNo });
    this._goEndTurn(null, events);          // 视为 pass
  }
  this.events = events;
  return { events, tickMs: 0 };
}
_goEndTurn(played, events) {
  const g = this.go;
  let endReason = null;
  if (played === null) { g.passes++; } else { g.passes = 0; }
  if (g.passes >= World.GO_PASS_END) endReason = 'pass';
  else if (g.moveNo >= World.GO_MAX_MOVES) endReason = 'max_moves';
  // 吃光出局
  for (const pid of [g.blackId, g.whiteId]) {
    const p = this.players[pid];
    if (!p || p.lost) continue;
    if ((p.maxLifeCells || 0) >= World.WIPE_ELIM_MIN_CELLS && (p.lifeCells || 0) === 0) {
      p.lost = true; p.lostReason = 'wiped';
      events.push({ type: 'eliminated', playerId: pid, reason: 'wiped' });
      endReason = endReason || 'wiped';
    }
  }
  // 超时判负
  for (const pid of [g.blackId, g.whiteId]) {
    const p = this.players[pid];
    if (p && (p.goTimeouts || 0) >= World.GO_MAX_TIMEOUTS) endReason = endReason || 'timeout';
  }
  if (endReason) { this._goFinish(endReason, events); return; }
  // 换手 + 周期机制
  g.turn = g.turn === g.blackF ? g.whiteF : g.blackF;
  g.moveNo++;
  g.turnTicks = 0;
  if (g.moveNo % 10 === 1) this._goBreathe();
  if (g.moveNo % 25 === 1) this._goWorldEvent();
}
_goFinish(reason, events) {
  const g = this.go;
  const sc = this._goScore();
  const bLost = this.players[g.blackId] && this.players[g.blackId].lost;
  const wLost = this.players[g.whiteId] && this.players[g.whiteId].lost;
  let winner = null;
  if (bLost && !wLost) winner = g.whiteId;
  else if (wLost && !bLost) winner = g.blackId;
  else if (sc.black > sc.white) winner = g.blackId;
  else if (sc.white > sc.black) winner = g.whiteId;
  g.result = { winner, reason, blackTerritory: sc.black, whiteTerritory: sc.white, moves: g.moveNo - 1 };
  events.push({ type: 'go_end', ...g.result });
  if (winner) { const p = this.players[winner]; if (p) { p.won = true; p.winReason = 'go'; } }
}
```

### 4.11 intent 通道
在 `tickOnce` 的 go 分支之前拦截（**引擎不读 WS，由 net 把 intent 转成方法调用；但为便于测试，engine 也接受 queue 形式**）：
```js
// engine 内提供公开方法，net 调用
applyGoIntent(playerId, data, events) {
  const g = this._goInit();
  const f = this._factionOf(playerId);
  if (g.result) return { ok: false, reason: 'ended' };
  if (f !== g.turn) return { ok: false, reason: 'not_your_turn' };
  if (data.pass) { this._goEndTurn(null, events); return { ok: true, pass: true }; }
  if (data.resign) { const p = this.players[playerId]; if (p) p.lost = true;
    this._goFinish('resign', events); return { ok: true, resign: true }; }
  if (typeof data.lx !== 'number' || typeof data.ly !== 'number') return { ok: false, reason: 'bad_move' };
  const r = this._goPlay(f, data.lx | 0, data.ly | 0, events);
  if (!r.ok) return r;
  // 落子 → 演化 → 计分 → 换手
  this._goEvolve(g._evt || 0, events);
  if (g._evt) g._evt = 0;
  this._updateRegionControl();
  if ((this.players[this._lifeOwners[g.turn - 1]] || {}).lost) { /* wipe handled in _goEndTurn */ }
  this._goEndTurn(r, events);
  return { ok: true, captured: r.captured };
}
```

### 4.12 snapshot 扩展（`server/engine.js` snapshot 末尾）
```js
// go 模式专属字段（rts 下为 null，零开销）
go: this.mode === 'go' ? (() => {
  const g = this.go || this._goInit();
  const sc = g.result ? { black: g.result.blackTerritory, white: g.result.whiteTerritory } : this._goScore();
  return {
    turn: this._lifeOwners[g.turn - 1] || null,
    moveNo: g.moveNo,
    msLeft: Math.max(0, World.GO_TURN_MS - g.turnTicks * 1000),
    passes: g.passes,
    boardW: World.LIFE_W,
    maxMoves: World.GO_MAX_MOVES,
    breath: g._breathR,
    event: g.lastEvent || 'calm',
    ko: g.ko,
    territory: sc,
    bonusSeen: (g.scoredPatterns || []).length,
    result: g.result ? { ...g.result, winnerName: (this.players[g.result.winner] || {}).name || null } : null,
  };
})() : null,
```

### 4.13 `_maybeAddAI` go 分支
```js
_maybeAddAI() {
  if (this._skipAIFill) return;
  if (this.mode === 'go') {
    const TARGET = 2;
    const all = Object.values(this.players);
    if (all.length >= TARGET) return;
    const ai = makeAIPlayer(this, this._rng);
    if (ai) {
      ai.goFaction = this._factionOf(ai.id);
      this.goWhiteId = this.goWhiteId || ai.id;
    }
    return;
  }
  ... // 原逻辑不变
}
```

### 4.14 `addPlayer` go 分支
```js
// 在 this._seedOnboarding(px, py, playerId); 之前插入
if (this.mode === 'go') {
  this._lifeInit();
  const f = this._factionOf(playerId);
  if (!this.goBlackId) this.goBlackId = playerId, this.goWhiteId = this.goWhiteId;
  else this.goWhiteId = playerId;
  if (f === 1) this.goBlackId = playerId; else this.goWhiteId = playerId;
  this.players[playerId] = p;
  this._maybeAddAI();
  p.goTimeouts = 0;
  return p;   // 跳过 _seedOnboarding / 出生点资源
}
```

---

## 5. 共享知识（跨文件约定）

1. **go 模式的 `lifeGrid` 只允许 `0/1/2`**，绝不写 `11/12`。任何产生弱痕的调用（`_lifeTrail`）在 go 模式必须被绕过。
2. **`_updateVoronoi` 的唯一签名变化是新增可选参数 `rOverride`**，`null/undefined` 时 rts 行为逐字节不变。
3. **go 世界不参与 20 TPS tick**（`net.js` 与 `index.js` 两处都要挡），由 **1 秒**循环推进。
4. **计时暂停由 net 层判定 live 连接数**，engine 不感知连接。
5. **禁 `Math.random()` / `Date.now()` 于任何 go 逻辑**（`Date.now()` 仅允许出现在 `tickOnce` 的 `t0` 性能统计与既有非模拟代码）。
6. 客户端：go 模式隐藏 `#attack-btn`(已删)、`#stock-list`、`#emergent-list`、`#res-list`、`#win-list`、`#tide-info`、`#room-emergent`；显示新增 `#go-hud`。
7. 前端缓存击穿：`index.html` 的 `client.js?v=` 需再次自增（当前 `20260910c` → `20260911a`）。

---

## 6. 测试任务（`tests/go_mode.test.mjs`）

必须覆盖（PRD GO-04 / GO-05 / GO-07 直接对应）：

| ID | 用例 | 断言 |
|---|---|---|
| GM-01 | 提单子 | 落子使 1 颗敌子无气 → 被提，`captured === 1`，该点变 0 |
| GM-02 | 提整团 | 3 子团被围 → 一次提 3 |
| GM-03 | 禁自杀 | 落子在无气且未提子的点 → `{ok:false, reason:'suicide'}`，棋盘不变 |
| GM-04 | 有气可落 | 落子在紧邻敌子但自身有气的点 → `ok` |
| GM-05 | 劫禁着 | 构造劫 → 立即回提被拒 `reason:'ko'` |
| GM-06 | 劫后应一手可回提 | 双方各走一手后 → 回提成功 |
| GM-07 | 演化确定性 | 同 seed 同手顺双跑 `snapshot().lifeGrid` 逐手一致 |
| GM-08 | 演化平票 | 构造 1:1 邻域，多 seed 下两阵营都出现过新生子 |
| GM-09 | 刚落的子不死 | 落子后立即演化 → 该点仍为落子方 |
| GM-10 | 领地计分 | 落子后 `go.territory` 之和 > 0，且归属正确阵营 |
| GM-11 | 终局-连续 pass | 两次 pass → `go.result.reason === 'pass'` |
| GM-12 | 终局-手数上限 | 强制 `moveNo = 150` → `reason === 'max_moves'` |
| GM-13 | 终局-吃光 | 一方 `lifeCells=0` 且 `maxLifeCells>=4` → `reason==='wiped'`，该方 `lost` |
| GM-14 | 超时=pass | `turnTicks` 推到 30 → `go_timeout` 事件 + 手数推进 |
| GM-15 | 非行动方落子被拒 | `not_your_turn` |
| GM-16 | `mode` 回归 | `mode==='rts'` 的世界跑 200 tick，`lifeGrid` 编码仍含 `11+` 弱痕，行为不变 |
| GM-17 | 零 `Math.random` | 源码 grep go 相关文件无 `Math.random`（`tests/` 白名单外） |
| GM-18 | 呼吸/事件内核接入 | 强制 `moveNo` 到 10 / 25 → `go.breath` 变化 / `go.event !== 'calm'` 至少出现过一次 |

---

## 7. 实现顺序（任务列表）

| # | 任务 | 依赖 | 产出 |
|---|---|---|---|
| T1 | `server/go.js` 骨架 + `_goInit` + `_goLiberties` / `_goTryCapture` / `_goPlay` | — | 提子规则可单测 |
| T2 | `_goEvolve` / `_goEvolveOnce`（阵营感知 + 平票掷种子 + 刚落的子豁免） | T1 | 演化确定性可单测 |
| T3 | `_goBreathe` / `_goWorldEvent` / `_goPatternBonus` / `_goScore` | T2 | 四大不可预测机制 |
| T4 | `_goEndTurn` / `_goFinish` / `_goTick` / `applyGoIntent` | T2,T3 | 回合状态机与终局 |
| T5 | `constructor`/`tickOnce` 分支 + `_maybeAddAI` + `addPlayer` + `_updateVoronoi(rOverride)` + `snapshot.go` | T1~T4 | 引擎侧打通 |
| T6 | `routes.js` mode 参数 + 2 座位 | T5 | REST 可建 go 世界 |
| T7 | `net.js` tick 剔除 + 1s 循环 + `{go:{}}` intent + live 暂停；`index.js` 后台剔除 + 1s 循环 | T5 | 服务端可玩 |
| T8 | `ai.js` `goAIMove` 启发式 | T5 | AI 对手 |
| T9 | 客户端 go 渲染/点击/倒计时/终局面板 + `index.html` 下拉与 `?v=` 自增 | T7 | 可玩闭环 |
| T10 | `tests/go_mode.test.mjs` 18 条 + 全量回归 `npm test` | T1~T9 | 验证 |

---

## 8. 待明确事项（本迭代不做，记录备查）

1. **贴目（komi）**：待 AI 自对弈测先手胜率后引入。
2. **MCTS AI**：P1，视胜率与耗时决定。
3. **悔棋 / 分榜 / 观战**：P1/P2。
4. **棋盘尺寸可配置**：已抽成 `World.GO_BOARD_W`，但渲染与计分硬依赖 `LifeW===32` 的 6×6 宏格映射，改动需同步 `LIFE_CELL`（本迭代不动）。
5. **演化边界语义**：go 模式采用**非环形边界**（越界视为死区），与 `cellular_automaton` 内核的环形边界**有意不一致** —— 因为围棋棋盘有天然边界，环形会让"角"失去意义。

---

## 9. 变更记录（Changelog）

- **FIX-1~FIX-6（UI 缺陷修复，第二批前）**：首屏简报按模式分流（go 弹 `showGoBriefing`）；隐藏 rts 残留 UI（`#rts-help` + `room-*` 行容器 + rts 标题文字）；轮次高亮边框 + 非法落子 `go_reject` 事件与红叉留痕；领地底色 `0x33→0x55` + 势力边界描线；HUD 环形倒计时；平票死代码加不可达注释 + 繁盛演化步数 2~3 随机（走种子 RNG）。详见 `docs/go-mode-fix-spec.md`。
- **FIX-7（人类顶替 AI 席位，本轮）**：修复"邀请好友对弈"阻断缺陷。`engine.js` 的 `addPlayer` go 分支改为**人类优先占席**（第 2 个人类加入时踢掉占位的 AI 空出席位）；`_maybeAddAI` go 分支加**超编兜底**（人类数 ≥ 2 时清出全部 AI）。单人开局仍即时补 1 AI 可对弈。新增用例 **GM-21**。详见 `docs/go-mode-fix-spec-2.md`。
- **FIX-8（go 键盘操作，本轮）**：`client.js` keydown 的 go 分支补上简报承诺的键位 —— `P` 停一手（**二次确认**，2.5s 窗口，防误触丢一手）、`Ctrl/Cmd+R` 认输（`preventDefault` 阻止浏览器刷新 + `confirm` 确认）。rts 模式这两键行为**完全不变**。
- **FIX-C1（CRITICAL 崩溃，本轮）**：邀请好友后一落子服务崩溃（`_goPatternBonus` `sigs[f].push` 对 undefined push）。**三层根因全修**：① `engine.js` `evictAI` 回收 faction 槽位（`_lifeOwners[idx]=null`，长度不缩短）+ `_factionOf` 优先复用 null 槽（2 人局阵营恒为 1/2）；② `go.js` `_goPatternBonus` 按 `g.blackF`/`g.whiteF` 建 `sigs` 槽 + `(sigs[f]||(sigs[f]=[])).push` 兜底；③ 黑白归属判定从硬编码 `===1` 改为按 `blackF`/`whiteF`，非黑白阵营不计分。新增用例 **GM-22 / GM-23**。详见 `docs/go-mode-fix-spec-3.md`。
- **FIX-M2（幽灵玩家，本轮）**：go 房间人类已满 2 席后，第 3 个新 uid 被 `addPlayer` 直接拒绝（返回 `{rejected:'room_full'}`，不进 `players`、不占 faction 槽），`net.js` 的 HELLO/JOIN 识别该拒绝后发 `FORBIDDEN/room_full` 并关连接。消除 snapshot 玩家列表污染（2 席游戏不再显示 3 人）。

---

## 9. 变更记录

| 轮次 | 变更 | 说明 |
|---|---|---|
| FIX-1~6 | go 模式 UI 修复 | 首屏简报按模式分流、隐藏 rts 残留文案、拒绝原因回显、领地边界描线、环形倒计时、平票死代码改设计 |
| FIX-7/8/9 | 席位与键位 | （**已被 2026-09-10 返工取代**：原"人类顶替 AI 席位"模型作废） |
| FIX-C1/M2 | faction 槽位回收 + 幽灵玩家 | `_lifeOwners` 槽位置 null 复用、永不缩短；超编拒绝 |
| **返工（2026-09-10 用户第 2 轮修正）** | **房间/席位模型重建 + go 泛化 8 方** | 见下 |

### 返工要点（用户逐字要求）
> "两个模式都可以自定义最多玩家人数，并手动添加电脑玩家，并不影响其它玩家加入，可以先创立房间后建立世界，然后开始游戏，也不需要等待玩家到齐后才能开始，玩家可以中途加入，若中途离开则由电脑接手，对局任何玩家都可以存档，而房主可以暂停游戏……最多可以有 8 个玩家"
> "玩家数量上限由房主设置，电脑玩家也会占用席位"
> "私密房间 / 公开房间，可设置密码，按房间号搜索房间"

1. **房间先于世界**：`POST /rooms` 建房（`world_id=''`）→ `POST /rooms/:code/world` 建世界 → `POST /rooms/:code/start`。
2. **`maxPlayers` = 总席位上限（1..8，含电脑）**，房主设置；硬上限 `World.MAX_SLOTS = 8`。
3. **AI 手动添加**（`addAI()` / `POST /rooms/:code/ai`）；`_maybeAddAI()` 空实现，不再自动补位。
4. **离开 → 电脑接手**：`handOverToAI()` 设 `botControlled`，保留玩家对象；重连接回。
5. **房主暂停**：`paused` 在 4 处驱动循环全部挡掉。
6. **任意玩家存档**：`POST /rooms/:code/save`。
7. **公开/私密 + 密码 + 搜索/列表**：`server/rooms.js` 房间模型。
8. **go 泛化到 N 方**：`go.seats[]`、按阵营计分、全员 pass 终局。
9. **演化裁决（2026-09-10 已作废，见 `docs/gameplay-rework-delivery.md`）**：本条原为"棋子**不因孤独而死**，只死于过度拥挤（`n>3`）"，**已被用户推翻**。
   现行规则：**标准康威 B3/S23，孤子会死**（`n === 2 || n === 3` 才存活）；补偿机制为①每回合可落多颗（默认 3）②死亡宽限 `lonelyDeathDelay`（默认 0）。**不要再按本条旧规则实现。**

### 验证锚点
- `npm test` **215/215**（含 `tests/go_mode.test.mjs` 27、`tests/room_lobby.test.mjs` 5）
- `scripts/qa_lobby_e2e.mjs` **28/28**（真实起服务：先建房后建世界 / 电脑占席位 / 满员拒绝 / 非房主不可暂停 / 任意玩家存档 / WS 4 席快照 / 私密房密码与搜索）
- rts 回归：4 玩家（1 人 + 3 手动电脑）、tick 推进、弱痕存在、`snapshot().go === null`
