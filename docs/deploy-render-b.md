# 方案 B：免费 Node 主机部署（给别人一个固定网址）

> 适合：想发一个**固定外网链接**给朋友，自己电脑不用一直开着。
> 三个可选平台：**Render（最简单）** / **Fly.io（数据不丢、永不停机）** / **Railway（也简单）**。
> 本文以 **Render** 为主路径（点几下鼠标就行），**Fly.io** 给"想让账号永久保存"的进阶路径。

---

## 先搞清楚的两件事（重要）

1. **代码要先放到 GitHub 上**。这些平台都是从 GitHub 拉代码部署的。下面「第 0 步」会教你推上去。
2. **免费档的硬盘是"临时"的**：平台重启 / 你重新部署代码时，服务器上的文件会被清空。
   - 后果：普通玩家的**账号会丢**（需要重新注册）。
   - 但**管理员账号不会丢**——因为我们之前把 `master` 做成了"从环境变量重生"，重启后自动重建。
   - 想要**账号永久保存**，看下面的 **Fly.io 路径**（它给免费持久硬盘）。

本项目已具备部署所需的一切，无需改代码：
- 启动命令就是 `npm start`（= `node server/index.js`）✅
- 端口自动读 `process.env.PORT`，并绑定 `0.0.0.0` ✅
- 需要 Node **22+**（package.json 已声明 `engines: >=22.5.0`）✅
- 健康检查接口 `/healthz` 已存在 ✅
- 前端 WebSocket 地址跟随域名自动拼（`wss://你的域名/ws`），不会写死 localhost ✅

---

## 第 0 步：把代码推到 GitHub

（如果你已经会 Git / 代码已在 GitHub，跳过这步，直接去看"主路径一"。）

1. 打开浏览器注册 / 登录 <https://github.com>。
2. 右上角 **＋ → New repository**：
   - Repository name 填 `algowild`（随便起）
   - 选 **Public**
   - **不要**勾 "Add a README"（我们本地已有文件）
   - 点 **Create repository**
3. 创建好后，GitHub 会显示一个快速上手页，里面有你的仓库地址（形如 `https://github.com/你的名/algowild.git`）。
4. **本地仓库我已经帮你初始化并提交好了**（分支 `main`，145 个文件，已自动排除 `node_modules/`、数据库、`*.txt` 临时探针）。你不用再 `git init` / `commit`，否则会重复或报"nothing to commit"。

   你只需要在本机打开 **PowerShell**（Win 键搜 PowerShell），粘贴执行这两行（把 `你的名` 换成你的 GitHub 用户名）：

```powershell
git remote add origin https://github.com/你的名/algowild.git
git push -u origin main
```

> 第一次 push 会弹出 GitHub 登录框，按提示登录授权即可。
> 推送完，刷新 GitHub 页面，能看到 `server/`、`public/`、`package.json` 等就成功了。
> （本地 git 身份暂设为 `JM <jm@local>`，想用真实邮箱可在仓库目录跑 `git config user.email 你的邮箱` 修改。）

---

## 主路径一：Render（最简单，免费）

> 免费额度：750 小时/月（一个服务够用）、512MB 内存、**15 分钟没人访问会"睡"**，首次打开要等 30~60 秒唤醒。
> 亚洲选 **Singapore** 节点延迟最低。

### 步骤

1. 打开 <https://render.com> → 右上角 **Sign Up** → 用 GitHub 账号授权登录。
2. 登录后点 **New + → Web Service**。
3. 选 **Connect a repository** → 找到 `algowild` 仓库 → 点 **Connect**。
4. 填写：
   - **Name**：`algowild`（随便）
   - **Region**：**Singapore**（离国内近）
   - **Branch**：`main`
   - **Runtime**：**Node**
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Plan**：**Free**
5. 先**不要**点 Create，往下看 **Advanced → Add Environment Variable**，把下面几个加上（前两个必加，后面可选）：

   | Key | Value | 说明 |
   |-----|-------|------|
   | `NODE_VERSION` | `22` | 必须，指定 Node 22 |
   | `MASTER_USERNAME` | 你想要的 admin 名，如 `admin` | 服务器重启后自动重建管理员 |
   | `MASTER_PASSWORD` | 一个强密码 | 管理后台登录用；漏了就重新部署改值 |
   | `ADMIN_ACCESS_KEY` | （可选）一串随机串 | 给 `/admin/*` 和管理登录加第二把锁 |
   | `ADMIN_ALLOWED_IPS` | `*` | 默认放开；想只限本机就填 `127.0.0.1` |

   > 不想手填环境变量，也可以把仓库里的 `render.yaml` 一起推上去，直接在 Render 建 **Blueprint** 服务，它会自动读配置（只有 `NODE_VERSION` 写进去了，`MASTER_*` 仍需在后台补）。

6. 点 **Create Web Service**。
7. 等 1~2 分钟，日志里出现 `[server] http://0.0.0.0:...` 和 `[db] ...` 就成功了。
8. 页面顶部会给你一个网址，形如 **`https://algowild.onrender.com`** —— 这就是你的游戏链接，发给朋友即可。

### 关于"数据会丢"的应对

- 免费档每次**重新部署代码**，本地数据库 `./server/data/game.db` 会被清空 → 普通玩家账号丢失，需重注册。
- **管理员不会丢**：因为 `MASTER_USERNAME`/`MASTER_PASSWORD` 写在平台环境变量里（不在硬盘上），重启后 `bootstrapMaster()` 会自动重建。
- 如果只是平常玩、偶尔部署，**无所谓**；若想彻底持久，见主路径二（Fly.io）。

---

## 主路径二：Fly.io（数据不丢 + 永不停机，免费）

> 为什么选它：免费档给 **3GB 持久硬盘** + **3 台常驻小虚拟机（不睡觉）**。账号、房间数据挂到持久盘上，**重新部署也不丢**，且服务器一直在线。
> 代价：要用命令行，且注册时需**绑一张信用卡做验证**（不扣费）。

### 步骤

1. 本机装 `flyctl`：浏览器打开 <https://fly.io/docs/hands-on/installing/>，按系统装（Windows 用 PowerShell 跑官方安装命令）。
2. 登录：`fly auth login`（浏览器授权）。
3. 在项目目录打开 PowerShell，执行：
   ```powershell
   cd D:\workspace\Game
   fly launch
   ```
   - 问 App name：回车用默认。
   - 问 Region：选 `sin`（新加坡）或 `hkg`（香港）离国内近。
   - 问 "Would you like to deploy now?"：**先选 No**（我们要先加持久盘）。
   - 它会生成 `fly.toml`，先别改太多。
4. 建一块持久盘（1GB 够用）：
   ```powershell
   fly volumes create algodata --size 1 --region sin
   ```
5. 把盘挂到 `/data`，并让数据库写进盘里。编辑 `fly.toml`，在 `[build]` 之后加：
   ```toml
   [mounts]
     source = "algodata"
     destination = "/data"

   [env]
     NODE_VERSION = "22"
     DB_PATH = "/data/game.db"
     MASTER_USERNAME = "admin"
     # MASTER_PASSWORD / ADMIN_ACCESS_KEY 建议用 secret（见下），不要明文写这里
   ```
   然后把 `MASTER_PASSWORD` 等敏感值设为 secret（不进文件）：
   ```powershell
   fly secrets set MASTER_PASSWORD="你的强密码" ADMIN_ACCESS_KEY="随机串"
   ```
6. 部署：
   ```powershell
   fly deploy
   ```
7. 完成后 `fly apps open` 会打开你的网址，形如 **`https://algowild.fly.dev`**。

这样账号和房间都落在 `/data/game.db`（持久盘），重启、重新部署都**不丢**。

---

## 主路径三：Railway（一句话）

<https://railway.app> 用 GitHub 登录 → **New Project → Deploy from GitHub repo** 选 `algowild` → 它会自动识别 Node 项目跑 `npm install` / `npm start`。在 **Variables** 里加 `NODE_VERSION=22` 和 `MASTER_*`。免费是 **$5 试用额度**（约 500 小时），用完停服，硬盘同样是临时的。

---

## 排错速查

| 现象 | 原因 / 解决 |
|------|------------|
| 部署一直失败，日志报 Node 版本不对 | 确认加了环境变量 `NODE_VERSION=22` |
| 打开网页白屏 / 进不去游戏 | 多等 30 秒（免费实例在"睡"后首次唤醒慢）；按 F5；再看日志有没有 `[db]` 报错 |
| 能进首页但**联机/实时不动** | 基本是 WS 没通。确认平台没挡 WebSocket（Render/Railway/Fly 默认都通）；看浏览器 F12 → Network → 有没有 `/ws` 的 101 Switching Protocols |
| 重启后管理员登不进去 | `MASTER_USERNAME`/`MASTER_PASSWORD` 没设或拼错；改了环境变量要**重新部署**才生效（Render 在环境变量页有 "Manual Deploy"） |
| "应用预留域名未绑定" 这类平台错误 | 那是 WorkBuddy 自家发布后台的故障，和本方案无关；本方案走的是第三方平台，不受影响 |

---

## 和"WorkBuddy 一键发布"的关系

本方案 B 是**绕开** WorkBuddy 发布后台、直接用第三方平台部署，所以之前那个"域名未绑定"的故障**不影响这里**。
等你以后想在 WorkBuddy 里"一键发布"也行——那个是另一回事，平台修好后跟我说"发布"即可。
两种不冲突：方案 B 给你一个永远能用的外链；WorkBuddy 发布修好后作为备用。
