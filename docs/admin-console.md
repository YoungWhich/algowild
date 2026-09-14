# 管理员控制台（玩家管理后台）

> 交付日期：2026-09-10 · 状态：**已验证，待发布**
> 验证：`npm test` **227/227** · 封禁守卫探针 **32/32** · 房间端到端 **28/28** · 独立 QA **61/61 PASS**

## 1. 这是什么

给玩家（房主/服主）用的**独立管理界面**，用于账号治理：封禁、解封、踢下线、改角色、删除账号，外加房间强制关闭与操作审计。参考主流联机游戏的 GM 后台做法。

访问地址：**`/admin.html`**（独立页面，与游戏主界面分离）

游戏内入口：侧边栏 `#admin-entry`，**仅在 `user.role === 'admin'` 时显示**，新标签页打开。

## 2. 角色与权限模型

| 角色 | 说明 |
|---|---|
| `player` | 默认。普通玩家 |
| `admin` | 可访问全部 `/api/admin/*` |

- 角色存 `users.role`；`requireAdmin` **每次请求都从库里读最新 role**，所以改角色立即生效、无需重新登录。
- **先不做多级（mod/helper）**，保持简单。

### 管理员从哪来（引导路径）
1. **空库首个注册账号自动成为管理员**（服务端日志打 `[admin] bootstrap: ...`）。
   - 这是为了适配部署沙箱：沙箱里无法设置环境变量，这是唯一可用的引导路径。
   - 一旦库中已有管理员，该通道**永久关闭**，之后注册的都是 `player`。
2. **`ADMIN_USERNAMES` 环境变量**（逗号分隔）：命中的用户名在**注册与登录时**都强制 `admin`。适合本地/RTS 自建服务器。
3. **CLI**：`node scripts/admin.mjs grant <username>`（本地文件库，`DB_PATH` 指定）。

> ⚠️ 若对外公开且不放心"首个注册者即管理员"，应改用认领码机制 —— 需要额外的分发渠道，目前未实现。

## 3. 管理端点（11 个）

全部挂 `authMiddleware + requireAdmin`，统一 `{ code, message, data }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/overview` | 用户数/封禁数/管理员数、在线人数与名单、房间数（公开/私密）、世界数、DB 引擎、版本、运行时长 |
| GET | `/api/admin/users` | 用户列表：分页 + 搜索（用户名模糊 / 纯数字按 id）+ 过滤（`all` / `banned` / `admin`） |
| GET | `/api/admin/users/:id` | 用户详情 + 其 worlds / rooms / scores 摘要 |
| POST | `/api/admin/users/:id/ban` | 封禁，body `{ reason, durationHours }`（`0` 或省略 = 永久）；**并立即踢掉其在线 WS 会话** |
| POST | `/api/admin/users/:id/unban` | 解封 |
| POST | `/api/admin/users/:id/role` | 改角色 `admin` / `player` |
| POST | `/api/admin/users/:id/kick` | 仅踢下线，不封禁 |
| DELETE | `/api/admin/users/:id` | 硬删除，body 必须带 `confirmUsername` 且与目标一致 |
| GET | `/api/admin/rooms` | 房间列表（含私密房），含席位/人数/模式/房主名 |
| POST | `/api/admin/rooms/:code/close` | 强制关房 |
| GET | `/api/admin/actions` | 审计日志（倒序，默认 100 条） |

## 4. 封禁语义与执行点

封禁记录 `banned` / `ban_reason` / `banned_at` / `banned_until`（`0` = 永久）。
判定函数 `isBanActive(user)`：`banned && (!banned_until || banned_until > now)` —— **到期自动放行，无需人工解封**。

拦截点（缺一不可）：

| 入口 | 行为 |
|---|---|
| `POST /auth/login` | `4004 account_banned` + 原因/到期 |
| `GET /me` | `4004` |
| WS 握手（`hello` 与 `join` 两处） | 回错误消息 + `ws.close(4004,'banned')` |
| **全部业务接口（18 条）** | 统一中间件 `requireActive` → `4004` |
| 封禁动作本身 | **立即踢掉该用户所有在线 WS 会话**（不只是"新连接被拒"） |

例外（**有意为之**）：
- `POST /auth/register|login|logout` 不加 `requireActive`（未登录或自行处理）。
- `GET /me` 保留裸 `authMiddleware`（它自己返回带原因的 `4004`）。
- `/api/admin/*` **不叠加** `requireActive` —— 否则管理员被封后连自救能力都没有。
- `GET /rooms/:code` 是**匿名公开**的"邀请落地页"（无 `authMiddleware`，既有测试依赖匿名访问）。

## 5. 安全护栏

| 护栏 | 拒绝原因 |
|---|---|
| 不能封禁 / 删除 / 降级**自己** | `cannot_target_self` |
| 不能删除或降级**最后一个管理员** | `last_admin_protected` |
| **不能直接封禁管理员**（须先降级） | `cannot_ban_admin` |
| 删除必须输入用户名确认 | `confirm_username_mismatch` |
| `passhash` 绝不出现在任何 HTTP 响应 | 独立验证扫了 11 个响应体，0 命中 |

> `cannot_ban_admin` 这条是为了避免死结：被封的管理员自己被锁在外面，且没有任何办法解封自己。

## 6. 审计

新增 `admin_actions` 表（append-only）：`actor_id / actor_name / action / target_id / target_name / detail / created_at`。
每个**成功**的封禁/解封/改角色/删除/踢人/关房都恰好写一条；**被拒绝**的动作不写。

## 7. 数据库持久化（顺手修掉的一个隐藏问题）

**问题**：`server/index.js` 之前没有设 `DB_PATH`，默认走 `:memory:` —— **进程一重启，所有账号、封禁、审计全部消失**，「玩家管理」会变成一场空。

**改法**：`server/index.js` 在 `initDB()` 前默认 `DB_PATH='./server/data/game.db'`，若文件库打开失败则**回退 `:memory:` 并打警告**（保证线上绝不因此起不来）。

**⚠️ 并且修了一个顺序缺陷**：`initDB()` 原本**先选引擎、后创建目录**，导致全新文件系统上首次启动时 `node:sqlite` 因目录不存在而失败、静默落到 `sql.js`（WASM 内存库、每 5 秒才落盘一次），第二次启动才轮到 `node:sqlite`。而部署沙箱每次都是全新 checkout → **线上首启必然走 sql.js**。已把「创建 DB 父目录」**上移到引擎选择之前**，现首启即 `node:sqlite`。

**注意**：`server/db/index.js` 里 `DB_PATH` 的**默认值仍是 `':memory:'`**，`npm test` 依赖它做隔离 —— 不要改。

## 8. 客户端

- 独立页面 `public/admin.html`（190 行）+ `public/admin.js`（447 行）：总览 / 玩家管理 / 在线 / 房间 / 审计日志五区，纯原生 JS，无框架无构建。
- **所有请求三通道带 token**（`?token=` 查询参数 + `x-auth-token` 头，`Authorization` 头可带但不可依赖）—— 该平台反向代理会劫持 `Authorization`。
- 复用 `localStorage['algowild_token']`；无 token 提示去首页登录；非管理员显示「无权限」。
- 资产版本号：`client.js?v=20260912a`。

## 9. 文件清单

**新增**
- `public/admin.html` / `public/admin.js` — 管理界面
- `scripts/admin.mjs` — CLI（`list|grant|revoke|ban|unban|delete`）
- `tests/admin.test.mjs` — 11 条（ADM-01..11）
- `scripts/qa_admin_probe.mjs` — QA 独立攻击探针（670 行，61 项）
- `scripts/qa_ban_guard_probe.mjs` — 封禁守卫覆盖面回归（32 项）

**修改**
- `server/db/schema.sql`（users 新列 + `admin_actions`）、`server/db/index.js`（迁移/repos/顺序修复）
- `server/auth.js`（`isBanActive` / `requireAdmin`；**多通道取 token 逻辑未动**）
- `server/net.js`（`kickUser` / `onlineUserIds` / 两处握手封禁校验）
- `server/routes.js`（11 个管理端点 + `requireActive` + 各种拦截）
- `server/index.js`（DB_PATH 默认与回退）
- `public/index.html` / `public/client.js`（管理员入口 + role 同步）
- `tests/room_lobby.test.mjs`（RL-06：私密房不泄露房名）
- `package.json`（test 列表 + `test:admin`）

## 10. 验证证据

| 项 | 结果 |
|---|---|
| `npm test` | **227 / 227**（原 215 零回归） |
| 独立 QA（攻击者+运维视角，61 项） | **VERDICT: PASS** |
| 封禁守卫探针 | **32 / 32** |
| 房间模型端到端 | **28 / 28** |
| 源码 `node --check` | 全过 |

### 独立 QA 的关键实测
- 11 个管理端点：player token **全 403**、无 token 全 401、**已删除用户旧 token → 403（非 500）**
- 反代劫持验证：`?token=` 有效 + 同时塞无效 `Authorization` → **仍成功**
- 封禁全链路：目标**先真连上 WS 收到快照** → 封禁 → 该 WS **确实被关闭 `4004 banned`**，`kicked=1`
- 定时封禁：把 `banned_until` 改成过去 → **自动放行**
- 硬删除：**SQL 直查**六表，删前 `1/1/1/1/1/3` → 删后**全 0**，旁观者数据不受影响
- 分页注入面：`pageSize=0/-1/10000`、`q=' OR 1=1` 等 13 例 → 无 500、无错误栈

## 11. 本轮顺带修掉的既有缺陷

1. **私密房房名泄漏**：`GET /rooms/:code` 的注释写着"私密房间只回存在性与是否需密码"，代码却返回了 `name`，与 `/rooms/search` 策略矛盾 —— 任何枚举房间号的人都能读到私密房名字。已删除该字段并补反向断言（公开房仍须返回 `name`/`worldId`）。
2. **DB 引擎选择顺序**：见 §7。
3. **DB 持久化**：见 §7。

## 12. 已知限制 / 未做

- `onlineUserIds` 只统计**已完成 WS hello 并进入世界**的用户；仅建立连接未进房的不计入在线数。
- 未做：频次限制（rate limit）、IP 封禁、多级角色、撤销删除（软删除/回收站）、封禁申诉。
- 未验证：管理界面在真实浏览器中的交互手感（无头环境只能验证接口与静态资源）。
