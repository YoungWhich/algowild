# AGENTS.md — 给 AI 编码助手的项目约定（algowild / 涌现之地）

> 本文件是**权威约束**。任何 AI（Claude / Cursor / Codex / Copilot / WorkBuddy 等）在改动本仓库前
> **必须先读本文件**，并遵守其中的"铁律"与"主干冻结"规则。
> 类似约定参考业界通行做法：`AGENTS.md`（OpenAI Codex）、`CLAUDE.md`（Anthropic）、`.cursorrules`（Cursor）。
> 人类贡献者请同时阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)；新增模式请看 [`docs/MODES.md`](./docs/MODES.md)。

---

## 0. 项目是什么

- 单机生存建造 + 可选实时联机（Node.js ESM + express + ws）。
- **两种模式**：`rts`（实时，20 TPS）+ `go`（回合制演化棋，1 Hz）。
- 46 个算法内核（8 分支）+ 14 种涌现单位（生态命名）。
- 20 TPS tick；192×192 世界（32×32 生命棋盘 + 8×8 区域，`REGION_SIZE=24`）；最多 8 席位/房。

## 1. 铁律（IR —— 不可妥协，违反即回归缺陷）

1. **IR-1 算法是世界法则，单位是涌现**：绝不用算法名命名单位。
2. **IR-2 延迟 = 惯性**：服务器只按到达时间 FIFO 处理 intent，**不检测、不补偿**延迟；客户端不模拟。
3. **IR-3a 确定性**：模拟路径内**禁止 `Math.random` / `Date.now`**，一律用种子 rng `mulberry32`。
   - 由 grep 守卫测试保障（`go.js` / `ai.js` / `engine.js` 棋盘生成区）。
   - 新增模拟代码前，先确认不引入这两者。
4. **IR-3b 离散 tick**：模拟按固定 tick 步进，禁止在 tick 外推进世界状态。
5. **IR-3c 算法不可读档**：存档不还原算法内部状态。

## 2. 主干冻结（TRUNK FROZEN）—— 最重要的一条

> **主干一旦就绪即冻结。新增模式 / 新功能，一律通过"注册表 + 插件"扩展，不得改动主干。**

**主干 = 以下文件的核心逻辑**（改这些文件需要极高理由与全量回归）：

| 文件 | 职责 |
| --- | --- |
| `server/engine.js` | `World` 类：9 阶段 tick、生命棋盘、快照、席位 |
| `server/net.js` | WS 枢纽：意图路由、广播、tick 归属 |
| `server/index.js` | 后台 tick 循环（20 TPS 实时 / 1 Hz interval）、调度器 |
| `server/rooms.js` | 房间/席位模型、设置归一 |
| `server/routes.js` | 16 个 REST 端点 |
| `public/client.js` | 渲染 / 输入 / HUD 分派 |
| `public/index.html` | 页面骨架与脚本入口 |

**禁止事项（AI 最常犯）：**

- ❌ 在主干里写 `if (mode === 'go')` / `mode === 'rts'` / `if (this.mode === ...)` 这类**硬编码模式分支**。
  - 主干**只能**通过模式注册表读取模式能力：`server/modes/index.js` 的 `getMode / boardMaxForMode / normalizeMode` 等，
    或读取实例上的 `world._mode`（由构造器统一注入）。
- ❌ 为某个模式在主干里加 `!world.started` / `!world.paused` 之类**特殊拦截**。世界的"未开始/暂停"统一由
  `world.paused` 机制处理（`POST /rooms/:code/world` 默认 `paused=true`，`POST /:code/start` 解冻）。
- ❌ 修改 `public/` 的静态资源路径 / 脚本入口类型（`client.js` 是 `<script type="module">`，可用 `import`）。
- ❌ 给某个模式 `install` 到主干原型上"顺手"改别的东西（mixin 只挂自己 `_<id>*` 前缀的方法）。

**主干"开口"清单（唯一允许被模式触碰的接缝）：**见第 3 节。

## 3. 模式插件契约（MODE PLUGIN CONTRACT）

新增一个模式（五子棋 / 跳棋 / 象棋 …）= **加文件，不改主干**。完整契约见 [`docs/MODES.md`](./docs/MODES.md)。

- **后端**：`server/modes/<id>.js` — default 导出符合契约的对象，并在模块顶层 `registerMode(def)`；
  再在 `server/modes/index.js` 底部加一行 `import './<id>.js';`（**唯一**需要碰的"wiring"行）。
- **前端**：`public/modes/<id>.js`（该模式的渲染/输入/HUD 入口）+ 在 `public/modes/index.js` 的 `MODES` 表加一条。
- **脚手架（推荐）**：新模式骨架见 `server/modes/_template.js` / `public/modes/_template.js`（惰性模板，永不被加载），
  可 `node scripts/new-mode.mjs <id> <Label> [boardMax] [boardDefault]` 一键生成后端/前端/注册表/下拉/测试并接线。

契约字段（后端）：`id / label / tickDriver('realtime'|'interval') / boardMax / growLifeLayer? /
availableVictoryLines / install? / tick? / intervalStep? / onAddPlayer? / onAddAI? / routeIntent? / snapshot?`
（`interval` 世界的 1 Hz 循环按注册表驱动：`const step = w._mode.intervalStep || w._mode.tick;`，主干不硬编码任何模式专属方法）。

**地图编辑器是模式无关的**：`BoardEditor` 只接收 `mode` 参数决定尺寸上限，**不得**在编辑器里写模式专属逻辑。

## 4. 测试与验证（改完必跑）

```bash
node --test --expose-gc tests/...        # 单/多文件（本机 npm 的 shell shim 可能损坏，直接用 node）
npm test                                  # 权威套件（435 项）—— 必须全绿才算不回归
```

- **权威测试集 = `package.json` 的 `test` 脚本所列文件**（435 项）。改动后**必须** `npm test` 全绿。
- 另有非权威/遗留测试文件（`ai_pursuit` / `algo_gameplay` / `life_board` 等）**不在** `npm test`，
  其中若干编码的是**已废弃行为**（如"AI 自动补位"—— 现已改为**仅手动添加 AI**），红灯属已知历史，勿据此改主干。
- QA 探针：`scripts/qa_*_probe.mjs`（gameplay 83 / go 73 / admin 61 / ban_guard 32 / lobby 28）。
  探针需要起服务时再跑，不在 `npm test` 内。
- 确定性守卫（IR-3a）会扫描 `go.js` / `ai.js` 源码，**别在模拟文件里写 `Math.random` / `Date.now`**。

## 5. 部署注意（平台会劫持 Authorization 头）

- 鉴权**多源读取、优先级反转**：`?token=` → `body.token` → `x-auth-token` → 最后才 `Authorization`。
- WS 用 `hello` 消息体带 token。客户端多通道发送。
- 发布用 `workbuddy_sites_deploy`；沙箱会回收，以 deploy 返回的 `shareLink` 为准。

## 6. 改动自检清单（提交前逐条确认）

- [ ] 主干里**没有**新增 `mode === '<某模式>'` 分支（应走注册表 / `world._mode`）。
- [ ] 新增模式只动了 `server/modes/`、`public/modes/` 与两个注册表文件。
- [ ] 没在模拟路径引入 `Math.random` / `Date.now`（IR-3a）。
- [ ] `npm test` **435/435 全绿**。
- [ ] 地图编辑器仍**模式无关**（只用 `boardMaxForMode` 决定上限）。
- [ ] 若改了 `public/*.js|html`，已提升 `index.html` 里 `client.js` 的 `?v=` 缓存破坏号。

## 7. 已知限制（别把"历史遗留"当 bug 修）

- AI **只手动添加**，不自动补位（`_maybeAddAI` 是**有意的空实现**，勿"修复"为自动补位）。
- 管理后台无 rate limit / 软删除；`onlineUserIds` 只统计已进世界用户。
- 本机 `npm run` 的 shell shim 可能损坏（`dirname`/`cat`/`head`/`tail` 缺失）：直接用
  `node --test --expose-gc <files>` 并重定向到日志文件再读取。
