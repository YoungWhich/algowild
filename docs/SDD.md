# 涌现之地（Emergent Lands）软件设计文档 SDD

| 项目 | 内容 |
| --- | --- |
| 文档版本 | **v4.0** |
| 关联文档 | `PRD.md`、`GDD.md`、`TESTPLAN.md` |
| 运行时 | Node.js v22 + Express 4 + `ws` 8 + SQLite |
| 端口 | 3000（HTTP + WebSocket 同端口，WS 路径 `/ws`） |
| 数据库 | `server/data/game.db` |
| 引擎 | `server/engine/`（内核库 `algorithms/`、世界 `world/`） |
| 网络层 | `server/net/` |

> **一致性声明**：四份文档中的路径、端口、字段名、内核名、WS 消息类型、错误码**逐字符一致**。文档内部冲突时以本章「数据模型 / API 契约 / WS 协议 / tick 管线」为准。

---

## 1. 架构设计

### 1.1 分层

```
浏览器 (public/)
  ├─ Canvas 2D 渲染（仅视觉插值，不跑世界逻辑）
  └─ WebSocket /ws：只发 intent，只收 snapshot/delta/event
        │
Express 4  ──  REST /api/*  ──▶ routes → services → {repositories | engine} → db(server/db)
  │
  └─ ws 服务（同端口 /ws）
        └─ net/hub.js（房间与连接管理）
              └─ engine/world/simulate.js  ← 世界唯一权威
                    └─ engine/algorithms/* （46 个纯函数内核）
```

| 层 | 目录 | 职责 | 依赖 |
| --- | --- | --- | --- |
| 表现层 | `public/` | 渲染、输入、HUD；**不得实现任何世界逻辑** | HTTP + WS |
| 网络层 | `server/net/` | 连接鉴权、房间、指令队列、广播节流 | `services`、`engine` |
| 接口层 | `server/src/routes/` | 参数校验、调用 service | `services` |
| 业务层 | `server/src/services/` | 世界/存档/计分业务 | `repositories`、`engine` |
| 持久层 | `server/src/repositories/` + `server/db/` | SQL（仅 `?` 位置参数） | `db.js` |
| **世界引擎** | `server/engine/` | **纯函数世界模拟 + 46 内核**，无 IO | 无 |
| 内核库 | `server/engine/algorithms/` | 46 个 `fn(ctx, rng, params)` | 无 |

**铁律**：`server/engine/**` 内**禁止**出现 `require('fs')`、`require('http')`、`Date.now()`、`Math.random()`、数据库访问。

### 1.2 目录结构（精确到文件名）

```
D:\workspace\Game\
├─ package.json
├─ .env.example
├─ .gitignore                        # node_modules/  server/data/  .env
├─ README.md
├─ docs/
│  ├─ PRD.md   ├─ GDD.md   ├─ SDD.md   └─ TESTPLAN.md
├─ server/
│  ├─ data/                          # 运行时创建：game.db / -wal / -shm
│  ├─ engine/                        # ★ 世界引擎（纯函数，无 IO）
│  │  ├─ index.js                    # 导出 simulateTick / createWorld / EMERGENTS / KERNEL_COUNT
│  │  ├─ constants.js                # 与 GDD §10 完全一致的全部常量
│  │  ├─ rng.js                      # mulberry32 + Rng { float/int/pick/calls }
│  │  ├─ grid.js                     # 距离、NEIGHBORS8/4、inBounds、key、区块划分
│  │  ├─ kernel.js                   # ★ 内核注册器：KERNELS / callKernel / HARD / kernelStats
│  │  ├─ algorithms/                 # ★ 46 个纯函数内核，每文件 1 个
│  │  │  ├─ index.js                 # KERNELS 静态注册表（46 项）+ 分支分组
│  │  │  ├─ bfs.js               ├─ astar.js
│  │  │  ├─ dijkstra.js          ├─ mst_prim.js
│  │  │  ├─ mst_kruskal.js       ├─ topo_sort.js
│  │  │  ├─ union_find.js        ├─ flow_field.js
│  │  │  ├─ task_assign.js       ├─ pagerank.js
│  │  │  ├─ boids.js             ├─ pso.js
│  │  │  ├─ aco.js               ├─ conway.js
│  │  │  ├─ rule110.js           ├─ dbscan.js
│  │  │  ├─ minimax_ab.js        ├─ mcts_sample.js
│  │  │  ├─ fsm.js               ├─ behavior_tree.js
│  │  │  ├─ decision_tree.js     ├─ fuzzy_logic.js
│  │  │  ├─ markov_chain.js      ├─ genetic.js
│  │  │  ├─ simulated_annealing.js ├─ hill_climb.js
│  │  │  ├─ tabu_search.js       ├─ voronoi_grid.js
│  │  │  ├─ quadtree.js          ├─ bresenham.js
│  │  │  ├─ raycast.js           ├─ value_noise.js
│  │  │  ├─ go_liberty.js        ├─ gomoku_pattern.js
│  │  │  ├─ xiangqi_moves.js     ├─ mc_build.js
│  │  │  ├─ tech_tree.js         ├─ priority_queue.js
│  │  │  ├─ bloom_filter.js      ├─ pid.js
│  │  │  ├─ queue_cooling.js     ├─ kalman.js
│  │  │  ├─ lsystem.js           ├─ falling_sand.js
│  │  │  ├─ elastic_collision.js └─ food_chain.js
│  │  └─ world/                      # ★ 世界模拟
│  │     ├─ generate.js              # 地形生成（value_noise + union_find）
│  │     ├─ world.js                 # World 结构：terrain/entities/blocks/weather/global/rng
│  │     ├─ simulate.js              # ★ tick 主循环（9 阶段管线）与降级
│  │     ├─ physics.js               # 冲量积分 + quadtree 粗筛 + elastic_collision
│  │     ├─ intents.js               # 指令队列（FIFO，按到达顺序）与冲量累加
│  │     ├─ emergent.js              # ★ 涌现识别器（14 种）与实体工厂
│  │     ├─ layers.js                # 生命层 / 落沙层 / 信息素层的轮转更新
│  │     ├─ weather.js               # 昼夜 / 季节 / 天气（markov_chain）
│  │     ├─ needs.js                 # 饥饿 / 生命 / 温度
│  │     ├─ build.js                 # 建造队列（queue_cooling + mc_build）
│  │     ├─ tech.js                  # 科技树（tech_tree + topo_sort）
│  │     ├─ entities.js              # 实体属性表（质量 / 速度 / HP）与上限
│  │     ├─ events.js                # 事件构造与广播缓冲
│  │     └─ persist.js               # 序列化 / RLE 压缩 / 反序列化
│  ├─ net/                           # ★ 实时层
│  │  ├─ wsServer.js                 # ws 服务（路径 /ws，5s hello 超时，帧大小限制）
│  │  ├─ hub.js                      # 房间：加入 / 离开 / 广播节流 / 断线重连窗口
│  │  ├─ protocol.js                 # 消息类型常量与校验（12 种）
│  │  └─ broadcast.js                # delta / snapshot / heartbeat 构造与节流
│  ├─ db/                            # ★ 数据库适配
│  │  ├─ index.js                    # 出口（自动 A/B 切换）
│  │  ├─ betterSqlite.js             # 驱动 A
│  │  ├─ nodeSqlite.js               # 驱动 B（node:sqlite）
│  │  └─ migrate.js                  # 执行 schema.sql
│  └─ src/                           # Express 应用
│     ├─ index.js                    # 入口：配置 → DB → 中间件 → 路由 → http+ws → 优雅关闭
│     ├─ config.js  ├─ logger.js  ├─ errors.js
│     ├─ schema.sql                  # 建表 SQL（§7.2）
│     ├─ middleware/
│     │  ├─ auth.js      ├─ rateLimit.js
│     │  ├─ validate.js  ├─ security.js  └─ notFound.js
│     ├─ routes/
│     │  ├─ index.js  ├─ auth.routes.js
│     │  ├─ world.routes.js  ├─ score.routes.js  └─ save.routes.js
│     ├─ services/
│     │  ├─ auth.service.js  ├─ world.service.js
│     │  ├─ score.service.js └─ save.service.js
│     ├─ repositories/
│     │  ├─ user.repo.js  ├─ world.repo.js
│     │  ├─ score.repo.js └─ save.repo.js
│     └─ utils/
│        ├─ password.js  ├─ token.js
│        ├─ validate.js  ├─ time.js  └─ json.js
└─ public/
   ├─ index.html
   ├─ css/style.css
   └─ js/
      ├─ config.js     # 常量、地形色、涌现标记字
      ├─ api.js        # REST 封装
      ├─ net.js        # WebSocket 客户端（发 intent / 收 delta）
      ├─ auth.js       ├─ render.js   # Canvas 几何绘制（零图片）
      ├─ input.js      # 键盘 / 虚拟摇杆 → intent
      ├─ hud.js        # 血/饥饿/温度/库存/科技/事件
      ├─ build.js      ├─ tech.js
      ├─ save.js       ├─ leaderboard.js
      └─ main.js
```

> `public/` 下**禁止**任何图片 / 图标 / 字体二进制文件（PRD AC-018）。

---

## 2. 技术选型与理由

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js v22.22.2 | 环境已有；原生 `node:sqlite` 可用作降级 |
| Web | Express 4.x | 轻量、生态成熟 |
| 实时 | `ws` 8.x | 事实标准；与 Express 共享 HTTP server（同端口 3000） |
| 数据库 | SQLite（better-sqlite3 v11） | 零运维、单文件、同步 API 便于事务 |
| 降级 | `node:sqlite`（内置 `DatabaseSync`） | 环境无 Python / 构建工具，better-sqlite3 可能装不上 |
| 密码 | **bcryptjs**（纯 JS） | 同上，避免原生编译 |
| 令牌 | jsonwebtoken（HS256） | 简单可靠 |
| 前端 | 原生 HTML/CSS/JS + Canvas 2D | 无构建工具、零资源 |

### 2.1 better-sqlite3 自动降级（**必须实现**）

```js
// server/db/index.js
let driver;
try {
  require('better-sqlite3');
  driver = require('./betterSqlite.js');          // 同步 API，性能最好
} catch (e) {
  driver = require('./nodeSqlite.js');            // node:sqlite（Node 22 内置）
}
module.exports = driver;
```

**统一适配器接口**（两种驱动都必须实现，行为一致）：

| 方法 | 语义 |
| --- | --- |
| `exec(sql)` | 执行多条语句（建表 / PRAGMA） |
| `prepare(sql)` → `{ get(...p), all(...p), run(...p) }` | 预编译 |
| `get(sql, ...p)` / `all(sql, ...p)` / `run(sql, ...p)` | 便捷封装 |
| `transaction(fn)` | `BEGIN` → `fn()` → `COMMIT`，异常 `ROLLBACK` |
| `lastInsertId()` | `Number(info.lastInsertRowid)` |
| `driverName` | `'better-sqlite3'` \| `'node:sqlite'` |

**约束**：全部使用 `?` **位置参数**；`node:sqlite` 的 `BigInt` 一律 `Number()` 转换；启动时 `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`；`/api/health` 返回 `data.dbDriver`。

---

## 3. 配置与环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 与 WS 共用 |
| `JWT_SECRET` | 必填 | HS256 密钥（≥ 32 字符） |
| `JWT_EXPIRES_IN` | `604800` | 7 天（秒） |
| `DB_PATH` | `./server/data/game.db` | 数据库文件 |
| `NODE_ENV` | `development` | — |
| `TRUST_PROXY` | `0` | 反代时置 1 |
| `TICK_RATE` | `20` | TPS（不建议修改） |
| `TICK_BUDGET_MS` | `50` | tick 软预算 |
| `IDLE_TPS` | `2` | 无玩家在线时的降频 |
| `MAX_PLAYERS_PER_ROOM` | `8` | 房间上限 |
| `RECONNECT_WINDOW_MS` | `60000` | 断线重连窗口 |
| `MAX_WS_FRAME_BYTES` | `65536` | 单帧上限 |
| `PERSIST_TICKS` | `100` | 落盘间隔 |

---

## 4. 世界模拟主循环（tick 管线）

### 4.1 循环形态

```js
// server/net/hub.js 每个房间持有一个 world
const interval = Math.round(1000 / TICK_RATE);           // 50ms
timer = setInterval(() => {
  const t0 = now();                                        // performance.now()
  try { simulateTick(world); }
  catch (e) { logger.error('tick error', e); world.tickDegraded++; }
  const dt = now() - t0;
  if (dt > TICK_BUDGET_MS) { world.tickDegraded++; slowTicks.push(dt); }
  if (world.tick % DELTA_TICKS === 0) broadcastDelta(world);
  if (world.tick % SNAPSHOT_TICKS === 0) { broadcastSnapshot(world); persist(world); }
  if (world.tick % 20 === 0) broadcastHeartbeat(world);
}, interval);
```

> 无玩家在线时 `setInterval` 改为 `1000 / IDLE_TPS`（500ms），世界继续演化但降低 CPU 占用；有人加入即恢复 20 TPS。

### 4.2 tick 管线（**顺序固定，确定性铁律**）

| # | 阶段 | 函数 | 预算 | 内容 | 超时降级 |
| --- | --- | --- | --- | --- | --- |
| 1 | 消费指令 | `intents.consume` | 2ms | 按**到达顺序**出队，同向 `move` 合并（≤`MERGE_MAX`），写入 `pendingImpulse` | 丢弃剩余队列 |
| 2 | 物理积分与碰撞 | `physics.step` | 12ms | `v += J/m` → 阻尼 → 限速 → `pos += v` → `quadtree` 粗筛 → `elastic_collision` 精算 | 只做位置积分，跳过碰撞 |
| 3 | 涌现层演化 | `layers.step` | **18ms** | **仅轮转到本 tick 的 1/4 区块**：生命层 `conway`（每 4 tick 一代）、落沙层 `falling_sand`、信息素 `aco`、群 `boids`、生长 `lsystem` | 跳过本 tick 剩余区块 |
| 4 | 天气与昼夜 | `weather.step` | 2ms | `markov_chain` 天气转移；`tick % DAY_TICKS` 推进昼夜；`day % SEASON_DAYS` 推进季节 | 保持当前状态 |
| 5 | 生存需求 | `needs.step` | 2ms | 饥饿 / 温度 / 生命；饥饿 0 → 掉血；死亡处理 | 跳过 |
| 6 | 建造队列 | `build.step` | 3ms | `queue_cooling` 冷却结算 → 落建筑；`go_liberty` 检查吞并 | 队列保留到下一 tick |
| 7 | 科技与产出 | `tech.step` | 2ms | `tech_tree` + `topo_sort` 解锁；农场 / 仓库产出；`pagerank` 枢纽加成 | 跳过 |
| 8 | 生态调节 | `emergent.rebalance` | 3ms | `dbscan` 聚群、`food_chain` + `pid` 刷新 / 抑制；`MAX_ENTITIES` 守卫 | 只做上限裁剪 |
| 9 | 事件与持久化 | `events.flush` + `persist` | 6ms | 事件入广播缓冲；每 100 tick 落盘 | 落盘推迟 |

**合计 50ms**；任一段超过自身预算 → 记录 `tickDegraded` 并执行该段降级动作；**连续 10 个 tick 降级** → 生态层（`layers.step`）降为每 4 tick 执行一次 + 记 WARN 日志。

### 4.3 确定性铁律（引擎内）

1. 唯一随机源是 `world.rng`（`mulberry32(seed)`）；禁止 `Math.random()` / `Date.now()`。
2. 时间只来自 `world.tick`（整数计数）。
3. 集合遍历用数组且顺序固定：实体按 `id` 升序；邻域按 `NEIGHBORS8/4`；区块按 `(cy*6+cx)` 升序。
4. 禁止依赖 `Object.keys` / `Set` / `Map` 迭代顺序做逻辑分支；需遍历时先排序。
5. 比较器必须全序（主键 + 副键 + id）。
6. 浮点只经 `Math.floor/round/max/min` 后参与比较；物理量保留浮点但广播时量化为 **3 位小数**。
7. **指令顺序 = 到达顺序**（FIFO），**不排序、不按时间戳**。

### 4.4 强终止与降级（四重保障）

| # | 保障 | 说明 |
| --- | --- | --- |
| 1 | 内核硬上限 | 每次 `callKernel` 前 `clampParams` 夹取到 `HARD`；单次调用必然在常数时间内返回 |
| 2 | 区块轮转 | 生态层每 tick 只处理 1/4 区块（9 个区块），上限固定 |
| 3 | 实体上限 | `MAX_ENTITIES = 512`；超限时 `food_chain` 抑制刷新，新实体直接丢弃 |
| 4 | 异常隔离 | 每阶段 `try/catch`；内核抛错 → `__meta.fallback`；阶段抛错 → no-op；tick 抛错 → 记录并继续下一 tick |

---

## 5. 算法内核库设计（`server/engine/algorithms/`）

### 5.1 内核契约（**所有内核必须遵守**）

```js
/**
 * @param {Readonly<Ctx>} ctx    只读上下文 { grid, entities, weather, tick, side, config }
 * @param {Rng}           rng    注入的确定性随机源（唯一随机来源）
 * @param {Object}        params 参数对象，可 JSON 序列化；缺失上限由注册器填默认
 * @returns {Object|number|Array} 纯数据，不得返回函数 / 引用
 */
module.exports = function kernelName(ctx, rng, params) { /* 核心逻辑 ≤15 行 */ };
module.exports.__meta = { id, branch, hardLimits, fallback };
```

| # | 规则 |
| --- | --- |
| K1 | 核心逻辑 **≤15 行**（辅助工具外置到 `grid.js`，不计入） |
| K2 | **不得修改 `ctx`**；需要输出时构造新对象返回 |
| K3 | 随机只能用 `rng.float()` / `rng.int(n)` / `rng.pick(arr)`；**禁止 `Math.random()`** |
| K4 | 禁止 `Date.now()` / `performance.now()` / IO / `require` 外部模块（除 `../grid.js`、`../constants.js`） |
| K5 | 所有循环带**显式计数上限**，所有递归带 `depth` 并在入口 `if (depth >= max) return ...` |
| K6 | 所有上限参数从 `params` 读取并经注册器**夹取**（`clamp(param, 1, HARD[key])`） |
| K7 | 返回值确定性：相同 `(ctx, rng 序列, params)` 必得相同结果 |
| K8 | 抛错由 `callKernel` 捕获 → 返回 `__meta.fallback`（等价 no-op） |
| K9 | 每个文件顶部必须有**一行 JSDoc 注释**说明语义 |
| K10 | 每个内核导出 `__meta = { id, branch, hardLimits, fallback }` |

### 5.2 注册与调用（`engine/kernel.js`）

```js
const HARD = {                                  // 绝对上限，任何 params 不得突破
  maxNodes: 144, maxIter: 32, maxDepth: 4, maxPop: 16, maxGen: 8,
  maxSamples: 16, maxTabu: 8, maxSteps: 24, maxRays: 8, maxRaySteps: 12,
  maxClusters: 8, maxLen: 64, maxItems: 64, maxCells: 144, maxTransitions: 8,
  maxRules: 8, maxMoves: 16, maxCandidates: 32, maxBits: 128, maxHashes: 3,
  maxParticles: 16, maxPoints: 64, maxEdges: 64, maxSpecies: 8, maxPairs: 64
};

const kernelStats = { errors: {}, slow: {} };   // 供测试断言（导出）

function callKernel(id, ctx, rng, params = {}) {
  const k = KERNELS[id];
  if (!k) throw new Error('unknown kernel: ' + id);
  const p = clampParams(params, k.__meta.hardLimits);      // K6
  const t0 = performance.now();
  try { return k.fn(ctx, rng, p); }
  catch (e) { kernelStats.errors[id] = (kernelStats.errors[id] || 0) + 1; return k.__meta.fallback; }
  finally { if (performance.now() - t0 > 5) kernelStats.slow[id] = (kernelStats.slow[id] || 0) + 1; }
}
```

- 世界与涌现逻辑**只能**通过 `callKernel(id, ...)` 使用内核，禁止直接 `require` 内核文件。
- `KERNELS` 在 `algorithms/index.js` 静态注册 **46** 项；`/api/health` 的 `data.kernels = Object.keys(KERNELS).length`（必须 46）。

### 5.3 内核清单与硬上限（46 个）

| 分支 | 内核 id | 硬上限 | 兜底返回值 |
| --- | --- | --- | --- |
| graph-search | `bfs` | `maxNodes:144` | `{ dist:{}, prev:{}, visited:0 }` |
| graph-search | `astar` | `maxNodes:144` | `{ path:[], cost:-1, expanded:0 }` |
| graph-search | `dijkstra` | `maxNodes:144` | `{ path:[], cost:-1, expanded:0 }` |
| graph-search | `mst_prim` | `maxNodes:64` | `{ edges:[], total:0 }` |
| graph-search | `mst_kruskal` | `maxNodes:64`,`maxEdges:64` | `{ edges:[], total:0 }` |
| graph-search | `topo_sort` | `maxIter:32` | `{ order:[], cyclic:false }` |
| graph-search | `union_find` | `maxNodes:64` | `{ parent:{}, groups:0 }` |
| graph-search | `flow_field` | `maxNodes:144` | `{ field:{} }` |
| graph-search | `task_assign` | `maxIter:32` | `{ pairs:[] }` |
| graph-search | `pagerank` | `maxIter:16` | `{ scores:{}, iters:0 }` |
| swarm | `boids` | 邻域 ≤8 | `{ vec:[0,0], mode:'ALIGN' }` |
| swarm | `pso` | `maxIter:32`,`maxParticles:16` | `{ best:[0,0], vel:[0,0] }` |
| swarm | `aco` | `maxIter:32`,`maxCells:64` | `{ cell:null, pheromone:{} }` |
| swarm | `conway` | 单次 1 代,`maxCells:144` | `{ born:[], dead:[] }` |
| swarm | `rule110` | `maxLen:64` | `{ bits:[] }` |
| swarm | `dbscan` | `maxPoints:64`,`maxClusters:8` | `{ clusters:[], noise:[] }` |
| game-decision | `minimax_ab` | `maxDepth:4`,`maxNodes:64` | `{ action:null, score:0, ranked:[] }` |
| game-decision | `mcts_sample` | `maxSamples:16` | `{ scores:{}, samples:0 }` |
| game-decision | `fsm` | `maxTransitions:8` | `{ state:params.cur ?? 'IDLE', entered:false }` |
| game-decision | `behavior_tree` | `maxNodes:64` | `{ status:'FAILURE', action:null }` |
| game-decision | `decision_tree` | `maxDepth:4` | `{ label:'IDLE', path:[] }` |
| game-decision | `fuzzy_logic` | `maxRules:8` | `{ value:0.5, rules:0 }` |
| game-decision | `markov_chain` | `maxSteps:16` | `{ state:params.cur ?? 'CLEAR', probs:{} }` |
| optimization | `genetic` | `maxPop:16`,`maxGen:8` | `{ best:null, gen:0, fitness:0 }` |
| optimization | `simulated_annealing` | `maxSteps:24` | `{ best:null, temp:0, steps:0 }` |
| optimization | `hill_climb` | `maxIter:32` | `{ best:null, improved:false }` |
| optimization | `tabu_search` | `maxIter:32`,`maxTabu:8` | `{ best:null, tabuSize:0 }` |
| geometry | `voronoi_grid` | `maxNodes:144` | `{ owner:{}, areas:{} }` |
| geometry | `quadtree` | `maxDepth:4`,`maxNodes:64` | `{ root:null, found:[] }` |
| geometry | `bresenham` | `maxSteps:12` | `{ cells:[] }` |
| geometry | `raycast` | `maxRays:8`,`maxRaySteps:12` | `{ hit:null, steps:0 }` |
| geometry | `value_noise` | 无循环 | `{ height:0 }` |
| classic-rules | `go_liberty` | 邻域 ≤4 | `{ liberties:4, captured:[] }` |
| classic-rules | `gomoku_pattern` | `maxLen:8` | `{ bestDir:[1,0], length:1, isFive:false }` |
| classic-rules | `xiangqi_moves` | `maxMoves:16` | `{ moves:[], caps:[] }` |
| classic-rules | `mc_build` | `maxCandidates:32` | `{ at:null, cost:0 }` |
| classic-rules | `tech_tree` | `maxNodes:16` | `{ unlocked:[], era:0 }` |
| systems | `priority_queue` | `maxItems:64` | `{ order:[] }` |
| systems | `bloom_filter` | `maxBits:128`,`maxHashes:3` | `{ maybe:false, bits:0 }` |
| systems | `pid` | 无循环 | `{ output:0, err:0 }` |
| systems | `queue_cooling` | `maxItems:64` | `{ ready:[], wait:0 }` |
| systems | `kalman` | 无循环 2×2 | `{ pred:[0,0], gain:0 }` |
| **emergent** | `lsystem` | `maxIter:8`,`maxCells:144` | `{ cells:[] }` |
| **emergent** | `falling_sand` | `maxCells:144`, 单次 1 步 | `{ moved:[], changed:[] }` |
| **emergent** | `elastic_collision` | 单次 1 对,`maxPairs:64` | `{ applied:false, j:0 }` |
| **emergent** | `food_chain` | `maxSpecies:8`,`maxIter:32` | `{ spawn:[], cull:[], delta:0 }` |

### 5.4 涌现识别器（`engine/world/emergent.js`）

> 涌现单位**不是硬编码怪物表**：引擎每 tick 在轮转区块上用内核判定图案，符合则生成实体并打 `type` 标签（GDD §5.1）。
> `EMERGENTS` 常量表（14 项）只描述**展示元数据**（名称 / 标记字 / 质量 / 颜色 / 图鉴文案），**不含行为脚本**；行为由内核在各自层里产生。

```js
const EMERGENTS = {
  E01: { name:'流萤', mark:'萤', color:'#7FE3FF', mass:0.5, maxSpeed:0.25, hp:10,  kernel:'conway' },
  E02: { name:'脉冲', mark:'脉', color:'#FFD54F', mass:Infinity, maxSpeed:0,  hp:20,  kernel:'conway' },
  E03: { name:'结晶', mark:'晶', color:'#7FE3FF', mass:8.0, maxSpeed:0,  hp:60,  kernel:'conway' },
  E04: { name:'羽群', mark:'羽', color:'#E8EAF0', mass:0.4, maxSpeed:0.5, hp:8,   kernel:'boids' },
  E05: { name:'蚁工', mark:'蚁', color:'#8D6E63', mass:0.2, maxSpeed:0.35,hp:5,   kernel:'aco' },
  E06: { name:'砂兽', mark:'砂', color:'#C8A165', mass:4.0, maxSpeed:0.2, hp:40,  kernel:'falling_sand' },
  E07: { name:'火灵', mark:'火', color:'#FF7043', mass:0.3, maxSpeed:0.4, hp:15,  kernel:'falling_sand' },
  E08: { name:'藤蔓', mark:'藤', color:'#66BB6A', mass:Infinity, maxSpeed:0, hp:25, kernel:'lsystem' },
  E09: { name:'守卫', mark:'卫', color:'#AB47BC', mass:3.0, maxSpeed:0.3, hp:80,  kernel:'xiangqi_moves' },
  E10: { name:'界碑', mark:'碑', color:'#5C6BC0', mass:Infinity, maxSpeed:0, hp:100, kernel:'voronoi_grid' },
  E11: { name:'噬晶兽', mark:'噬', color:'#EF5350',mass:2.5, maxSpeed:0.3,hp:70,  kernel:'genetic' },
  E12: { name:'矿脉', mark:'矿', color:'#B08D57', mass:Infinity, maxSpeed:0,hp:999, kernel:'gomoku_pattern' },
  E13: { name:'环噬', mark:'环', color:'#78909C', mass:Infinity, maxSpeed:0,hp:999, kernel:'go_liberty' },
  E14: { name:'衡者', mark:'衡', color:'#26C6DA', mass:1.5, maxSpeed:0.3,hp:50,  kernel:'food_chain' }
};
```

`/api/health` 的 `data.emergents = Object.keys(EMERGENTS).length`（必须 14）。

---

## 6. WebSocket 协议

### 6.1 连接

| 项 | 值 |
| --- | --- |
| 路径 | `ws://localhost:3000/ws`（与 HTTP 同端口） |
| 子协议 | 无 |
| 鉴权 | 连接建立后 **5 秒内**必须发送 `hello`（携带 JWT）；超时 → 服务端 `close(4001)` |
| 心跳 | 服务端每 20 tick（1s）下发 `heartbeat`（仅含 `tick`）；客户端据此判断连接存活，**不计算 RTT** |
| 帧大小 | 单帧 > 64KB → `close(4003)` |
| 指令限流 | 单连接 ≤ 30 条 `intent` / 秒；超出丢弃并回 `error`（`2005`） |
| 编码 | JSON；`{ t: <消息类型>, ... }`；**禁止携带客户端时间戳**（铁律 4） |

**关闭码**

| 码 | 含义 |
| --- | --- |
| `4001` | 未授权：5 秒内未 `hello` / 令牌无效 / 被登出 |
| `4002` | 房间不存在或已满（`1015` / `1014`） |
| `4003` | 协议错误：JSON 非法 / 消息类型未知 / 帧过大 |
| `4004` | 服务器关闭（优雅重启 / 世界被删除） |

**错误码（帧内 `error.code`）**

| code | 含义 |
| --- | --- |
| `2001` | INVALID_MESSAGE（字段缺失 / 类型错误） |
| `2002` | ROOM_FULL（房间已满） |
| `2003` | ROOM_NOT_FOUND（世界不存在） |
| `2004` | INTENT_REJECTED（指令非法：坐标越界 / 距离过远 / 资源不足 / 冷却中） |
| `2005` | RATE_LIMITED（指令超限） |
| `2006` | WORLD_SETTLED（世界已结算，不可操作） |
| `2007` | INTERNAL（未捕获异常，已降级） |

### 6.2 消息总表（**12 种**）

| 方向 | `t` | 频率 | 说明 |
| --- | --- | --- | --- |
| C→S | `hello` | 连接后 1 次 | 鉴权并加入房间 |
| C→S | `intent` | ≤30/s | 玩家指令（移动 / 采集 / 建造 / 攻击 / 丢弃） |
| C→S | `chat` | 低频 | 纯文本聊天（P1） |
| C→S | `resume` | 重连 1 次 | 断线重连（携带 `playerKey`） |
| C→S | `bye` | 离开 1 次 | 主动离开房间 |
| S→C | `welcome` | 加入后 1 次 | 房间信息 + 玩家 `playerKey` + 初始快照 |
| S→C | `snapshot` | 每 100 tick（5s）+ 加入时 | 全量世界快照 |
| S→C | `delta` | 每 2 tick（10Hz） | 增量：实体 / 地形 / 玩家状态变化 |
| S→C | `event` | 事件驱动 | 涌现事件（矿脉贯通 / 建筑被吞并 / 时代跃迁…） |
| S→C | `error` | 错误驱动 | 上述 2001–2007 |
| S→C | `heartbeat` | 每 20 tick（1s） | `{ t:'heartbeat', tick }` |
| S→C | `bye` | 离开 / 被踢 | 服务端确认离开 |

### 6.3 消息格式

**C→S `hello`**

```json
{ "t":"hello", "token":"eyJhbGciOi...", "worldKey":"w_17" }
```

**C→S `intent`**（一次可带多条动作，服务端按数组顺序 FIFO 处理）

```json
{ "t":"intent", "seq": 128,
  "acts": [ { "type":"move", "dir":[1,0] },
            { "type":"gather", "x":20, "y":30 },
            { "type":"build", "x":21, "y":30, "kind":"WALL" },
            { "type":"attack", "targetId": 91 },
            { "type":"drop", "item":"WOOD", "n": 5 } ] }
```

| `type` | 参数 | 服务端校验 |
| --- | --- | --- |
| `move` | `dir:[dx,dy]`，`dx,dy ∈ {-1,0,1}` | 归一化；累加冲量（同 tick 同向最多 `MERGE_MAX=4` 条） |
| `gather` | `x`,`y` | 切比雪夫距离 ≤ 1；目标可采集；冷却就绪；库存未满 |
| `build` | `x`,`y`,`kind ∈ {FLOOR,WALL,FARM,TOWER,WAREHOUSE}` | 距离 ≤ 2；地形可建造；资源足够；科技已解锁 |
| `attack` | `targetId` | 距离 ≤ `range`；目标存在且存活 |
| `drop` | `item`,`n ≥ 1` | 库存足够 |

> **禁止字段**：任何形如 `ts` / `timestamp` / `clientTime` / `ping` 的字段一律**忽略并丢弃该条指令**（不报错，避免被当作延迟探测通道）。

**C→S `resume`**

```json
{ "t":"resume", "token":"eyJhbGciOi...", "worldKey":"w_17", "playerKey":"p_9" }
```

窗口内（`RECONNECT_WINDOW_MS = 60000`）恢复同一 `playerId` 的全部状态；超窗口视为新加入（`4002` 或新建 `playerKey`）。

**S→C `welcome`**

```json
{ "t":"welcome", "roomKey":"rm_3", "worldKey":"w_17", "playerKey":"p_9",
  "tick": 25400, "day": 21, "era": 2, "weather":"RAIN", "season":"SUMMER", "phase":"DAY",
  "self": { "x":20.5, "y":30.2, "vx":0.1, "vy":-0.05, "hp":100, "hunger":72,
            "inventory":[{"item":"WOOD","n":24}], "techs":["tool_stone"], "era":1 },
  "players": [ { "playerKey":"p_8", "userId":3, "username":"bob", "x":18.0, "y":31.0 } ],
  "terrain": "<RLE 地形字符串>" }
```

**S→C `snapshot`**（每 100 tick / 加入时）

```json
{ "t":"snapshot", "tick":25400, "day":21, "era":2, "weather":"RAIN", "season":"SUMMER", "phase":"DAY",
  "terrain":"<RLE>", "blocks":[{"x":12,"y":30,"kind":"WALL","hp":200,"owner":3}],
  "entities":[{"id":91,"type":"E01","x":20.5,"y":30.2,"vx":0.25,"vy":-0.25,"hp":10}],
  "players":[{"playerKey":"p_9","x":20.5,"y":30.2,"hp":100,"hunger":72}],
  "events":[] }
```

**S→C `delta`**（每 2 tick）

```json
{ "t":"delta", "tick":25402,
  "e":[ {"id":91,"x":21.0,"y":29.8,"vx":0.25,"vy":-0.2,"hp":10},
        {"id":92,"dead":true} ],
  "p":[ {"k":"p_9","x":20.7,"y":30.1,"hp":100,"hu":72} ],
  "ter":[[31,32,2]],
  "blk":[{"x":12,"y":30,"kind":"WALL","hp":180}] }
```

| 字段 | 含义 |
| --- | --- |
| `e` | 变化的实体（位置为 3 位小数；`dead:true` 表示移除） |
| `p` | 变化的玩家（`k`=playerKey，`hu`=hunger） |
| `ter` | 变化的地形格 `[x, y, terrainValue]` |
| `blk` | 变化的建筑 |

**S→C `event`**

```json
{ "t":"event", "tick":25410, "kind":"oreBreakthrough",
  "at":[40,22], "text":"矿脉贯通！产出 ×5", "by":"p_9" }
```

`kind` 唯一集合（12 个）：`oreBreakthrough`、`buildingSwallowed`、`eraUp`、`dayPassed`、`weatherChange`、`seasonChange`、`gliderSpawn`、`crystalForm`、`fireSpread`、`sandBury`、`resistEvolved`、`playerDeath`。

**S→C `error` / `heartbeat` / `bye`**

```json
{ "t":"error", "code":2004, "message":"距离过远，无法建造" }
{ "t":"heartbeat", "tick":25420 }
{ "t":"bye", "reason":"left" }
```

### 6.4 指令顺序与「延迟 = 惯性」的服务端实现

```js
// server/engine/world/intents.js
const queues = new Map();            // playerKey -> Array<intent>
function enqueue(playerKey, act) {   // 到达即入队，顺序 = 到达顺序
  const q = queues.get(playerKey) ?? [];
  if (q.length >= 64) return;        // 硬上限，防刷
  q.push(act); queues.set(playerKey, q);
}
function consume(world) {            // 每 tick 调用一次
  for (const p of world.players) {
    const q = queues.get(p.key) ?? [];
    let jx = 0, jy = 0, moveCount = 0;
    while (q.length) {
      const a = q.shift();
      if (a.type === 'move') {
        if (moveCount < MERGE_MAX) { jx += a.dir[0]; jy += a.dir[1]; moveCount++; }
      } else applyInstant(world, p, a);        // 采集 / 建造 / 攻击 / 丢弃：立即结算
    }
    if (moveCount) {
      const len = Math.hypot(jx, jy) || 1;
      p.pendingImpulse[0] += (jx / len) * IMPULSE_MOVE * moveCount;
      p.pendingImpulse[1] += (jy / len) * IMPULSE_MOVE * moveCount;
    }
  }
}
```

> **注意**：`moveCount` 上限 `MERGE_MAX = 4` 即「一次 tick 最多吃 4 条同向指令」——慢网玩家积压后一次吃到 4 倍冲量，天然表现为更大动量与更长刹车距离。**实现中不得出现任何与时间差相关的计算**。

### 6.5 房间生命周期

| 事件 | 处理 |
| --- | --- |
| 首个 `hello` | 载入世界（DB 或新建）→ 创建 `rooms` 行 → 启动 20 TPS 定时器 → 回 `welcome` + `snapshot` |
| 后续 `hello` | `playerCount < 8` 则加入；否则 `close(4002)` + `error/2002` |
| `bye` / 断开 | 标记离线；`playerKey` 保留 60s（重连窗口）；实体的刚体保留（可被撞飞） |
| 全员离线 | tick 降频至 `IDLE_TPS = 2`；超过 5 分钟 → 落盘并卸载房间，删除 `rooms` 行 |
| 世界结算 `settle` | 广播 `bye`（`reason:'settled'`）→ 落盘 → 关闭房间 |

---

## 7. 数据模型

### 7.1 ER 描述

```
users 1 ──< worlds（owner）
users 1 ──< world_players >── worlds
worlds 1 ── 0..1 rooms（一个世界同时最多一个房间）
users 1 ── 1 saves
users 1 ──< scores >── 0..1 worlds
meta（schema_version）
```

### 7.2 完整建表 SQL（`server/src/schema.sql`）

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL,
  username_lower TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  token_version  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_last_login ON users(last_login_at);

CREATE TABLE IF NOT EXISTS worlds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  world_key   TEXT    NOT NULL UNIQUE,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  seed        INTEGER NOT NULL,
  visibility  TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  status      TEXT    NOT NULL DEFAULT 'active'  CHECK (status IN ('active','settled','archived')),
  tick        INTEGER NOT NULL DEFAULT 0,
  day         INTEGER NOT NULL DEFAULT 1,
  era         INTEGER NOT NULL DEFAULT 0,
  state       TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  settled_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_worlds_owner    ON worlds(owner_id, status);
CREATE INDEX IF NOT EXISTS ix_worlds_public   ON worlds(visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS world_players (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id     INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  player_key   TEXT    NOT NULL UNIQUE,
  state        TEXT    NOT NULL DEFAULT '{}',
  joined_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  online       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_world_players_one  ON world_players(world_id, user_id);
CREATE INDEX        IF NOT EXISTS ix_world_players_user ON world_players(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  room_key       TEXT    NOT NULL UNIQUE,
  world_id       INTEGER NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
  host_user_id   INTEGER NOT NULL REFERENCES users(id),
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  tick           INTEGER NOT NULL DEFAULT 0,
  player_count   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_rooms_status ON rooms(status, last_active_at DESC);

CREATE TABLE IF NOT EXISTS saves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 4,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_id   INTEGER REFERENCES worlds(id) ON DELETE SET NULL,
  score      INTEGER NOT NULL,
  days       INTEGER NOT NULL DEFAULT 0,
  era        INTEGER NOT NULL DEFAULT 0,
  buildings  INTEGER NOT NULL DEFAULT 0,
  kills      INTEGER NOT NULL DEFAULT 0,
  techs      INTEGER NOT NULL DEFAULT 0,
  resources  INTEGER NOT NULL DEFAULT 0,
  alive      INTEGER NOT NULL DEFAULT 0,
  played_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_scores_user  ON scores(user_id, score DESC);
CREATE INDEX IF NOT EXISTS ix_scores_board ON scores(score DESC, played_at ASC, user_id ASC);
CREATE INDEX IF NOT EXISTS ix_scores_time  ON scores(played_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '4');
```

### 7.3 关键查询（仅 `?` 位置参数）

```sql
-- 总榜（每用户最高分去重，同分取最早）
SELECT u.id AS userId, u.username, MAX(s.score) AS score, MIN(s.played_at) AS achievedAt
FROM scores s JOIN users u ON u.id = s.user_id
GROUP BY u.id, u.username
ORDER BY score DESC, achievedAt ASC, userId ASC
LIMIT ? OFFSET ?;

-- 周榜（UTC+8 自然周，周一 00:00 起）
-- 同上，增加：WHERE date(s.played_at, '+8 hours') >= date('now', '+8 hours', 'weekday 1', '-7 days')

-- 我的排名
SELECT COUNT(*) + 1 FROM (
  SELECT user_id, MAX(score) AS best FROM scores GROUP BY user_id
) t WHERE t.best > ?;

-- 我的战绩
SELECT id, score, days, era, buildings, kills, techs, resources, alive, played_at
FROM scores WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?;

-- 公开世界列表（含在线人数）
SELECT w.world_key, w.name, w.seed, w.day, w.era, w.updated_at,
       u.username AS owner, COALESCE(r.player_count, 0) AS players
FROM worlds w JOIN users u ON u.id = w.owner_id
LEFT JOIN rooms r ON r.world_id = w.id AND r.status = 'open'
WHERE w.visibility = 'public' AND w.status = 'active'
ORDER BY w.updated_at DESC LIMIT ? OFFSET ?;

-- 世界详情
SELECT w.*, COALESCE(r.player_count, 0) AS players
FROM worlds w LEFT JOIN rooms r ON r.world_id = w.id AND r.status = 'open'
WHERE w.world_key = ?;

-- 本用户的世界内状态
SELECT * FROM world_players WHERE world_id = ? AND user_id = ?;
```

---

## 8. REST API 契约

### 8.1 通用约定

| 项 | 约定 |
| --- | --- |
| 基地址 | `http://localhost:3000` |
| 前缀 | `/api` |
| Content-Type | `application/json; charset=utf-8` |
| 成功 | `{ "code": 0, "message": "ok", "data": <object\|array\|null> }` |
| 失败 | `{ "code": <非0>, "message": "<中文>", "data": null \| { "fields": [...] } }` |
| 鉴权头 | `Authorization: Bearer <token>` |
| 时间字段 | ISO-8601 UTC，小驼峰（`playedAt`、`createdAt`、`updatedAt`） |
| HTTP 状态码 | 201 用于创建成功（注册、创建世界）；其余成功 200 |

### 8.2 错误码表（**完整，实现必须一致**）

| code | HTTP | 常量名 | message | 场景 |
| --- | --- | --- | --- | --- |
| `0` | 200/201 | OK | `ok` | 成功 |
| `1000` | 400 | VALIDATION_ERROR | `参数校验失败` | 字段缺失 / 类型错误 / 范围越界 |
| `1001` | 401 | INVALID_CREDENTIALS | `用户名或密码错误` | 登录失败（含用户不存在） |
| `1002` | 401 | TOKEN_MISSING | `缺少访问令牌` | 无头或格式非 `Bearer <token>` |
| `1003` | 401 | TOKEN_INVALID | `访问令牌无效` | 签名错 / 载荷非法 |
| `1004` | 401 | TOKEN_EXPIRED | `访问令牌已过期` | `exp` 已过 |
| `1005` | 401 | TOKEN_REVOKED | `登录状态已失效，请重新登录` | `token_version` 不匹配 |
| `1006` | 409 | USERNAME_TAKEN | `用户名已被占用` | 重名（大小写不敏感） |
| `1007` | 404 | NOT_FOUND | `接口不存在` | 未匹配路由 |
| `1008` | 401 | USER_NOT_FOUND | `用户不存在` | 令牌 `uid` 不存在 |
| `1009` | 429 | RATE_LIMITED | `请求过于频繁，请稍后再试` | 限流 |
| `1010` | 413 | PAYLOAD_TOO_LARGE | `请求体过大` | body>1mb / 存档>32KB |
| `1011` | 400 | INVALID_JSON | `请求体不是合法的 JSON` | JSON 解析失败 |
| `1012` | 415 | UNSUPPORTED_MEDIA_TYPE | `Content-Type 必须为 application/json` | 非 JSON 写操作 |
| `1013` | 400 | WORLD_LIMIT_REACHED | `世界数量已达上限` | 每用户最多 3 个活跃世界 |
| `1014` | 404 | WORLD_NOT_FOUND | `世界不存在` | worldKey 不存在 |
| `1015` | 409 | ROOM_FULL | `房间人数已满` | 房间 8 人满 |
| `1016` | 404 | ROOM_NOT_FOUND | `房间不存在` | 世界无开放房间 |
| `1017` | 400 | SAVE_VERSION_MISMATCH | `存档版本不匹配` | `data.version !== 4` |
| `1018` | 400 | INVALID_TILE | `目标格不可建造` | 坐标越界 / 地形不可建造 / 已占用 |
| `1019` | 400 | INVENTORY_FULL | `库存已满` | 库存格不足 |
| `1020` | 400 | TECH_LOCKED | `前置科技未解锁` | 科技依赖未满足 |
| `1021` | 400 | NOT_ENOUGH_RESOURCE | `资源不足` | 建造 / 研究资源不够 |
| `1022` | 409 | ALREADY_IN_ROOM | `已在房间中` | 重复加入 |
| `1023` | 400 | INVALID_SEED | `种子不合法` | seed 非 0~2^32-1 整数 |
| `1024` | 403 | NOT_WORLD_OWNER | `不是该世界的所有者` | 删除 / 修改他人世界 |
| `1025` | 409 | WORLD_SETTLED | `世界已结算` | 已结算世界再操作 |
| `5000` | 500 | INTERNAL_ERROR | `服务器内部错误` | 未捕获异常 |

### 8.3 接口清单（共 **16 个**）

| # | 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/health` | 否 | 健康检查（含内核 / 涌现计数） |
| 2 | POST | `/api/auth/register` | 否 | 注册 |
| 3 | POST | `/api/auth/login` | 否 | 登录 |
| 4 | POST | `/api/auth/logout` | 是 | 登出 |
| 5 | GET | `/api/auth/me` | 是 | 当前用户 |
| 6 | POST | `/api/worlds` | 是 | 创建世界（指定或随机 seed） |
| 7 | GET | `/api/worlds` | 否 | 公开世界列表（含在线人数） |
| 8 | GET | `/api/worlds/:worldKey` | 否 | 世界详情 |
| 9 | DELETE | `/api/worlds/:worldKey` | 是 | 删除自己的世界 |
| 10 | GET | `/api/worlds/:worldKey/snapshot` | 否 | 世界静态快照（地形 + 建筑，离线查看） |
| 11 | POST | `/api/worlds/:worldKey/settle` | 是 | 结束一局并计分 |
| 12 | GET | `/api/saves` | 是 | 读存档 |
| 13 | PUT | `/api/saves` | 是 | 写存档（整包覆盖） |
| 14 | DELETE | `/api/saves` | 是 | 删存档 |
| 15 | GET | `/api/scores/leaderboard` | 否 | 排行榜（总榜 / 周榜） |
| 16 | GET | `/api/scores/mine` | 是 | 我的战绩 |

> **不存在「提交分数」接口**：`POST /api/scores` 返回 404 / 1007（防作弊核心）。

### 8.4 接口详情

#### ① `GET /api/health`

```json
{ "code":0, "message":"ok",
  "data": { "status":"ok", "uptime":12.34, "dbDriver":"better-sqlite3",
            "version":"4.0.0", "kernels":46, "emergents":14,
            "rooms":2, "tps":20 } }
```

#### ② `POST /api/auth/register`

- 限流：同 IP 每小时 ≤ 10 次；请求 `{ "username", "password" }`

| 字段 | 规则 |
| --- | --- |
| `username` | `^[A-Za-z][A-Za-z0-9_]{2,19}$` |
| `password` | 8–64 字符；必须同时含字母与数字；不在 12 个黑名单中 |

黑名单：`password`、`12345678`、`123456789`、`1234567890`、`qwerty123`、`abc12345`、`iloveyou`、`admin123`、`welcome1`、`password1`、`11111111`、`00000000`

成功 `201`：

```json
{ "code":0, "message":"ok",
  "data": { "user": { "id":1, "username":"alice", "createdAt":"2026-09-08T02:00:00.000Z" },
            "token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", "expiresIn":604800 } }
```

失败：`409/1006`、`400/1000`。

#### ③ `POST /api/auth/login`

- 限流：同 IP + 用户名每 5 分钟 ≤ 10 次；用户名大小写不敏感
- 用户不存在与密码错误返回**完全相同**的 `401/1001`；成功 `200`，结构同注册

#### ④ `POST /api/auth/logout`

- 无请求体；`UPDATE users SET token_version = token_version + 1 WHERE id = ?`
- 成功 `200`：`{ "code":0,"message":"ok","data":{ "loggedOut":true } }`

#### ⑤ `GET /api/auth/me`

```json
{ "code":0, "message":"ok",
  "data": { "id":1, "username":"alice", "createdAt":"...", "lastLoginAt":"...",
            "bestScore":2450, "rank":3, "totalWorlds":3, "totalDays":48 } }
```

无成绩时 `bestScore = 0`、`rank = null`。

#### ⑥ `POST /api/worlds`

- 请求：`{ "name": string(1-24), "seed"?: int, "visibility"?: "private"|"public" }`
- `seed` 缺省时 `crypto.randomBytes(4).readUInt32BE(0)`；非法 → `400/1023`
- 该用户活跃世界 ≥ 3 → `400/1013`

成功 `201`：

```json
{ "code":0, "message":"ok",
  "data": { "worldKey":"w_17", "name":"我的荒野", "seed":3712938451,
            "visibility":"private", "status":"active", "tick":0, "day":1, "era":0,
            "wsUrl":"ws://localhost:3000/ws", "createdAt":"..." } }
```

#### ⑦ `GET /api/worlds`

- Query：`scope`（`public`|`mine`，默认 `public`）、`limit`（默认 20，1–100）、`offset`（默认 0，0–10000）
- `scope=mine` 需鉴权

```json
{ "code":0, "message":"ok",
  "data": { "scope":"public", "total":12, "limit":20, "offset":0,
    "entries":[ { "worldKey":"w_17", "name":"我的荒野", "seed":3712938451,
                  "day":21, "era":2, "players":2, "owner":"alice",
                  "updatedAt":"2026-09-08T02:40:00.000Z" } ] } }
```

#### ⑧ `GET /api/worlds/:worldKey`

```json
{ "code":0, "message":"ok",
  "data": { "worldKey":"w_17", "name":"我的荒野", "seed":3712938451,
            "status":"active", "tick":25400, "day":21, "era":2,
            "visibility":"public", "players":2, "maxPlayers":8,
            "owner":"alice", "updatedAt":"..." } }
```

不存在 → `404/1014`。

#### ⑨ `DELETE /api/worlds/:worldKey`

- 仅所有者；非所有者 `403/1024`；成功 `200`：`{ "code":0,"message":"ok","data":{ "deleted":true } }`
- 会关闭房间（广播 `bye`，`reason:'deleted'`）并级联删除 `world_players` / `rooms`

#### ⑩ `GET /api/worlds/:worldKey/snapshot`

```json
{ "code":0, "message":"ok",
  "data": { "worldKey":"w_17", "seed":3712938451, "tick":25400, "day":21, "era":2,
            "weather":"RAIN", "season":"SUMMER", "phase":"DAY",
            "terrain":"<RLE 字符串>",
            "blocks":[ { "x":12,"y":30,"kind":"WALL","hp":200,"owner":3 } ],
            "entityCount":87 } }
```

#### ⑪ `POST /api/worlds/:worldKey/settle`

- 请求体 `{}`；非所有者可结算**自己参与过的世界**；已结算 → `409/1025`
- 服务端按 GDD §7 计算分数 → 写 `scores` → 更新 `saves` 统计 → `worlds.status='settled'`

```json
{ "code":0, "message":"ok",
  "data": { "scoreId":88, "score":2450,
    "breakdown": { "days":12, "era":2, "buildings":18, "kills":63,
                   "techs":9, "resources":8600, "alive":true },
    "rank":3, "isNewBest":true, "playedAt":"2026-09-08T02:40:00.000Z" } }
```

#### ⑫ `GET /api/saves`

无存档：`{ "code":0,"message":"ok","data":{ "data":null, "version":null, "updatedAt":null } }`

有存档：

```json
{ "code":0, "message":"ok",
  "data": { "data": { "version":4, "bestScore":2450, "totalWorlds":5, "totalDays":48,
                      "totalKills":210, "totalBuildings":60, "totalResources":8600,
                      "bestEra":2, "bestDay":12,
                      "unlockedEmergents":["E01","E03","E05"],
                      "settings":{ "theme":"dark","showGrid":true,"camScale":1 },
                      "lastPlayedAt":null },
            "version":4, "updatedAt":"2026-09-08T02:40:00.000Z" } }
```

#### ⑬ `PUT /api/saves`

- 请求 `{ "data": { ... } }`；`data.version` 必须等于 **4**，否则 `400/1017`（`fields[0].field = "data.version"`）
- 整包覆盖（不做大小比较）；JSON 长度 > 32768 → `413/1010`
- 成功 `200`：`{ "code":0,"message":"ok","data":{ "updatedAt":"..." } }`

#### ⑭ `DELETE /api/saves`

成功 `200`：`{ "code":0,"message":"ok","data":{ "deleted":true } }`

#### ⑮ `GET /api/scores/leaderboard`

- 鉴权：**否**（已登录附 `me`；令牌非法**不影响**榜单返回）
- Query：`scope`（`all`|`weekly`，默认 `all`）、`limit`（默认 20，1–100）、`offset`（默认 0，0–10000）；越界 → `400/1000`

```json
{ "code":0, "message":"ok",
  "data": { "scope":"all", "total":37, "limit":20, "offset":0,
    "entries":[ { "rank":1, "userId":3, "username":"bob", "score":3120,
                  "days":15, "era":3, "buildings":40, "kills":88,
                  "playedAt":"2026-09-08T01:00:00.000Z" } ],
    "me": { "rank":3, "score":2450 } } }
```

#### ⑯ `GET /api/scores/mine`

- Query：`limit`（默认 20，1–100）、`offset`（默认 0，0–10000）；排序 `played_at DESC, id DESC`

```json
{ "code":0, "message":"ok",
  "data": { "total":2, "limit":20, "offset":0,
    "entries":[ { "id":88, "score":2450, "days":12, "era":2, "buildings":18,
                  "kills":63, "techs":9, "resources":8600, "alive":true,
                  "playedAt":"2026-09-08T02:40:00.000Z" } ] } }
```

---

## 9. 前端模块设计

| 模块 | 职责 |
| --- | --- |
| `config.js` | 常量（GDD §10）、地形色、涌现标记字、API/WS 地址 |
| `api.js` | REST 封装；统一解 `{code,message,data}`；401 → 清凭据回登录 |
| `net.js` | WS：连接 → `hello` → 收 `welcome/snapshot/delta/event`；**发 intent（20Hz 采样摇杆）**；断线指数退避重连 + `resume` |
| `auth.js` | 注册 / 登录 / 登出；令牌存 `sessionStorage` |
| `render.js` | Canvas 2D：地形（视口裁剪，24×24 格）→ 建筑 → 实体 → 速度矢量 → 夜晚遮罩；**零图片** |
| `input.js` | 键盘 WASD / 方向键；移动端虚拟摇杆 + 动作按钮（≥56px）；采样 20Hz 生成 `move` intent |
| `hud.js` | 血 / 饥饿 / 温度 / 天数 / 时代 / 库存快捷栏 / 建造菜单 / 科技树 / 事件流 |
| `build.js` | 建造选择、放置预览、消耗校验（本地只读提示，最终以服务端 `delta` 为准） |
| `tech.js` | 科技树渲染与解锁请求（走 `intent` 的 `build` 之外的 `study`，经 REST？→ **统一走 WS `intent` 扩展 `type:'study'`**） |

> **补充说明**：为保持消息类型数量不变，`study`（研究科技）并入 `intent.acts` 的 `type` 枚举（`move`/`gather`/`build`/`attack`/`drop`/`study`），**不影响 WS 消息类型计数（仍为 12 种）**。

| 视图 | 说明 |
| --- | --- |
| `#auth` | 注册 / 登录 |
| `#lobby` | 世界列表 + 创建世界 |
| `#game` | 画布 + HUD + 建造 / 科技面板 |
| `#leaderboard` | 总榜 / 周榜 |
| `#figures` | 内核图鉴 + 涌现图鉴（P1） |

**渲染插值**：客户端对实体位置做视觉插值（`lerp`），**仅影响显示，不影响任何判定**；速度矢量线用于让「惯性 / 重球」可见。

---

## 10. 安全设计

| 威胁 | 措施 |
| --- | --- |
| 弱密码 | 8–64 字符，含字母与数字；12 个黑名单 |
| 密码存储 | bcryptjs cost = 10；**任何响应不得返回 `password_hash`** |
| 暴力破解 | 登录 10 次 / 5 分钟 / IP+用户名；注册 10 次 / 小时 / IP；超出 429 |
| 令牌 | JWT HS256，7 天；登出 `token_version` 递增；签名错 / 过期 / 被登出分别返回 1003 / 1004 / 1005 |
| **WS 鉴权** | 5 秒内必须 `hello`，否则 `close(4001)`；未鉴权前的任何帧丢弃 |
| **指令限流** | ≤ 30 条 `intent` / 秒 / 连接；队列硬上限 64 条 |
| **禁止延迟探测** | 消息中禁止 `ts`/`timestamp`/`ping` 字段；**服务端不计算 RTT、不广播 tick 时间戳给客户端做延迟推断之外用途**（`heartbeat.tick` 仅用于存活判断） |
| 刷分 | **不存在任何「提交分数」接口**；分数由服务端从世界状态计算 |
| 作弊 | 世界全在服务端；客户端只能发 `intent.acts`；服务端二次校验坐标 / 距离 / 资源 / 冷却 / 科技 |
| XSS | 用户可控文本一律 `textContent`；CSP；用户名规则阻断 `<script>` |
| SQL 注入 | 全部预编译 `?` 位置参数 |
| 请求体 | `express.json({ limit:'1mb' })`，超出 413；WS 帧 > 64KB → `close(4003)` |
| CORS | 同源部署；`NODE_ENV=production` 下仅允许 `ORIGIN` 白名单 |
| 安全头 | `helmet` 风格手写：`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`CSP: default-src 'self'` |

---

## 11. 部署与运行说明

### 11.1 命令

```bash
cd D:\workspace\Game
npm install
npm start              # node server/src/index.js
npm run dev            # nodemon server/src/index.js
npm run test:kernels   # node tests/kernels.test.mjs   （46 个内核）
npm run test:world     # node tests/world.test.mjs     （世界模拟 + 涌现）
npm run test:net       # node tests/net.test.mjs       （WS 协议 + 冲量 + 碰撞）
```

`package.json`：

```json
{
  "name": "emergent-lands",
  "version": "4.0.0",
  "private": true,
  "main": "server/src/index.js",
  "scripts": {
    "start": "node server/src/index.js",
    "dev": "nodemon server/src/index.js",
    "test:kernels": "node tests/kernels.test.mjs",
    "test:world": "node tests/world.test.mjs",
    "test:net": "node tests/net.test.mjs"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ws": "^8.18.0",
    "better-sqlite3": "^11.3.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2"
  }
}
```

> 若 `better-sqlite3` 安装失败并降级到 `node:sqlite`，从 `dependencies` 移除它以保证 `npm install` 可完成，并在 README 与启动日志标注 `db driver: node:sqlite`。

### 11.2 环境变量（`.env.example`）

```bash
PORT=3000
JWT_SECRET=please-change-this-to-a-long-random-string
JWT_EXPIRES_IN=604800
DB_PATH=./server/data/game.db
NODE_ENV=production
TRUST_PROXY=1
TICK_RATE=20
TICK_BUDGET_MS=50
IDLE_TPS=2
MAX_PLAYERS_PER_ROOM=8
RECONNECT_WINDOW_MS=60000
MAX_WS_FRAME_BYTES=65536
PERSIST_TICKS=100
```

### 11.3 端口与路径

| 项 | 值 |
| --- | --- |
| 监听端口 / 地址 | 3000 / `0.0.0.0` |
| REST | `http://localhost:3000/api` |
| WebSocket | `ws://localhost:3000/ws` |
| 数据库 | `server/data/game.db`（WAL 另生成 `-wal`/`-shm`） |
| 引擎 | `server/engine/`（含 `algorithms/` 46 内核、`world/`） |
| 静态目录 | `public/` |
| `.gitignore` | `node_modules/`、`server/data/`、`.env` |

### 11.4 启动日志

```
[2026-09-08T02:00:00.000Z] INFO  db driver: better-sqlite3
[2026-09-08T02:00:00.000Z] INFO  db path: D:\workspace\Game\server\data\game.db
[2026-09-08T02:00:00.000Z] INFO  schema applied, version=4
[2026-09-08T02:00:00.000Z] INFO  kernels loaded: 46 (graph-search:10, swarm:6, game-decision:7, optimization:4, geometry:5, classic-rules:5, systems:5, emergent:4)
[2026-09-08T02:00:00.000Z] INFO  emergents loaded: 14 (E01..E14)
[2026-09-08T02:00:00.000Z] INFO  http+ws listening on http://0.0.0.0:3000 (env=development)
```

### 11.5 优雅关闭

监听 `SIGINT`/`SIGTERM` → 关闭所有房间（对 WS 发 `bye`/`close(4004)`）→ 全量落盘 → `server.close()` → 关闭 DB → `process.exit(0)`。

### 11.6 生产部署要点（P1）

- Nginx / Caddy 反代 `127.0.0.1:3000`，强制 HTTPS，**并转发 WebSocket（`Upgrade` / `Connection` 头）**
- `pm2 start server/src/index.js --name emergent-lands`
- 备份：`sqlite3 game.db ".backup game.bak.db"` 或 WAL 下复制三个文件

---

## 12. 实现顺序建议（给 Agent2）

1. `package.json` + `npm install`（先验证 `better-sqlite3`，装不上立即改 `node:sqlite`）
2. `server/src/config.js` → `server/db/` → `schema.sql` → `errors.js` → `logger.js`
3. `server/src/utils/`（password / token / validate / time / json）
4. **`server/engine/constants.js` + `rng.js` + `grid.js` + `kernel.js`**
5. **`server/engine/algorithms/`（46 个内核）→ `npm run test:kernels` 全绿**（按 PRD §5.4 五批顺序）
6. **`server/engine/world/`（generate → world → layers → emergent → physics → intents → weather → needs → build → tech → simulate → persist）→ `npm run test:world` 全绿**
7. `server/src/repositories/` → `services/` → `middleware/` + `routes/` + `index.js`
8. **`server/net/`（protocol → wsServer → hub → broadcast）→ `npm run test:net` 全绿**
9. **跑通 TESTPLAN §8 的 curl + WS 回归清单**
10. `public/`（config → api → net → auth → render → input → hud → build → tech → save → leaderboard → main）
11. 自检：四份文档的字段名、路径、端口、内核名、WS 消息类型、错误码逐项核对
