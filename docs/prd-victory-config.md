# 房主可配置胜利条件 · 增量 PRD

> 本文只描述**一个增量**：把《涌现之地》的胜利判定从「服务端硬编码 4 条线、无条件全开」改为「**房主勾选启用哪些胜利线 + 按模式差异化提供开关**」。
> 判定语义、常量、房间配置范式**全部复用现状**，不新造游戏概念、不引入新名词。
> 本文不改动任何游戏代码，仅作为架构/开发/QA 的输入。

## 0. 项目信息

| 项 | 值 |
| --- | --- |
| Language | 中文 |
| Programming Language | **沿用项目现状**：Node.js + express + `ws` + 原生前端（`server/` + `public/client.js`）。本增量为已有仓库的功能扩展，不引入 Vite/React/MUI/Tailwind |
| Project Name | `victory_config`（内部代号；对外叫「胜利条件设置」） |
| 文档类型 | 增量 PRD（相对 `docs/PRD.md` / `docs/GDD.md` / `docs/go-mode-prd.md` 的 delta） |
| 实现方 | 按本文档 + 现有 `server/engine.js` / `server/rooms.js` / `server/go.js` 落地 |
| 关联铁律 | IR-3a 算法确定性（禁 `Math.random()` / `Date.now()`，一律 `mulberry32(this._rng)`）· IR-3b 离散 tick（rts 20 TPS / go 1s 循环）· 「延迟=惯性」 |

### 原始需求（逐字引用，不可篡改）

> "胜利条件有问题，怎么回合制很容易就赢了，怎么只有一方被吃光就赢了，胜利条件应该是可由房主设定的"

### 现状代码事实（本 PRD 的立论依据，已逐条核对）

| # | 事实 | 位置 |
| --- | --- | --- |
| F1 | 胜利判定集中在一个函数，**4 条线全部无条件生效、都写死常量** | `server/engine.js` `_checkVictoryConditions()` L1357–1403 |
| F2 | 4 条线：`singularity`（6 资源各 ≥30）· `territory`（era≥3 且 regionsOwned≥16）· `economy`（领先≥600 且占≥10 区且 era≥3，持续 1800 tick）· `survival`（只剩 1 人） | 同上 L1360–1402 |
| F3 | `survival`（"一方被吃光就赢"）= 用户抱怨的那条；且它是 rts/go **共用**的判定 | 同上 L1393–1402 |
| F4 | go 模式复用同一函数判定，但 go **没有经济/资源/纪元概念** → 只有 `survival` 实际会触发 → "很容易就赢" | `server/go.js` + F2；go 不进 20TPS tick |
| F5 | go 另有独立的终局机（pass / 150 手 / 被吃光 wiped / 认输 / 超时），`_goFinish` 比**目数**定胜负 | `server/go.js` `_goEndTurn` L681、`_goFinish` L730 |
| F5a | **"双方连续停手即终局"机制已存在**：`_goEndTurn` 中 `if (g.passStreak >= seats.length) endReason = 'pass'`；即**全员各 Pass 一次** → 终局。`passStreak`/`passes` 字段在 `_goInit` 已初始化（L65/L69）。座位变化时 `passStreak` 归零（`_goSyncSeats` L119），避免新玩家一进来就终局 | `server/go.js` L65/L69/L119/L685-688 |
| F5b | ⚠ **N 方局下"连续 Pass 终局"门槛 = 在座人数，不是围棋的"2 次"**：两方局恰好 = 双方各 pass 一次（与围棋一致）；3 方及以上局需全员各 pass 一次（游戏化改良，非围棋标准）。是否保留此改良见 §6 Q1 | 同上 L688 |
| F5c | go 现有"**吃光出局（wiped）**"：当 `maxLifeCells >= WIPE_ELIM_MIN_CELLS(=4)` 且 `lifeCells === 0` → 该玩家 `lost=true, lostReason='wiped'`，并成为 `endReason='wiped'` **直接终局**；若吃光后只剩 1 人未出局 → `endReason='last_standing'`。**即现状"清盘会被判终局/判胜"，这正是用户新决定要推翻的** | `server/go.js` L691-708 |
| F5d | `_goFinish` 的胜负依据 = `_goScore()`：**Voronoi 归属格数（含呼吸半径）+ 图案奖**，取唯一最高分者；分数并列 → 平局（`winner=null`）；胜者 `p.won=true, p.winReason='go'`。**注意：现状算法是"领地/Voronoi 目数"，不是围棋的"子数+空点数"**（见 §6 Q3） | `server/go.js` L730-758、`_goScore` L634-671 |
| F5e | **现状没有任何"贴子（komi）"机制**：`_goScore` 双方用同一套 Voronoi 计数，无黑/白偏移；席位黑先（`blackF=seatF[0]` L61）。若采用中国规则数子，**需新增贴子**（见 §6 Q1） | `server/go.js` L634-671（无 komi） |
| F5f | go 没有 `DEATH_LIMIT`/`survival` 语义：`_checkVictoryConditions` 的 `survival`（rts 侧"只剩 1 人"）在 go 下**由 L706-708 的 `last_standing` 独立覆盖**，不共用 rts 的 `lost` 死亡计数 | `server/engine.js` F3 + `server/go.js` L706-708 |
| F6 | 常量集中于 `World` 静态字段：`TERRITORY_WIN=16` `DEATH_LIMIT=12` `WIPE_ELIM_MIN_CELLS=4` `WIPE_ZERO_TICKS=240` | `server/engine.js` L690–751 |
| F7 | **房间配置范式已存在**：`stonesPerTurn` / `lonelyDeathDelay` 走完整链路 —— `norm*()` 钳制 → `createRoom()` → DB 列 → `hydrate()` → 路由 `ensureWorld`/`worldForRoom` 透传 → `World` 构造器 `opts` → `this.*` → `snapshot().settings` → `roomInfo()` | `server/rooms.js` L24–48/L70–101/L162–204；`server/routes.js` L110–135/L231–241/L313–341/L381–385；`server/db/schema.sql` L48–59；`server/db/index.js` L123–126/L323–344；`server/engine.js` L57–63/L1419–1428 |
| F8 | `_clampInt(v, dflt, lo, hi)` 通用钳制助手已存在 | `server/engine.js` L703–706 |
| F9 | `won` / `winReason` 已在快照里逐玩家下发 | `server/engine.js` L1479 |
| F10 | 玩家 `lost` 由 `DEATH_LIMIT=12` 次死亡触发（rts） | F6 + L161 |

> **核心结论**：这是一个**配置面扩展 + 判定函数加开关**的需求，不改判定数学、不改回合/物理，风险面小、可完全复用 F7 范式。

---

## 1. 产品目标

**一句话**：让**房主**在开房时和进房后，按本局玩法**勾选启用哪些胜利线**；未勾选的线永不触发；go 与 rts 各提供各自的合理开关集；默认**只开【领土】**，根治"一不小心就赢了"。

**为什么做**（3 个正交目标）：

1. **把胜负决定权交回房主**：现在 4 条线硬编码全开、门槛写死，房主无法决定"我们这局怎么算赢"。改为房主可选，让同一份地图支持"速战（只开灭族）""经营（只开经济）""抢地（只开领土）"等多种玩法。
2. **按模式给对的开关**：go 里"经济/采集"物理上永不触发（F4），却和 rts 共用判定；改为 go **只暴露【领土】一条**，语义明确、UI 不出现无效项（因"清盘即胜"已按用户新决定废弃，go 不再提供【出局】，见 §3 VC-04/VC-09）。
3. **消除"开局即胜"的意外**：默认只开【领土】（一个"要打满一局才够"的门槛型目标），未勾的线静默，从根上杜绝"刚开局一方被秒 → 另一方立刻 win"。

**成功标准（可量化）**：

| # | 标准 | 目标值 |
| --- | --- | --- |
| M1 | 房间胜利条件可被房主配置，未勾选线**零触发** | 单测覆盖：4 条线 × 开/关 共 8 组，关闭线 0 次触发 |
| M2 | 默认配置（两模式）= 仅【领土】 | `createRoom()` 不传参 → `victoryLines={territory:true, 其余:false}` |
| M3 | go 模式的开关集**只含**领土 | API 返回的 `availableLines` 在 go 下长度 = 1（即 `[territory]`，无 survival/economy/singularity） |
| M4 | 中途改配置**不破坏已结束判定、不误判进行中的局** | 见 §5 边界用例 |
| M5 | **现有 `npm test` 全绿不回归**（现状 262 条） | 262 → 262+N，0 失败 |

**做与不做（Out of Scope，明确划线）**：

- **不改** rts 任何一条线的判定数学（阈值比较、era 门槛、ticks 累计逻辑原样保留，只是外面套 `if (enabled)`）；
- **不新造**胜利线（不新增"击杀数胜利""存活时长胜利"等）；
- **go 的"棋局结束"机制保留**：pass / 150 手 / 超时 / 认输仍无条件生效（它们是"棋局结束"机制，不是"胜利线"）；**但 `_goFinish` 的"胜负依据"要改**（Voronoi 目数 → 中国规则数子），并**移除"清盘（wiped）即判胜"**——这两点是**用户明确要求的行为变更**（见 VC-09/VC-10）；
- **不改** rts 的 `lost` 触发（`DEATH_LIMIT` 仍是 12 次死亡出局）；
- **不做**旁观者/非房主改配置（仅房主可改）。

---

## 2. 用户故事

| # | 视角 | 用户故事 |
| --- | --- | --- |
| US-1 | 房主 · 建房时配置 | 作为**房主**，我希望在**建房弹窗的高级设置里**勾选本局启用哪些胜利线（并有合理默认），以便我开局前就定好"这局怎么算赢"，而不用进游戏后才发现规则不对。 |
| US-2 | 房主 · 中途改配置 | 作为**房主**，我希望进房后能**随时再打开设置面板修改**胜利线开关，以便我们发现"这局只想抢地"或"想加个经济线"时不必重开一局。 |
| US-3 | 普通玩家 · 看到当前条件 | 作为**普通玩家（非房主）**，我希望在房间里随时看到**"本局胜利条件：仅·领土"**这条只读信息，以便我知道目标是什么，而不是打到一半才猜"我为什么突然赢了/输了"。 |
| US-4 | 房主 · 按模式选择 | 作为**房主玩回合制**，我希望设置里**只出现【领土】一条**（不会出现我根本触发不了的经济/采集/出局），以便设置界面不误导我。 |
| US-5 | 房主 · 避免误胜 | 作为**房主**，我希望**默认只开【领土】**，以便新玩家不会因为"对手一秒被吃光"就莫名其妙结束一局。 |
| US-6 | 房主 · 调门槛（rts） | 作为**房主**，我希望在 rts 下能**手动微调各线的门槛数值**（在安全区间内），以便"这局想打久一点/快一点"时能自己拿捏。 |
| US-7 | 玩家（go）· 数子定胜负 | 作为**回合制对局的一方**，我希望像围棋一样，**双方都停手（连续 Pass）后按数子结算**、多者胜；吃光对方棋子**不算赢**（只是占地多），以便胜负符合围棋直觉，而不是"谁先把谁吃光谁赢"。 |
| US-8 | 玩家（go）· 终局方式 | 作为**回合制对局的一方**，我希望**双方都停手后结算**（围棋式终局），以便我知道"这局棋什么时候结束、怎么算赢"是可预期、可议和的，而不是被某个自动机制打断。 |

---

## 3. 需求池

优先级：**P0 = 没它这个功能不成立**；P1 = 应该有的完整体验；P2 = 锦上添花。

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| VC-01 | **数据模型**：新增 `victoryLines` 配置（4 个布尔开关）与 `victoryThresholds`（rts 门槛数值），贯穿 createRoom→DB→hydrate→World→snapshot→roomInfo | P0 | 传参后 `snapshot().settings.victoryLines` 与 `roomInfo().victoryLines` 与入参一致；不传时回退默认（仅 territory=true） |
| VC-02 | **判定加开关**：`_checkVictoryConditions()` 每条线前套 `if (this.victoryLines.<line>)`，未勾选线**永不触发、不发 victory 事件** | P0 | 4 条线 × 开/关 共 8 组单测：关闭线在该线成立条件下触发次数 = 0；开启线触发次数 = 1 |
| VC-03 | **默认仅【领土】**（rts 与 go 都是） | P0 | `createRoom({})` → `victoryLines = { territory:true, singularity:false, economy:false, survival:false }` |
| VC-04 | **按模式差异化开关集**：定义 `availableLines(mode)` —— go → `[territory]`；rts → `[territory, economy, singularity, survival]` | P0 | 房间接口返回 `availableLines` 数组；go 下长度=1 且仅含 territory（不含 survival/economy/singularity）；rts 下长度=4 |
| VC-05 | **后端钳制/归一**：`normVictoryLines(obj, mode)` 与 `normVictoryThresholds(obj)`；非法输入回退默认；**go 下 economy/singularity/survival 强制 false**（防越权开启无效线） | P0 | 传 `{economy:true}` 或 `{survival:true}` 进 go 房 → 归一后均为 false；传非法阈值 → 回默认；传 `null`/`''` → 回默认 |
| VC-06 | **建房入口**：`POST /api/rooms` 与 `POST /api/rooms/:code/world` 接受 `victoryLines` / `victoryThresholds`，经 `createRoom` 落库并透传给 `World` | P0 | 建房响应 `room.victoryLines` 正确；重启后 `hydrate` 恢复同值（含旧库缺列回退默认） |
| VC-07 | **房主中途改配置接口**：`PATCH /api/rooms/:code/settings`（仅房主），改后写回房间 + World + DB，并广播给房内所有人 | P0 | 非房主 403/`not_host`；房主改后其他玩家**下一次收到快照即看到新配置**；DB 持久化 |
| VC-08 | **玩家侧可见**：`roomInfo()` 与 `snapshot()` 均输出 `victoryLines`（+门槛）与 `availableLines`，供 UI 只读展示 | P0 | go 快照与 rts 快照都含 `settings.victoryLines`；`roomInfo` 含 `victoryLines`/`availableLines` |
| VC-09 | ~~go【出局】语义替换~~ → **不适用（已废弃）**：按用户新决定"把对方棋子全提光 ≠ 赢"（围棋真规则），go **不再提供【出局】胜利线**。现状 go.js 的 `wiped`（清盘出局，F5c）**不再作为判胜条件**；清盘只影响占地多少，胜负仍由终局数子决定。`survival` 在 go 下**恒为 false 且不在 `availableLines` 中** | P0 | go 下 `availableLines` 不含 survival；即使构造 API 传 `{survival:true}` 进 go 房，归一后 survival=false；**清盘（lifeCells 归 0）不触发任何胜利** |
| VC-10 | **go【领土】= 终局数子、多者胜（中国规则·数子法）**：go 下 `territory` 开启时，**终局由"双方连续停手（Pass）"触发**（**复用**现有 `passStreak >= seats.length` 机制，F5a），终局后按**中国规则数子法**（= 自己的子数 + 围住的空点数，多者胜）结算，**取代**现状的 Voronoi 领地目数算法（F5d）。**去掉先手贴子或采用贴子见 §6 Q1**。**中途不判胜**（不再"定期数子"）；吃光对方**不判胜**（F5c 的 wiped 不再入判定） | P0 | go 下开启 territory：双方连续 Pass → 终局 → 数子 X vs Y（中国规则口径）→ 多者 `won`、`winReason='territory'`（或 go 既有 `'go'`，见 §6 Q3）；相等 → 平局（看贴子方案）；**清盘一方不自动胜**；**未到双方 Pass 不中途判胜** |
| VC-11 | **rts 门槛手动可调 + 安全区间**：`victoryThresholds` 支持 `territoryRegions` / `economyLead` / `economyHoldTicks` / `singularityThreshold` / `deathLimit`，各带 `[lo,hi]` 钳制 | P1 | 超区间输入被夹到边界；`snapshot().settings.victoryThresholds` 反映实际生效值；判定用该值而非硬编码常量 |
| VC-12 | **前端 · 建房弹窗高级设置区**：模式下拉下方新增"胜利条件"区，按模式渲染勾选项 + 说明 + 默认态 | P0 | 见 §4.1；go 只渲染 1 项（领土）；默认仅勾"领土" |
| VC-13 | **前端 · 房间内设置面板**（房主可编辑 / 玩家只读） | P0 | 见 §4.2；房主改动即时生效并广播；非房主看到只读版 |
| VC-14 | **前端 · 玩家侧条件展示**：游戏内 HUD 常驻一行"胜利条件：领土 / …"，`go_end` | P0 | 见 §4.3；与 snapshot 的 `victoryLines` 一致；go 与 rts 各自正确 |
| VC-15 | **旧房间/旧存档兼容**：无 `victoryLines` 列的旧库 → 回退默认；旧内存房间（升级前创建）→ 首次访问时补默认 | P0 | 用旧 schema DB 启动 → 不报错、读默认；旧房间可正常开局 |
| VC-16 | 设置变更审计事件：改配置时发 `settings_changed` 事件（谁改的、改了什么） | P2 | 房内可见 toast"房主已更新胜利条件" |
| VC-17 | 预设方案快捷选择（"经典/速战/经营/抢地"一键填 4 开关） | P2 | 一键填充开关，仍可手改 |

**P0 最小集 = VC-01 ~ VC-10、VC-12 ~ VC-15**：即"可配置 + 可判定 + 可看见 + 可兼容"的闭环。rts 门槛微调（VC-11）与审计/预设（VC-16/17）为 P1/P2。

---

## 4. UI 设计（描述性 + ASCII 草图）

> 复用现有 `#modal` / 侧栏面板样式，不引入新组件库。两处入口共用**同一个"胜利条件"设置片段**（组件层复用）。

### 4.1 建房弹窗 · 高级设置区（US-1 / US-4 / US-5）

位置：现有建房表单"模式"下拉**下方**，默认**折叠**，标题「高级设置 ▸ 胜利条件」，点击展开。

```
┌─ 建房 ────────────────────────────────────────────────┐
│ 房间名   [________________]                           │
│ 模式     (●) 实时 rts    ( ) 回合制 go                │
│ 席位     [ 4 ▾ ]   可见性 (●)公开 ( )私密              │
│                                                       │
│ ▾ 高级设置 · 胜利条件                                  │
│   ┌───────────────────────────────────────────────┐   │
│   │ 勾选本局启用的胜利条件（未勾选则不触发）        │   │
│   │                                               │   │
│   │  [✓] 领土   占满地图 16 区且进入帝国时代 → 胜  │   │  ← rts 文案
│   │  [ ] 经济   领先 600 分并保持 90 秒 → 胜        │   │
│   │  [ ] 采集   六种资源各存满 30 → 胜             │   │
│   │  [ ] 灭族   对手全部出局 → 胜                  │   │
│   │                                               │   │
│   │  默认：仅"领土"（避免开局误胜）                 │   │
│   └───────────────────────────────────────────────┘   │
│                                                       │
│            [取消]              [创建房间]              │
└───────────────────────────────────────────────────────┘
```

**切到 go 模式时，同一区域改为**（US-4）：

```
│ ▾ 高级设置 · 胜利条件                                  │
│   ┌───────────────────────────────────────────────┐   │
│   │  [✓] 领土   双方停手后数子，多者胜             │   │
│   │                                               │   │
│   │  （回合制照围棋：连续 Pass 后按子数+空点结算；  │   │
│   │    吃光对方不算赢。本模式仅此一条）             │   │
│   └───────────────────────────────────────────────┘   │
```

规则：
- go 只渲染 **1 项**（VC-04：仅领土），rts 渲染 4 项；
- 切换模式时若已勾选项不被新模式支持（如 go 切来前勾了"经济"），**静默丢弃该项、保留其余**，并给一行灰色提示"回合制不支持『经济』，已取消勾选"；
- 默认态：**仅勾"领土"**（VC-03）。

### 4.2 房间内 · 设置面板（US-2 / US-3）

位置：房间内现有侧栏「房间」面板，"玩法设置"（`stonesPerTurn` 等）**下方**新增一行可点开的「胜利条件」。

**房主视角（可编辑）**：

```
┌─ 房间设置 ──────────────────────────────┐
│ 房间码  A1B2        [复制邀请]          │
│ 每回合落子  [3]                         │
│ 死亡宽限    [0]                         │
│ ──────────────────────────────────────  │
│ 胜利条件                          [编辑] │  ← 房主看到按钮
│   ✓ 领土（双方停手后数子，多者胜）        │

│   （改动即时生效，对本局进行中的判定同样生效）│
└─────────────────────────────────────────┘
```

点[编辑] → 弹小 modal，渲染同 §4.1 的开关片段 + 「保存」。保存后 `PATCH /api/rooms/:code/settings`，房内所有人收到广播并刷新展示。

**普通玩家视角（只读，US-3）**：

```
┌─ 房间设置 ──────────────────────────────┐
│ 胜利条件                          （房主设定）│
│   ✓ 领土（双方停手后数子，多者胜）        │
│   仅此一项                              │
└─────────────────────────────────────────┘
```

### 4.3 玩家侧 · 游戏内条件展示（US-3 / US-7 / US-8）

HUD 顶部状态条或侧栏常驻一行（与现有"模式/纪元"同区），文本随模式变化：

```
rts：  胜利条件：领土（占满16区·帝国时代）           ← 多线时用 " · " 拼接
go ：  胜利条件：领土 · 双方停手后数子，多者胜
```

- 全关（极端：房主把 4 条全关；go 下即关掉唯一一条领土）→ 显示 `胜利条件：无（本局仅计时/手动结束）`，**且后端不得因此报错**（见 §5 边界）；
- 文本与 `snapshot().settings.victoryLines` 严格一致，玩家不能编辑。

### 4.4 go 终局 · 数子结算面板（VC-10 配套，US-7/US-8）

go 局在**双方连续 Pass**（`passStreak >= seats.length`，F5a）后进入终局，弹出结算面板。**这是本次改动新增的 UI**（现状 go_end 事件已带 `blackTerritory`/`whiteTerritory`/`ranked`，但口径是 Voronoi 领地目数 F5d，需改成中国规则数子口径）。

```
┌─ 对局结束 · 数子结算 ─────────────────────┐
│        终局方式：双方停手（连续 Pass）      │

│                                          │
│   黑  X 子          白  Y 子             │   ← 中国规则：子数 + 围住的空点
│    ─────────        ─────────            │
│    胜者：黑方         （贴子：见 Q1）       │
│                                          │
│   明细：  子 120 + 空点 45 = 165          │
│           子 110 + 空点 40 = 150          │
│                                          │
│              [返回房间]                   │
└──────────────────────────────────────────┘
```

规则：
- 标题一律"**数子结算**"，并显示**终局方式**（双方停手 / 认输 / 150 手 / 超时等，沿用 `g.result.reason`）；
- 主文案：**"黑 X 子 vs 白 Y 子，X 胜"**（X>Y 显示黑胜，反之白胜，相等按贴子方案判和/判胜，见 §6 Q1）；
- 明细行展示**中国规则口径**（自己的子数 + 围住的空点数 = 总分），让"吃光≠赢"这一点对玩家可见；
- 清盘（一方被吃光）**不再影响胜负展示**——只体现为其子数与占空点变少；不得出现"清盘即胜"文案（对应 VC-09 废弃）；
- 多方局（3..8 方）：主文案改为按分数排序列出各方，取唯一最高者胜，并列按贴子/平局处理。

---

## 5. 边界与异常

| # | 场景 | 期望行为 | 归属 |
| --- | --- | --- | --- |
| E1 | **改配置时已有人胜利** | 已产生的 `won` / `winReason` **不回退**（历史事实保持）；新配置只影响**此后**的判定。UI 上胜利结算面板不因改配置消失 | VC-07 |
| E2 | **中途改配置是否影响已结束的局** | 若 `world.go.result` 已存在（go 终局）或 rts 已有人 `won` → 改配置只广播展示，**不重置结算、不重开** | VC-07 |
| E3 | **中途把正在计时的线关掉** | 该线累计计数器（如 `scoreLeadTicks`）**冻结/清零明确**：建议关掉时清零对应计数器，避免"关了再开突然累积达标"（见 §6 Q2） | VC-02 |
| E4 | **中途开启一条当前已满足的线** | 开启后**下一 tick 即可能触发**（这是房主明确选择"现在生效"的预期结果）；需在改动确认文案里提示"开启后若条件已满足将立即判定" | VC-07 |
| E5 | **go 模式强行开经济/采集/出局** | `normVictoryLines(obj, 'go')` **强制归零 economy/singularity/survival**，即使用户构造 API 请求绕过 UI；响应回显实际生效值 | VC-05 |
| E6 | **胜利线全关** | 合法配置；判定函数早退、不发 victory；游戏靠手动/**终局机**结束（go 的 pass/150 手/超时/认输仍在）；UI 明示"无胜利条件"。**注意**：go 关掉领土后，双方 Pass 仍会终局（`_goFinish` 仍跑），但**不宣告任何胜者**（`winner=null`，只展示数子明细或"无胜利条件"） | VC-02/VC-14 |
| E7 | **旧房间 / 旧库存无 `victoryLines` 列** | `migrate()` 补列（沿用 F7 的 `ALTER TABLE ... ADD COLUMN` 幂等写法）；`hydrate`/`ensureWorld` 读 NULL → 回退默认（仅 territory） | VC-15 |
| E8 | **旧内存房间（升级前已建、未落库）** | 首次 `roomInfo`/`worldForRoom` 访问时补默认，不抛错 | VC-15 |
| E9 | **门槛数值非法**（负数/超大/非数字/小数） | `normVictoryThresholds` 用 `_clampInt` 同类逻辑夹到 `[lo,hi]` 并取整；非数字回默认 | VC-05/VC-11 |
| E10 | **非房主调用改配置接口** | 403/`not_host`；房主判定复用现有 `w.hostId !== req.user.id`（`server/routes.js` L404/L439 同款） | VC-07 |
| E11 | **模式未定（建房后世界未建）时改配置** | 改的是 `room.victoryLines`；建世界时由 `worldForRoom` 透传（F7 同款），不丢 | VC-06 |
| E12 | **go 清盘（wiped）不再判胜（用户新决定）** | 删除"清盘即胜"。go.js 现有 `wiped`/`last_standing` 终局机（F5c）**不再作为"宣告胜者"的依据**：清盘仅使该方子数减少，**胜负仍由终局数子决定**（VC-09/VC-10）。是否**保留"清盘即终局"**（即一方没子了直接结束、仍去数子）还是**允许空盘继续下到双方 Pass** → 见 §6 Q1 | VC-09/VC-10 |
| E13 | **rts `survival` 开启 vs `DEATH_LIMIT`** | `survival` 开着时，行为 = 现状（`DEATH_LIMIT` 出局后剩 1 人 → 对方胜）；关闭时，最后一人**不自动胜**，可继续经营 | VC-02 |
| E14 | **go 中途判胜已移除** | 不再"定期数子"（旧 VC-10 已废）。**只有**终局（双方连续 Pass / 150 手 / 超时 / 认输）后才数子定胜负；未终局一律不宣告胜者 | VC-10 |

---

## 6. 技术接入点（供架构师落地，本文不改动代码）

> 新增配置**逐字段照抄** `stonesPerTurn` / `lonelyDeathDelay` 的完整链路（F7），保证"重启不丢、旧库不炸"。

| 环节 | 现状锚点 | 本次接入方式 |
| --- | --- | --- |
| 常量 | `engine.js` L690–751 | 新增 `VICTORY_LINE_KEYS = ['territory','economy','singularity','survival']`、`VICTORY_LINE_DEFAULT = {territory:true, 其余:false}`、`VICTORY_AVAILABLE = { rts:[4条], go:['territory'] }`、各门槛 `xxx_MIN/MAX` 安全区间；复用 `_clampInt` |
| 归一 | `rooms.js` L34–48 `norm*` | 新增 `normVictoryLines(v, mode)`（含 go 强制归零 economy/singularity/**survival**）与 `normVictoryThresholds(v)`，同风格（未提供→默认，非法→默认） |
| 房间模型 | `rooms.js` `createRoom` L70–101 / `hydrate` L104–123 | `room.victoryLines` / `room.victoryThresholds`，`norm*` 后写入；`hydrate` 从 DB 读、缺列回默认 |
| DB | `schema.sql` L48–59；`db/index.js` L123–126/L323–344 | rooms 表加 `victory_lines TEXT`（JSON 串）与 `victory_thresholds TEXT`（JSON 串）；`migrate()` 加幂等 `ALTER TABLE`；`create()` 的 INSERT 加列；`setSettings()` 供中途改 |
| 路由透传 | `routes.js` L110–135 `ensureWorld`/`worldForRoom`、L231–241、L313–341、L381–385 | 把 `room.victoryLines`/`victoryThresholds` 加进 `opts` 透传链（与 `stonesPerTurn` 并列） |
| World | `engine.js` L57–63 构造器 | `this.victoryLines = norm(normalize 后)`、`this.victoryThresholds = ...`（引擎侧用 `_clampInt` 再兜一次，双保险） |
| 判定 | `engine.js` `_checkVictoryConditions` L1357–1403 | **每条线开头加 `if (!this.victoryLines.<line>) { continue; }`**；rts 门槛常量改读 `this.victoryThresholds.*`（默认值 = 原常量，保证不传时行为逐字节不变）。**本函数只服务 rts**：go 不进入此函数（go 无经济/资源/纪元，其胜负由 `go.js` 的终局数子独立决定）；go 下 `survival` 恒 false，此分支在 go 中不会被调用 |
| go 判定 | `go.js` `_goEndTurn` L681 / `_goFinish` L730 / `_goScore` L634 | **终局触发复用现状**：`passStreak >= seats.length` → `endReason='pass'`（F5a，无需新增）。**改造点**：① `_goFinish` 的胜负依据从"Voronoi 领地目数"（F5d）改为**中国规则数子法**（自己的子数 + 围住空点数，含/不含贴子按 §6 Q1）；② **移除**"清盘即判胜"：L691-699 的 `wiped` 与 L706-708 的 `last_standing` **不再作为宣告胜者的依据**（是否仍触发终局见 Q1）；③ `territory` 开关：**关** → 终局时不宣告胜者（`winner=null`）；**开** → 终局数子、多者胜；④ 其余终局机（150 手/超时/认输）**不动** |
| 快照 | `engine.js` `snapshot` L1419–1428 | `settings` 增加 `victoryLines` / `victoryThresholds` / `availableLines`（rts 与 go 都输出） |
| 房间视图 | `rooms.js` `roomInfo` L162–204 | 增加 `victoryLines` / `victoryThresholds` / `availableLines`（世界为权威，否则房间记录） |
| 中途改配置接口 | 参照 `routes.js` pause 路由 L437–443（`hostId` 校验范式） | 新增 `PATCH /rooms/:code/settings`：校验房主 → 归一 → 写 `room` + `w` + DB → 广播 |
| 前端 | `public/client.js` / `public/index.html` | 建房弹窗高级设置区（§4.1）、房内面板（§4.2）、HUD 展示（§4.3）、**go 数子结算面板（§4.4）**；只读消费 `snapshot.settings` / `roomInfo` / `go_end` 事件 |
| 确定性 | IR-3a | 本功能**不引入任何随机**；归一/钳制为纯函数；不影响 `mulberry32` 种子流 |

### 判定函数改造示意（伪码，仅示意改动范围）

```js
_checkVictoryConditions(events) {
  const ps = Object.values(this.players).filter(p => !p.lost);
  if (ps.length === 0) return;
  const V = this.victoryLines || { territory: true };

  if (V.singularity) { /* 原 L1360-1369，门槛读 this.victoryThresholds.singularity */ }
  if (V.territory)   { /* 原 L1370-1379；rts 读阈值；go 下此函数不参与（go 走 go.js 终局数子） */ }
  if (V.economy)     { /* 原 L1380-1392；读 economyLead / economyHoldTicks */ }
  if (V.survival)    { /* 原 L1393-1402；rts 语义不变；go 下 V.survival 恒 false，不触发 */ }
}
```

### go 终局改造示意（伪码，仅示意改动范围）

```js
// _goEndTurn：终局触发**复用现状**（F5a），不动
if (g.passStreak >= seats.length) endReason = 'pass';   // ← 已有，L688

// _goFinish：胜负依据改造
P._goFinish = function (reason, events) {
  const sc = this._goScore();          // ← 需改造为"中国规则数子"口径（子数 + 空点）
  // 移除"wiped / last_standing 即胜"，改为：终局后统一按数子排名
  const winner = this.victoryLines.territory ? pickTopByScore(sc) : null;  // 关线 → 不宣告胜者
  g.result = { winner, reason, ranked, /* 黑 X 子 / 白 Y 子 */ };
  events.push({ type: 'go_end', winner, reason, ranked, blackScore, whiteScore });
  if (winner != null) { p.won = true; p.winReason = 'territory' /* 或 'go'，见 Q3 */; }
};
```

---

## 7. 待确认问题（需用户/架构师拍板）

| # | 问题 | 为什么需要拍板 | 我的倾向 |
| --- | --- | --- | --- |
| **Q1** | **go 终局机的对齐（关键）**：现状已有以下终局触发 —— ① `passStreak >= seats.length`（全员各 Pass 一次，**两方局 = 双方连续停手，正是用户要的**，F5a）；② `moveNo >= 150`；③ `wiped`（一方清盘，F5c）；④ `last_standing`（只剩 1 人）；⑤ 超时；⑥ 认输。**用户新决定只认可"双方连续停手"作为正常终局**。**需拍板 3 个子问题**：(a) `wiped`/`last_standing` 是否**仍触发终局**（只是不再判胜），还是**完全忽略、让空盘一方继续 Pass 直到双方停手**？(b) 多方局（≥3）的"连续 Pass"门槛是否仍 = 在座人数（F5b 现状），还是改为严格围棋的"2 次"？(c) **贴子（komi）**：是否加"黑贴 3¾ 子"？本游戏**是否公平轮替**（双方是否同先后手机会）？ | 决定 go 的核心终局语义与数子口径，直接关系 VC-10 的实现与玩家体感 | (a) **建议只降级为"不判胜"、仍可触发终局**（最小改动：复用现状终局机，仅改 `_goFinish` 胜负依据），即"清盘 → 直接终局 → 数子定胜负"，与"吃光≠赢"一致；(b) **建议多方局保留"全员各 Pass"的自适应门槛**（比严格 2 次更适合 3..8 方对战），两方局天然等价围棋；(c) **两方局建议给黑方贴 3¾ 子**（照围棋惯例），**但若本游戏不保证公平轮替**（一局内黑先白后固定）→ 贴子只在"多局擂台"有意义，单局可先**不贴**、或贴子做成**房主可配项**（P1）。**我方默认倾向：单局不贴、两方局可选贴 3¾ 子（P1 房主开关）** |
| **Q2** | **中途关闭一条"正在累计"的线时，累计计数器（`scoreLeadTicks` 等）是否清零？** | 影响"关了再开是否瞬间达标"的可预期性（E3） | **关闭即清零**对应计数器，避免"关掉攒条、打开即胜"的钻空子行为 |
| **Q3** | **go 数子胜的 `winReason` 用 `'territory'` 还是沿用 go 既有 `'go'`？** 现有 `_goFinish` 里 `p.winReason='go'`（L756） | 影响前端文案分支与榜单口径 | 建议**沿用 `'go'`**（因为 go 现在只有"数子胜"一种胜法，不再需要区分"清盘胜"，Q1 已废 survival），改动最小、不影响既有榜单；若前端要文案区分，用 `reason`（pass/150/timeout/resign）而非新增 winReason。**待架构师确认榜单/统计是否已依赖 `'go'`** |
| **Q4** | **rts【生存/灭族】的开关是否也联动 `DEATH_LIMIT` 出局本身？** 还是只联动"是否宣告胜利"？ | 决定"关掉灭族"后，对手是否**仍会因 12 次死亡而出局**（只是不再自动胜） | 建议**只联动"是否宣告胜利"**，`lost`（出局）保持 12 次死亡不变——出局是"逐出对局"的机制，胜利线是"谁算赢"的机制，两者解耦更清晰 |
| **Q5** | **rts 门槛是否本迭代就开放手动微调（VC-11）？** 还是先只做"开关"、门槛硬编码不动？ | 影响工作量与风险：动门槛常量 = 动判定数学，回归面变大 | 建议 **P0 只做开关，门槛保持原常量**（风险最小）；门槛微调放 P1，且给出安全区间（如 `territoryRegions ∈ [6,40]`、`economyLead ∈ [200,2000]`），避免房主设出"3 秒就赢"的畸形配置 |
| **Q6** | **胜利线全关是否允许**（go 下即关掉唯一一条领土）？ | 若允许，需要 UI 明示 + 后端不报错；若禁止，需在归一里兜底强制至少开一条 | 建议**允许**（房主自由），但 UI 给一行醒目提示"本局无胜利条件，需手动结束"；归一不强制。**注意**：go 下关掉领土后，双方 Pass **仍会终局**（`_goFinish` 仍跑），只是**不宣告胜者**（`winner=null`）——见 E6 |

---

## 8. 与项目铁律的一致性自检

| 铁律 | 本需求的落实 |
| --- | --- |
| **算法是世界法则，单位是涌现** | 本需求**不新增任何单位/名词**；只改"配置面"与"判定的开关包裹"+ go 终局数子口径对齐（照围棋规则） |
| **延迟 = 惯性**（不检测不补偿） | 配置变更随快照/`roomInfo` 广播，不走任何延迟补偿；玩家侧只是"读到最新配置" |
| **IR-3a 算法确定性** | 归一/钳制为纯函数，**不引入随机**；不改动 `mulberry32` 种子流，不影响同 seed 复现 |
| **IR-3b 离散 tick** | rts 判定仍在 20TPS tick 内（`_checkVictoryConditions` 原调用点不变）；go 仍在 1s 循环/落子结算点判定；**双方 Pass 终局复用现有 `_goEndTurn` 路径**（F5a），不新增定时器 |
| **不回归** | 不传新配置时，`norm*` 回默认、判定读默认=原常量 → **rts 行为逐字节不变**；go 的**终局触发**不变（`passStreak>=seats.length`/150/超时/认输），仅 **`_goFinish` 胜负依据**由 Voronoi 目数改为中国规则数子、并移除"清盘即胜"——此项是**用户明确要求的行为变更**，需相应更新 go 相关既有测试（若原测试断言 `wiped` → 判胜，须改）；`npm test` 262 条须保持全绿（如因语义变更需同步调整，须在 PR 说明） |

---

## 9. 验收门槛（DoD）

1. P0 需求 VC-01 ~ VC-10、VC-12 ~ VC-15 全部通过验收标准。
2. rts 4 条线 × 开/关 共 8 组判定单测：**关闭的线触发次数 = 0**。
3. 默认配置（两模式）实测 = 仅【领土】；**go 的 `availableLines` 长度 = 1**（仅 territory）。
4. **go 终局走"双方连续 Pass"**：两方局下双方各 Pass 一次 → 触发终局 → 弹出数子结算面板（§4.4）；单测覆盖"连续 Pass 即终局"。
5. **清盘不判胜**：构造"一方 lifeCells 归 0、另一方有子"的局面 → **不因此宣告胜者**，胜负仍由终局数子决定（VC-09/VC-10）。
6. **数子口径 = 中国规则**：单测断言结算总分 = 自己的子数 + 围住空点数（非 Voronoi 目数）。
7. 房主中途改配置：非房主被拒（403）；房主改动**下一次快照即在其他客户端可见**；重启后配置不丢。
8. 用"旧 schema DB + 旧内存房间"启动，无报错、读默认、可正常开局。
9. **现有 `npm test`（262 条）全绿**，新增用例只增不减（go 语义变更相关旧断言按 §8 说明同步）。
