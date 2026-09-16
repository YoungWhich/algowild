# 模式开发指南（MODES.md）—— 像拼图一样增加游戏模式

> 目标：**新增模式（五子棋 / 跳棋 / 象棋 …）不需要改动主干**，且各模式**互不影响**。
> 前置阅读：[`AGENTS.md`](../AGENTS.md)（铁律 + 主干冻结）、[`CONTRIBUTING.md`](../CONTRIBUTING.md)。

---

## 1. 架构总览

```
                         ┌─────────────────────── 注册表（唯一扩展点）───────────────────────┐
  主干（冻结）            │  server/modes/index.js                public/modes/index.js        │
  engine.js  ──getMode──▶│    rts.js  go.js  …                    MODES = { rts, go, … }        │
  net.js     ──_mode────▶│                                       client.js  VIEWS = { go:{…} } │
  index.js   ──_mode────▶│                                                                     │
  routes/rooms ─normalize│                                                                     │
                         └─────────────────────────────────────────────────────────────────────┘
```

- **主干**（`engine.js` / `net.js` / `index.js` / `routes.js` / `rooms.js` / `public/client.js`）只通过
  **注册表**读取模式能力，**不写** `mode === '<某模式>'` 分支。
- **模式插件**是自包含的：后端 `server/modes/<id>.js` + 前端 `public/modes/<id>.js`。
- **接缝（seam）只有三处**：两个注册表文件 + `index.html` 的模式下拉。其余主干零改动。

主干里允许出现的"模式相关"代码 **只有**以下几种形态：

| 位置 | 形态 | 含义 |
| --- | --- | --- |
| `engine.js` 构造器 | `this._mode = getMode(this.mode)` | 注入模式插件 |
| `engine.js` | `getMode(mode)` / `boardMaxForMode(mode)` | 读元数据 |
| `engine.js` / `net.js` / `index.js` | `w._mode.tickDriver` / `w._mode.routeIntent` / `w._mode.snapshot()` / `w._mode.tick()` | 调插件钩子 |
| `net.js` INTENT | `w._mode.routeIntent(...)` | 意图路由 |
| `rooms.js` / `routes.js` | `normalizeMode(...)` | 用户输入 → 已注册 id |
| `public/client.js` | `VIEWS[currentModeId()]` | 渲染/HUD 分派 |

---

## 2. 后端契约：`ModePlugin`

`server/modes/<id>.js` 的 **default 导出**必须符合：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | ✅ | 唯一 id，如 `'gomoku'` |
| `label` | `string` | ✅ | 人类可读名（房间列表/下拉用） |
| `tickDriver` | `'realtime' \| 'interval'` | ✅ | 主干如何驱动（见 §3） |
| `boardMax` | `number` | ✅ | 可编辑棋盘尺寸上限（rts 32 / go 100） |
| `growLifeLayer` | `boolean` | ⬜ | 生命层是否随棋盘尺寸扩容（go=true，默认 false） |
| `availableVictoryLines` | `string[]` | ✅ | 本模式可用胜利线（`territory/economy/singularity/survival` 的子集） |
| `install(World)` | `fn` | ⬜ | 把本模式方法挂到 `World.prototype`（mixin，方法名建议 `_<id>`* 前缀） |
| `tick(engine, events)` | `fn` | ⬜ | 一次模拟步进（`interval` 模式由 1 Hz 循环调用；`realtime` 留空 = 走主干 9 阶段 tick） |
| `intervalStep(engine, events)` | `fn` | ⬜ | `interval` 循环的"一步"（含 AI）；主干 1 Hz 循环**优先**调用它，缺省回退 `tick`。返回 `{ events?, changed? }`，`changed === false` 时主干跳过本次广播 |
| `onAddPlayer(engine, p)` | `fn` | ⬜ | 玩家加入时的模式初始化（空盘/就座/跳过 rts 出生点） |
| `onAddAI(engine, ai)` | `fn` | ⬜ | 电脑加入时的模式初始化 |
| `routeIntent(engine, pid, intent, events)` | `fn` | ⬜ | 处理 WS 意图，返回 `{ handled, silent?, result?, rejectPoints? }` |
| `snapshot(engine)` | `fn` | ⬜ | 注入本模式专属快照切片（rts 留空 → `snapshot().go = null`） |

`routeIntent` 返回值语义（主干据此行事）：

- `{ handled: false }` → 主干继续走 rts 入队路径（**rts 插件不实现该钩子即可**）。
- `{ handled: true, silent: true }` → 已消费但**不广播**（如 go 世界收到非 go 意图）。
- `{ handled: true, result: { ok, reason } }` → 主干：`!ok && reason` 时回 `bad_intent` 错误，然后广播快照 + 事件。
- 被拒落点由**插件自己**压入 `events`（如 `go_reject`），主干只负责广播。

---

## 3. 两种驱动方式（tickDriver）

主干有两个循环，按 `tickDriver` 自动分配（`server/index.js` + `server/net.js`）：

| `tickDriver` | 循环 | 谁被驱动 | 例子 |
| --- | --- | --- | --- |
| `'realtime'` | 20 TPS（`TICK_MS`） | `w._mode.tickDriver === 'realtime'` 的世界 | rts |
| `'interval'` | 1 Hz（`intervalMs`） | `w._mode.tickDriver === 'interval'` 的世界 | go（围棋）、棋盘类回合制 |

- `realtime` 模式**不要**实现 `tick`（主干走内置 9 阶段 tick）。
- `interval` 模式**必须**实现 `tick(engine, events)`（1 Hz 由主干调用）。可为 0 表示"仅计时推进"。
- `interval` 模式**可选**实现 `intervalStep(engine, events)`：主干 1 Hz 循环**优先**调用它
  （`const step = w._mode.intervalStep || w._mode.tick;`），用于把"AI 出手 + 推进计时"等一步逻辑内聚到插件。
  返回 `{ events?, changed? }`；`changed === false` 时主干跳过本次 `broadcast`。go 即用它保证
  "AI 刚出手的这一秒不推进计时"。**主干按注册表驱动，不硬编码任何模式专属方法。**
- 两种循环都受 `w.paused` 门控：**世界默认 `paused=true`**（`POST /rooms/:code/world` 设定），
  `POST /rooms/:code/start` 解冻。"未开始不可动"由该机制统一保证，插件无需额外拦截。

> 若你的模式是"纯手动推进/无计时"（如象棋无回合计时），仍用 `interval` + `tick` 返回空即可；
> 主干会以 1 Hz 广播一次快照，保证两端看到 `msLeft`。

---

## 4. 前端契约

### 4.1 `public/modes/index.js` — 模式表

在 `MODES` 里加一条：

```js
gomoku: { id: 'gomoku', label: '五子棋', kind: 'gomoku', tickDriver: 'interval', boardMax: 15 },
```

`kind` 供 client.js 的 `VIEWS` 分派使用。`isGo()` / `boardMaxForMode()` / `normalizeMode()` 会自动认得它。

### 4.2 `public/client.js` — 视图分派表 `VIEWS`

在 `VIEWS` 里登记该模式的渲染 / HUD 入口：

```js
const VIEWS = {
  go: { render: renderGo, hud: renderGoHud },
  gomoku: { render: renderGomoku, hud: renderGomokuHud },   // ← 新增一行
};
```

主干 `render()` / `renderHud()` 通过 `VIEWS[currentModeId()]` 分派，**不会**再写 `if (isGo())`。
你的 `renderGomoku` / `renderGomokuHud` 建议放进 `public/modes/gomoku.js`，在 client.js 顶部 `import` 进来。

### 4.3 `public/index.html` — 模式下拉

在 `#world-mode` 下拉里加一个 `<option>`：

```html
<select id="world-mode" …>
  <option value="rts">实时模式</option>
  <option value="go">回合制模式</option>
  <option value="gomoku">五子棋</option>   <!-- ← 新增 -->
</select>
```

---

## 5. 实操：新增「五子棋」模式（完整步骤）

> 下面是一个**最小可跑**的骨架（15×15、五连、轮流落子、`interval` 驱动）。
> 真实实现请把规则补齐（禁手可选、胜负判定、AI 等）。**每一步都不碰主干逻辑。**

### Step 1 — `server/modes/gomoku.js`

```js
import { registerMode } from './index.js';

const gobgm = {                      // 挂到 World 上的方法族（命名空间前缀避免撞名）
  _gomokuInit() {
    this.gomoku = { board: new Int8Array(15 * 15), turn: 0, result: null, moveNo: 0, seats: [] };
  },
  _gomokuSeat(p) {
    if (!this.gomoku) this._gomokuInit();
    if (!this.gomoku.seats.includes(p.id)) this.gomoku.seats.push(p.id);
  },
  _gomokuTick() {
    // 1 Hz 步进：此处仅推进计时/托管；真正的落子由 routeIntent 直接应用。
    this.tick++;
    return { events: [], tickMs: 0 };
  },
  applyGomokuIntent(playerId, data /* {lx,ly} | {pass:true} */) {
    if (this.paused) return { ok: false, reason: 'paused' };
    const g = this.gomoku;
    if (!g || g.result) return { ok: false, reason: 'ended' };
    // TODO: 落子校验（越界/占位）→ 写入 g.board → 判五连
    return { ok: true };
  },
  _gomokuSnapshot() {
    const g = this.gomoku || { board: new Int8Array(225), turn: 0, result: null, moveNo: 0, seats: [] };
    return { board: Array.from(g.board), turn: g.turn, seats: g.seats, result: g.result, moveNo: g.moveNo };
  },
};

const def = {
  id: 'gomoku',
  label: '五子棋',
  tickDriver: 'interval',
  intervalMs: 1000,
  boardMax: 15,
  growLifeLayer: false,
  availableVictoryLines: ['territory'],
  install(World) {
    World.prototype._gomokuInit = gobgm._gomokuInit;
    World.prototype._gomokuSeat = gobgm._gomokuSeat;
    World.prototype._gomokuTick = gobgm._gomokuTick;
    World.prototype.applyGomokuIntent = gobgm.applyGomokuIntent;
    World.prototype._gomokuSnapshot = gobgm._gomokuSnapshot;
  },
  tick(engine) { return engine._gomokuTick(); },
  onAddPlayer(engine, p) { engine._gomokuSeat(p); if (engine.hostId == null) engine.hostId = p.id; },
  onAddAI(engine, ai) { engine._gomokuSeat(ai); },
  routeIntent(engine, pid, intent, events) {
    if (intent && intent.gomoku && typeof intent.gomoku === 'object') {
      let r;
      try { r = engine.applyGomokuIntent(pid, intent.gomoku); }
      catch (e) { return { handled: true, result: { ok: false, reason: 'gomoku_intent_failed' } }; }
      return { handled: true, result: r };
    }
    return { handled: true, silent: true };   // 非本模式的意图：不广播、不入 rts 队列
  },
  snapshot(engine) { return engine._gomokuSnapshot(); },
};

registerMode(def);
export default def;
```

### Step 2 — 注册（唯一一行 wiring）

`server/modes/index.js` 末尾追加：

```js
import './rts.js';
import './go.js';
import './gomoku.js';   // ← 新增
```

### Step 3 — 前端（可选，想要图形界面时）

- 新建 `public/modes/gomoku.js`：导出 `renderGomoku(ctx, state)` / `renderGomokuHud()`（可参考 `client.js` 里
  `renderGo` 的棋盘绘制：`goViewTransform` + 网格 + 棋子）。
- `public/client.js`：顶部 `import` 进来，并在 `VIEWS` 加 `gomoku: { render: renderGomoku, hud: renderGomokuHud }`。
- `public/modes/index.js` 的 `MODES` 加一条；`public/index.html` 的 `#world-mode` 加一个 `<option>`。

> 目前棋盘类模式的输入（点击落子/预选/提交）复用 `client.js` 的 go 输入骨架；若五子棋交互与 go 足够接近，
> 可让 `gomoku` 复用 `goScreenToCell` 等纯函数。**注意**：`client.js` 的 `mousedown`/`keydown` 仍有 `isGo()` 判断——
> 后续可把输入也做成 `VIEWS` 式表分派（见 §8 待办）。

### Step 4 — 测试

在 `tests/` 新增 `gomoku.test.mjs`，并加入 `package.json` 的 `test` 脚本。至少覆盖：
落子校验、胜负判定、`routeIntent` 的 `handled/silent/result` 语义、`snapshot().gomoku` 形态、确定性（无随机）。

---

## 5.5 脚手架：一键新增模式（分形模板）

不必手抄：仓库内置**模板 + 脚手架**，一条命令即可生成整套骨架并接线。

**模板（惰性，永不被加载）**
- `server/modes/_template.js` —— 完整的 `ModePlugin` 契约骨架（每个钩子带中文注释与最小示例，且**不自注册**）。
- `public/modes/_template.js` —— 前端模式视图骨架（`createXxxView(env) → { render, hud, input.onMouseDown }` 工厂）。

> 注册表只用**显式** `import './<id>.js';` 加载插件；文件名以 `_` 开头者无人 import，故模板永远 inert。

**用法**
```bash
node scripts/new-mode.mjs <id> <Label> [boardMax] [boardDefault]
# 例：
node scripts/new-mode.mjs checkers 跳棋 8 8
```

脚本会（幂等、**拒绝覆盖已存在文件**）：
1. 由模板生成 `server/modes/<id>.js`（替换 id/label/尺寸，**并自注册**）与 `public/modes/<id>.js`；
2. `server/modes/index.js` 末尾追加 `import './<id>.js';`；
3. `public/modes/index.js` 的 `MODES` 追加一条（含 `boardMax` / `boardDefault`）；
4. `public/index.html` 的 `#world-mode` 追加 `<option value="<id>"><Label></option>`；
5. 生成 `tests/<id>.test.mjs` 骨架，并把该文件追加进 `package.json` 的 `test` 脚本；
6. 用 `node --check`（.js）与 `JSON.parse`（package.json）校验所有改动，失败即报错中止；
7. 打印**剩余手工步骤**。

**剩余手工步骤**（脚本亦会打印）：在 `public/client.js` 的 `VIEWS` 登记 `{ render, hud, input }`；
按实际规则实现 `server/modes/<id>.js`（模板骨架默认"恒落甲色"）；完善 `tests/<id>.test.mjs`。

**目录树（新增一个模式后）**
```
server/modes/
  index.js        ← 注册表（显式 import；唯一 wiring 行）
  _template.js    ← 后端骨架（inert）
  rts.js  go.js  gomoku.js  weiqi.js  <id>.js
public/modes/
  index.js        ← 前端 MODES 表（boardMax / boardDefault）
  _template.js    ← 前端骨架（inert）
  gomoku.js  weiqi.js  <id>.js
scripts/
  new-mode.mjs    ← 脚手架
tests/
  <id>.test.mjs   ← 骨架
```

---

## 6. 胜利线 / 棋盘上限 / 地图编辑器

- **胜利线**：`availableVictoryLines` 决定本模式可开哪些线（`World.normVictoryLines` 会强制关闭其余）。
  棋盘类通常只留 `territory`。`routes.js` / `rooms.js` 都通过注册表归一，无需改。
- **棋盘上限 / 默认**：`boardMax` 决定 `World.normBoard` 的钳制上限与前端 `BoardEditor` 的上限；
  前端注册表的 `boardDefault`（`boardDefaultForMode(id)`）决定编辑器的默认尺寸（rts 32 / go 32 / gomoku 15 / weiqi 19）。
- **地图编辑器对**所有**模式生效**：`#board-build` 面板不按模式隐藏，`onModeChange` 会重建编辑器；
  **模式无关**——`BoardEditor` 只接收 `mode` 并调用 `boardMaxForMode` / `boardDefaultForMode`，
  编辑逻辑（画/挖/擦/填/预设/旋转/重置）**不区分模式**。**新增模式请勿在编辑器里加模式分支**。
- **棋盘类模式如何"尊重编辑器"**：自带棋盘容器时，尺寸取 `engine.board` 的 `max(cfg.w, cfg.h)`（无则默认尺寸），
  并用 `engine._isWall(lx, ly)` 复用"形状外/虚空/越界 = 墙"的统一语义（墙 → 拒绝落子，不计气、不计地）。
  见 `server/modes/gomoku.js` / `weiqi.js` 的 `_<id>Init`。
- `board=null`（默认矩形）时所有边界判定**逐字节等价于改造前的矩形**（不回归底线）。

---

## 7. 隔离保证（新增模式不会影响 rts / go 的清单）

- 主干里**没有** `<某模式>` 字符串分支 → 加模式不改主干控制流。
- 注册表按 `id` 分派；未注册 id → 归一为 `rts`，不会污染其它模式。
- 每个模式的 `install` 只挂自己 `_<id>*` 前缀的方法，命名空间隔离。
- `tickDriver` 决定驱动循环；`realtime` 与 `interval` 世界互不驱动。
- `paused` / `started` 是通用的，无需各模式自行实现。
- **地图编辑器、房间/席位模型、WS 枢纽、鉴权、管理后台** 全部模式无关，天然不受影响。

---

## 8. 已知待办（后续可继续收敛）

- 前端**输入**：`mousedown` 已改为 `VIEWS[<id>].input.onMouseDown` 表驱动（新棋盘模式零改主干，见 `client.js`）；
  go 的**预选 / 结束回合**键位（`keydown` 里的 `isGo()`）仍为 go 专属，后续可迁移进 `public/modes/go.js`。
- 前端**模式解析**已统一走注册表归一（`_modeNormalize` / `boardMaxForMode` / `boardDefaultForMode` / `getMode().label`）；
  不再有 `value === 'go' ? 'go' : 'rts'` 之类硬编码（见 `tests/mode_wiring.test.mjs`）。
- `public/modes/<id>.js` 尚未真正承载各模式的渲染函数（`renderGo*` 现仍在 `client.js`）；建议逐步把 `renderGo*`
  迁入 `public/modes/go.js`，让每个模式成为完整"拼图块"。
- `#world-mode` 下拉是硬编码 `<option>`（脚手架会追加）；可改为由 `listModes()` 动态生成。

---

## 9. 提交自检（新模式的"完成定义"）

- [ ] `server/modes/<id>.js` 符合 §2 契约，并在 `server/modes/index.js` 注册（可用 `scripts/new-mode.mjs` 一键生成）。
- [ ] 主干（`engine/net/index/routes/rooms`）**没有**新增该模式的分支。
- [ ] 前端 `MODES`（含 `boardMax`/`boardDefault`）/ `VIEWS` / `#world-mode` 三处已登记（需要 UI 时）。
- [ ] 棋盘类模式尊重地图编辑器：尺寸取自 `engine.board`，边界判定走 `engine._isWall`（`board=null` 时逐字节不变）。
- [ ] `tests/<id>.test.mjs` 已加，且权威套件（`package.json` 的 `test` 脚本）**505+ 全绿**。
- [ ] 无 `Math.random` / `Date.now`（IR-3a）。
- [ ] 地图编辑器保持模式无关。
