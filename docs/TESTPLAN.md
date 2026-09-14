# 测试计划 · 涌现之地 Emergent Lands · v4.0

> **文档状态**: v4.0 (与 SDD/GDD/PRD 一致)  
> **项目代号**: algowild  
> **对应规范**: `docs/SDD.md` §5 / `docs/GDD.md` §2 / `docs/PRD.md` AC-001~AC-020  
> **测试策略**: L0 静态合规 → L1 算法内核契约 → L2 涌现识别 → L3 世界模拟流水线 → L5 联机与延迟物理 → L7 端到端

---

## 0. 范围与铁律

测试必须验证四项不可妥协的铁律：

| 编号 | 铁律 | 对应测试层 |
|------|------|------------|
| IR-1 | 主体为单机生存建造；多机为可选实时房间 | L7 E2E 单/多房间 |
| IR-2 | 算法是世界运行法则；涌现单位从算法自然涌现 | L1 + L2 |
| IR-3 | 不检测/不补偿延迟；延迟通过"冲量合并"成为玩法 | L5 |
| IR-4 | 节点内置 SQLite 兜底；不强制 better-sqlite3 | L0 + L6 |

不通过即视为缺陷，禁止绕过。

---

## 1. 测试分层

```
L0 静态合规           <1s    启动即过
L1 算法内核契约       <5s    node tests/kernels.test.mjs
L2 涌现识别器       <2s    内嵌于 kernels 测试
L3 世界模拟流水线   <10s   node tests/engine.test.mjs
L4 REST + Auth        <5s   node tests/api.test.mjs
L5 联机延迟物理       <5s   node tests/multiplayer.test.mjs
L6 适配层(DB 兜底)    <3s   内嵌
L7 端到端             <15s  bash tests/smoke.sh
```

**总计 ~45s**。所有用例在 CI 与本机一致运行，零外部依赖。

---

## 2. L0 静态合规（每次启动即过）

| 用例 | 输入 | 期望 |
|------|------|------|
| TC-L0-01 | 扫描 `server/kernels/*.js` | 每个文件导出 `__meta={id,branch,hardLimits,fallback}` 且 `id` 全局唯一 |
| TC-L0-02 | 读取所有 kernel 源码 | `function` 体函数行 ≤ 15（不含注释/空行/导出） |
| TC-L0-03 | 解析每个 kernel 签名 | 形参只允许 `(ctx, rng, params)`；不允许 `require`/`fs`/`process` |
| TC-L0-04 | 扫描 `server/intents.js` | 存在 `MERGE_MAX=4`、`IMPULSE_MOVE` 常量 |
| TC-L0-05 | 扫描 `server/emergent.js` | 存在 `EMERGENTS` 表，条目数 = 14 |
| TC-L0-06 | 读取 `server/db/index.js` | 同时 `try` 加载 better-sqlite3 和 node:sqlite；任一成功即返回可用 db |
| TC-L0-07 | `package.json` 解析 | 必须 `"type":"module"`；依赖必须包含 express/ws/bcryptjs/jsonwebtoken |
| TC-L0-08 | 解析 `docs/SDD.md` 中 46 个 kernel id | 每个 id 在 `server/kernels/` 中都能找到对应文件 |

---

## 3. L1 算法内核契约（46 用例）

### 3.1 通用约定（每个 kernel 都跑）

```
TC-K-XX-01 给定 ctx={world, entities, tick} 与确定性 rng → 输出 entities 数组（增量）
TC-K-XX-02 给定 ctx=null → 不抛异常；按 fallback 降级（无副作用 no-op）
TC-K-XX-03 给定硬上限触发条件 → 在 hardLimits 触发时停止（不 OOM、不死循环）
TC-K-XX-04 给定极大 params（如 path 长度=10000）→ 在递归/循环上限内返回
TC-K-XX-05 同 seed 输入两次 → 输出按位等价（确定性）
TC-K-XX-06 单次调用耗时 < 5ms（中位 < 1ms）
```

### 3.2 八大分支用例矩阵

| 分支 | 用例 | 覆盖内核 |
|------|------|----------|
| A 图搜索 (10) | TC-KA-01~10 | astar, dijkstra, bfs, dfs, best_first, idastar, mst_prim, topo_sort, bidirectional, jump_point |
| B 群智 (6) | TC-KB-01~6 | boids, ant_colony, pso, cellular_automaton, swarm_merge, flock_split |
| C 博弈决策 (7) | TC-KC-01~7 | minimax, alphabeta, mcts, expectimax, negamax, monte_carlo_eval, opening_book |
| D 数值优化 (4) | TC-KD-01~4 | hill_climb, simulated_anneal, gradient_descent, nelder_mead |
| E 几何 (5) | TC-KE-01~5 | voronoi, delaunay, convex_hull, raycast_2d, line_of_sight |
| F 经典规则 (5) | TC-KF-01~5 | conway_life, rule_30, rule_90, rule_184, langtons_ant |
| G 系统论 (5) | TC-KG-01~7 | markov_chain, fuzzy_logic, l_system, signal_slot, event_bus |
| H 涌现 (4) | TC-KH-01~4 | reaction_diffusion, slime_mold, predator_prey, sand_pile |

> 详细断言见 SDD §5.3 表逐行展开（每个 kernel 一条独立用例）。  
> 每个用例除通用 6 条外，**追加**该算法领域的特定断言（如 astar 必须返回最短、boids 必须向平均速度对齐、conway_life 必须符合经典 B3/S23）。

### 3.3 收敛性 / 一致性

| 用例 | 输入 | 期望 |
|------|------|------|
| TC-K-CONV-01 | 同一 seed × 100 次 | 输出按位等价（位级一致性） |
| TC-K-CONV-02 | 同 seed × 1000 次在 50ms tick 预算内 | 全部完成，无一超时 |

---

## 4. L2 涌现识别器（14 单位 × 5 用例 = 70 用例）

每个单位 5 条：识别 / 行为 / 交互 / 边界 / 稳定性。

| 单位 | 识别信号 (emergent pattern) | 测试用例 |
|------|----------------------------|----------|
| 流萤 firefly | cellular_automaton 出现闪烁岛 | TC-E-FF-01~05 |
| 脉冲 pulse | 规则 30/90 边界传播 | TC-E-PL-01~05 |
| 结晶 crystal | reaction_diffusion 稳态斑 | TC-E-CR-01~05 |
| 羽群 feather | boids flocking | TC-E-FT-01~05 |
| 蚁工 ant | ant_colony pheromone | TC-E-AT-01~05 |
| 砂兽 sandbeast | sand_pile 雪崩 | TC-E-SB-01~05 |
| 火灵 fire | rule_184 交通流碰撞 | TC-E-FR-01~05 |
| 藤蔓 vine | l_system 分形 | TC-E-VN-01~05 |
| 守卫 guardian | mst_prim 围栏 | TC-E-GD-01~05 |
| 界碑 keystone | delaunay 三角剖分 | TC-E-KS-01~05 |
| 噬晶兽 crystalite | reaction_diffusion 吞噬 | TC-E-CT-01~05 |
| 矿脉 vein | voronoi 分块 | TC-E-VE-01~05 |
| 环噬 ring | predator_prey 极限环 | TC-E-RG-01~05 |
| 衡者 equalizer | fuzzy_logic 平衡点 | TC-E-EQ-01~05 |

通用 5 条断言（每个单位）：

```
01 给定触发场景 → recognizer 标记该单位
02 该单位在世界中按 EMERGENTS 表参数（mass/speed/hp）行为
03 玩家攻击/破坏 → 触发 EMERGENTS 表中的交互效果
04 边界（同单位同 chunk 数 > 上限） → recognizer 不再产生新单位
05 强制结束世界 → 单位数归零，无泄漏
```

---

## 5. L3 世界模拟流水线（30 用例）

### 5.1 流水线分阶段

`tick(state, intents) → { state', events }` 的 9 个相位（SDD §4.2）：

| 相位 | 函数 | 用例 |
|------|------|------|
| P1 | chunk 加载/淘汰 | TC-T-01~03 |
| P2 | 玩家意图合并 | TC-T-04~07（冲量合并） |
| P3 | 内核调度 | TC-T-08~10（46 kernels 全部跑过） |
| P4 | 涌现识别 | TC-T-11~13 |
| P5 | 物理积分 | TC-T-14~16 |
| P6 | 持久化节流 | TC-T-17~18 |
| P7 | 事件聚合 | TC-T-19~20 |
| P8 | 网络广播 | TC-T-21~22 |
| P9 | 节流/快照 | TC-T-23~24 |

### 5.2 关键场景

| 用例 | 场景 | 期望 |
|------|------|------|
| TC-T-S01 | 新建世界 → 1000 tick 内 | 不少于 10 个涌现单位自然出现 |
| TC-T-S02 | 单玩家连续 10000 tick | 不死循环、不堆内存（堆增长 < 20%） |
| TC-T-S03 | 玩家长按移动（连续 1000 tick）→ 速度应平滑（无突变） | |
| TC-T-S04 | 8 玩家满房间 1000 tick | tick 平均 < 16ms（保证 60fps 上行余量） |
| TC-T-S05 | 玩家死亡 → 重生 → 世界继续 | 不重置世界状态 |
| TC-T-S06 | 服务器重启 → 加载最新 save | 状态位等价 |
| TC-T-S07 | tick 预算超 50ms → 跳过当帧 | 不累积，不 OOM |

---

## 6. L4 REST + Auth（16 用例）

### 6.1 鉴权

| 用例 | 路径 | 期望 |
|------|------|------|
| TC-A-01 | POST /api/auth/register {u,p,e} | 200 + token；重复名 409 |
| TC-A-02 | POST /api/auth/register {弱口令} | 400 |
| TC-A-03 | POST /api/auth/login | 200 + token；错误密码 401 |
| TC-A-04 | GET /api/me (无 token) | 401 |
| TC-A-05 | GET /api/me (合法 token) | 200 + 用户档案 |
| TC-A-06 | POST /api/auth/logout | 200；token 失效 |

### 6.2 世界 / 存档 / 分数 / 房间

| 用例 | 路径 | 期望 |
|------|------|------|
| TC-A-07 | POST /api/worlds {name,seed} | 200 + worldId |
| TC-A-08 | GET /api/worlds/:id | 200 + 完整状态摘要（不返回全量 entity） |
| TC-A-09 | POST /api/worlds/:id/save | 200；存档 ID 返回 |
| TC-A-10 | GET /api/worlds/:id/saves | 列表（最近 10 条） |
| TC-A-11 | POST /api/scores {worldId,score} | 200 + bestScore |
| TC-A-12 | GET /api/scores/me | 历史前 10 |
| TC-A-13 | POST /api/rooms {worldId} | 200 + roomCode |
| TC-A-14 | POST /api/rooms/:code/join | 200 + room 快照 |
| TC-A-15 | GET /api/rooms/:code | 当前玩家列表 |
| TC-A-16 | DELETE /api/rooms/:code | 仅房主可关闭 |

---

## 7. L5 联机与延迟物理（12 用例，**核心**）

### 7.1 延迟=惯性 物理正确性

| 用例 | 场景 | 期望 |
|------|------|------|
| TC-MP-01 | 模拟 4 玩家在线，强制人为延迟：P1=20ms / P2=200ms / P3=400ms / P4=800ms | 服务器**不检测**延迟；仅按到达时间 FIFO 处理 intents |
| TC-MP-02 | 同上 60 秒 | P4（800ms）累计的移动指令被合并为 MERGE_MAX=4 的冲量；位移/速度统计：**慢网玩家平均速度反而更高（合并冲量更大）**——符合"延迟=惯性" |
| TC-MP-03 | P2 突然断网 5 秒后回归 | 不触发任何"重连"或"补偿"逻辑；缺失 tick 的指令直接丢弃；玩家位置由已有冲量继续推进 |
| TC-MP-04 | 故意发送 timestamp=now-10000（伪造） | 服务器**忽略**客户端时间戳，仅按到达时间 |
| TC-MP-05 | 检查 WS close code | 401=鉴权失败 / 4001=被踢 / 4002=满员 / 4003=心跳超时 / 4004=房间关闭 |
| TC-MP-06 | 不同延迟玩家位置碰撞 | 视为不同质量/速度的球自然碰撞，按冲量守恒结算 |
| TC-MP-07 | 8 玩家满员 | 第 9 人 join 返回 4002 |
| TC-MP-08 | 玩家发送非法指令（如 move=NaN） | 错误码 2002，无效指令丢弃 |
| TC-MP-09 | 指令频率异常（每 1ms 一帧） | 服务端按 20TPS 合并；不累加冲量到失控 |
| TC-MP-10 | 心跳 30s 缺失 | 主动关闭 4003 |
| TC-MP-11 | 玩家 200ms 不发心跳但有 intent | 视为活跃；不主动断 |
| TC-MP-12 | 两玩家同时打同一格资源 | 先到者获胜（确定性）；双方客户端最终一致 |

### 7.2 同步是涌现的，不是强制的

```
重要约束：测试中禁止断言"两端位置 bit-equal"。
允许存在由延迟自然产生的位置差；只要：
  (a) 差值在下次广播内被收敛（< 500ms）
  (b) 不引发死循环或位置发散
即视为通过。
```

---

## 8. L6 适配层（DB 兜底）

| 用例 | 场景 | 期望 |
|------|------|------|
| TC-DB-01 | 仅安装 better-sqlite3 | `db.type === 'better'` |
| TC-DB-02 | 卸载 better-sqlite3（rename 模拟） | 自动回退到 `db.type === 'node:sqlite'` |
| TC-DB-03 | 两条路径下建表 + insert + select | 结果一致 |
| TC-DB-04 | 并发 100 次 insert | 不抛错，无锁死 |

---

## 9. L7 端到端（烟雾测试）

`tests/smoke.sh`（或 `smoke.mjs`）—— 由 CI 执行：

```bash
set -e
# 1. 启动服务
PORT=17001 node server/index.js & SRV=$!
sleep 2

# 2. 注册 + 登录
TOKEN=$(curl -s :17001/api/auth/register -d '{"u":"smoke","p":"smoke123","e":"s@x"}' | jq -r .data.token)

# 3. 建世界 + 取摘要
WID=$(curl -s -H "Authorization: Bearer $TOKEN" :17001/api/worlds -d '{"name":"smoke","seed":1}' | jq -r .data.worldId)
curl -s -H "Authorization: Bearer $TOKEN" :17001/api/worlds/$WID | jq .data.summary

# 4. WS 连接 + 心跳 + 模拟玩家输入 5 秒
node tests/ws_smoke.mjs $TOKEN $WID

# 5. 检查至少一个涌现单位被识别
curl -s -H "Authorization: Bearer $TOKEN" :17001/api/worlds/$WID | jq '.data.emergentTotal | tonumber >= 1'

# 6. 关停
kill $SRV
```

| 烟雾用例 | 断言 |
|----------|------|
| TC-S-01 | 服务能起、能停（无未捕获异常） |
| TC-S-02 | 注册→登录→建世界→进房→移动→离开 全链路 200 |
| TC-S-03 | 60 秒内涌现单位 ≥ 1 |
| TC-S-04 | 4 玩家模拟（人为延迟 20/200/400/800ms）能跑通；最终无 OOM |
| TC-S-05 | 静态文件 `GET /` 返回 SPA HTML（200） |

---

## 10. 用例统计

| 层 | 用例数 | 通过准则 |
|----|--------|----------|
| L0 | 8 | 全部通过 |
| L1 | 46×6 + 100 + 4 ≈ **380** | 全部通过；任一超时/不一致即失败 |
| L2 | 14×5 = **70** | 全部通过 |
| L3 | 24 + 7 = **31** | 全部通过 |
| L4 | **16** | 全部通过 |
| L5 | **12** | 全部通过（含延迟物理正确性） |
| L6 | **4** | 全部通过 |
| L7 | **5** | 全部通过 |
| **合计** | **~528 用例** | **100% 通过即视为 v4.0 可发版** |

---

## 11. 测试脚本组织

```
D:\workspace\Game\
├─ tests/
│   ├─ kernels.test.mjs   (L0 + L1 + L2)
│   ├─ engine.test.mjs    (L3)
│   ├─ api.test.mjs       (L4)
│   ├─ multiplayer.test.mjs (L5)
│   ├─ ws_smoke.mjs       (L7 辅助)
│   └─ smoke.sh           (L7 总入口)
└─ server/
    ├─ kernels/           (46 个 .js)
    ├─ db/                (better-sqlite3 + node:sqlite 适配)
    ├─ engine.js          (tick pipeline)
    ├─ emergent.js        (recognizer + 14 units)
    ├─ intents.js         (冲量合并)
    ├─ net.js             (WS 12 types + 冲量物理)
    ├─ auth.js
    ├─ routes.js          (16 REST)
    └─ index.js
```

---

## 12. 缺陷分级与处理

| 级别 | 触发条件 | 处理时限 |
|------|----------|----------|
| P0 | 任何用例失败 / 启动崩溃 / 数据丢失 | **立即修复**，阻塞发布 |
| P1 | 用例断言不严格但能跑通（如缺日志） | 当日内修复 |
| P2 | 性能、UI 细节 | 记录，下版本 |

---

**测试负责人**: Agent1 (文档与测试侧)  
**被测对象**: Agent2 实现的 `server/` 与 `public/`  
**完成判据**: L0~L7 100% 通过 + 烟雾测试连续 3 次稳定 + 延迟物理 TC-MP-02 数值与"延迟=惯性"假设一致

— END v4.0 —