# 涌现之地 · 自己发布上线 指南

> 背景：WorkBuddy 的「发布为应用」通道（内置 `workbuddy_sites_deploy`）当前被平台后端卡住，
> 报 `应用预留域名 *.app.workbuddy.link 未绑定到本次发布环境`。这是**平台侧环境绑定故障**，
> 与游戏代码无关（`npm test` 262/262 全绿）。本指南教你**绕开平台**自己把游戏发布到公网。

---

## 0. 游戏本体：先确认本地能玩

```bash
cd D:/workspace/Game
PORT=17000 node server/index.js
```

然后浏览器打开 <http://localhost:17000/>
（已实测：根路径返回 200，页面约 12.9 KB。）

> 服务必须监听 `PORT` 环境变量、绑定 `0.0.0.0` —— 本项目已满足，换任何平台都不用改代码。
> 落库：better-sqlite3 → node:sqlite → sql.js 三级回退；磁盘不可写会自动降级内存库。

---

## 方案 A：本地 + Cloudflare Tunnel（最快，免注册，5 分钟）

**适合**：想立刻把链接发给别人玩，不介意链接每次重启会变。

### 步骤

1. **起本地服务**（见上面第 0 节，保持窗口不关）。

2. **下载 cloudflared**（Windows）：
   - 打开 <https://github.com/cloudflare/cloudflared/releases/latest>
   - 下载 `cloudflared-windows-amd64.exe`，重命名为 `cloudflared.exe`，放到比如 `D:\tools\cloudflared.exe`

3. **另开一个终端**，运行：
   ```bash
   D:/tools/cloudflared.exe tunnel --url http://localhost:17000
   ```

4. 终端会打印一行：
   ```
   https://xxxxxxxxxxxx.trycloudflare.com
   ```
   **这个链接就是公网地址**，发给任何人即可打开你的游戏。

### 注意
- 免账号版链接**每次重启都会变**；要保持固定域名需注册 Cloudflare 账号 + 绑定自己的域名。
- 关掉 cloudflared 终端，链接立即失效。
- 别人要能连上你的机器，本机防火墙需放行出站（一般默认放行）。

**备选穿透工具**：
- `ngrok http 17000`（需注册拿 authtoken）
- 国内 `cpolar` / `natapp`（免注册版有临时域名，国内访问更快）

---

## 方案 B：部署到免费 Node 托管（要长期稳定链接）

**适合**：想要一个固定、长期可用的链接。任选一个平台：

| 平台 | 免费层 | 得到的链接 | 做法要点 |
|------|--------|-----------|---------|
| **Render.com** | 有（会休眠） | `xxx.onrender.com` | New → Web Service → 连 Git 仓库；Build `npm install`；Start `npm start` |
| **Railway** | 有额度 | `xxx.up.railway.app` | 连仓库即自动部署，零配置 |
| **Fly.io** | 有额度 | `xxx.fly.dev` | 装 `flyctl` → `fly launch` → `fly deploy` |
| **Glitch / Replit** | 有 | 平台域名 | 直接导入仓库，选 Node |

### 关键配置（所有平台通用）
- **Build command**：`npm install`
- **Start command**：`npm start`（即 `node server/index.js`）
- **端口**：平台会给 `PORT` 环境变量，服务已自动读取，**无需改代码**。
- **依赖**：`better-sqlite3` 是 optionalDependency，装不上会自动回退 `node:sqlite` / `sql.js`，不影响启动。

### 🔐 环境变量（管理员配置，**抗清盘**，务必用平台 env 设，别写进代码/提交到 git）

免费实例清盘会清空 `game.db`（账号、房间、后台设置全没）。但**环境变量写在平台配置里、不在临时盘上**，
重启/清盘后仍在 → 用它固化管理员逃生通道，则清盘也不怕丢管理权。

| 变量 | 作用 | 建议值 |
|------|------|--------|
| `ADMIN_USERNAMES` | 逗号分隔的白名单用户名，注册/登录即强制管理员 | `master` 或你的常用名 |
| `ADMIN_ACCESS_KEY` | 设置后，管理员登录与所有 `/admin/*` 必须带此密钥（放 body.adminKey / 头 `x-admin-key` / `?adminKey=`） | 一长串随机串 |
| `ADMIN_ALLOWED_IPS` | 允许访问管理后台的来源 IP；`* ` = 不限制；默认仅 `127.0.0.1` | `*` 或你的出口 IP / CIDR |
| `MASTER_USERNAME` | **设了才会自举**：服务启动时若此账号不存在，自动建为 admin（清盘后自动重建） | `master` |
| `MASTER_PASSWORD` | 配合上面；不设则启动生成强随机密码并打印到日志（请保存） | 一长串随机串 |

> 行为说明：
> - 不设 `MASTER_USERNAME` → **完全无副作用**，不影响现有逻辑与测试。
> - 设了且账号不存在 → 启动自动创建并提权为 admin，日志打印 `[admin] bootstrap: created "master" as admin`。
> - 既有"空库首账号自动 admin"逻辑保留，二者不冲突。
> - `ADMIN_USERNAMES` / `ADMIN_ACCESS_KEY` / `ADMIN_ALLOWED_IPS` 原本就支持环境变量（优先于 DB 设置）。

**最少配置（抗清盘起步）**：在平台后台设 `ADMIN_USERNAMES=master` + `MASTER_USERNAME=master` + `MASTER_PASSWORD=<随机串>`，
清盘后重启即自动恢复管理员，无需手动重建。

### ⚠️ 数据持久化提醒
免费实例的**磁盘是临时的，重启/重新部署会清空数据**（账号、房间会丢）。
若要长期保存用户数据：
- 挂**持久卷**（Render Disk / Fly Volumes），并把 `DB_PATH` 指到该卷；或
- 迁移到托管数据库（注意：本项目当前是 SQLite，换 MySQL/PG 要改 `server/db/`）。

---

## 方案 C：WorkBuddy 平台恢复后重发（最省事）

等平台发布后端修好，在对话里对我说一句 **「发布」/「上线」**，
我一条命令把最新版（`?v=20260912l`，含玩家回血 / AI 加强 / 规则简化 / go 虚拟预览 / 空房间清理）推上线。

---

## 当前待上线的改动（`?v=20260912l`）

| 改动 | 说明 |
|------|------|
| 玩家被动回血 | 脱战约 10s 回满（受伤后 5s 内不回血） |
| AI 加强 | 反应 ≈10Hz、侦测半径 16→20、更敢打、扩张更快 |
| 规则文案简化 | 去掉"康威"术语，30 秒直白规则卡 |
| go 虚拟演化预览 | 青色虚拟格 + `V` 开关 + 1–8 回合步进 |
| 空房间自动清理 | 零真人满 grace 期后释放内存 |

测试基线：`npm test` **262/262**。

---

## 一键脚本参考（方案 A 自动化）

如果 cloudflared 已就位，可用下面这条（Windows PowerShell）：

```powershell
# 终端 1：起游戏
cd D:\workspace\Game
$env:PORT="17000"; node server/index.js

# 终端 2：开穿透
D:\tools\cloudflared.exe tunnel --url http://localhost:17000
```

按终端 2 打印的 `https://xxxx.trycloudflare.com` 分享即可。
