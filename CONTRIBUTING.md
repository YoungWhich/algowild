# 贡献指南 · algowild / 涌现之地

> AI 助手请先读 [`AGENTS.md`](./AGENTS.md)（含"铁律"与"主干冻结"）。新增游戏模式请看 [`docs/MODES.md`](./docs/MODES.md)。

## 运行

```bash
npm install
PORT=17000 node server/index.js      # 启动（默认写 ./server/data/game.db；失败回退 :memory:）
```

打开 `http://localhost:17000`。首次启动：**空库时第一个注册账号自动成为管理员**。

## 测试

```bash
npm test          # 权威套件（435 项），必须全绿
npm run test:go   # 围棋模式
npm run test:rooms
npm run test:admin
npm run test:maint
```

> 若本机 npm 的 shell shim 损坏（报 `dirname: command not found` / `EXIT 127`），
> 直接用 node 跑并重定向到日志：
> `node --test --expose-gc tests/engine.test.mjs > out.log 2>&1`，再读取 `out.log`。

## 目录结构

```
server/
  engine.js      主干：World 类（9 阶段 tick / 生命棋盘 / 快照 / 席位）
  net.js         主干：WS 枢纽（意图路由 / 广播 / tick 归属）
  index.js       主干：后台 tick 循环 + 调度器
  routes.js      主干：REST 端点（16 个）
  rooms.js       主干：房间 / 席位模型 + 设置归一
  modes/         ★ 模式注册表 + 各模式插件（新增模式只动这里）
    index.js       注册表（registerMode / getMode / normalizeMode / boardMaxForMode …）
    rts.js         默认模式（元数据）
    go.js          回合制演化棋（插件，实现在 server/go.js 的 mixin）
  go.js           go 的 mixin 实现（_go* 方法族，挂到 World.prototype）
  ai.js           AI（含 goAIMove）
  ...
public/
  index.html      页面骨架（client.js 以 <script type="module"> 加载）
  client.js       主干：渲染 / 输入 / HUD 分派
  modes/          ★ 前端模式注册表（新增模式只动这里）
    index.js       前端模式表（MODES / getMode / isGo / boardMaxForMode）
docs/             设计文档（含 MODES.md 模式开发指南）
tests/            node:test 单测
scripts/          QA 探针（qa_*_probe.mjs）
```

## 原则

1. **主干冻结**：`engine/net/index/routes/rooms` + `public/client.js` 的核心逻辑不轻易改。
   新功能/新模式走**注册表 + 插件**扩展。详见 `AGENTS.md` §2。
2. **不要硬编码模式分支**：主干不写 `mode === 'go'`；用 `server/modes/index.js` 的访问器或 `world._mode`。
3. **确定性**（IR-3a）：模拟路径不写 `Math.random` / `Date.now`，用 `mulberry32` 种子 rng。
4. **延迟=惯性**（IR-2）：不检测、不补偿延迟。
5. **地图编辑器保持模式无关**：只按 `boardMaxForMode(mode)` 决定尺寸上限。

## 提交前

- [ ] `npm test` 435/435 全绿。
- [ ] 主干无新增 `mode === '<某模式>'` 分支。
- [ ] 改了 `public/` 资源 → 提升 `index.html` 中 `client.js` 的 `?v=`。
- [ ] 新行为有对应测试（放在 `tests/`，并加入 `package.json` 的 `test` 脚本）。
