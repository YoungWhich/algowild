# 国内能打开的分享方案：内网穿透（cpolar / natapp）

> 适用：**人在国内，Render / Railway / Fly 等海外平台打不开**（被网络管控拦截）。
> 思路：你电脑照常跑游戏（本地 `localhost:17000`），用**国产内网穿透**把端口暴露成「国内可访问」的公网链接，朋友在国内也能直接打开。
> 优点：服务器在国内，国内访问稳；数据全在你自己电脑。
> 缺点：免费档链接每次重启会变（想固定需付费）；电脑要一直开着。

---

## 为什么不用 Render / Cloudflare 了

- Render、Railway、Fly、Cloudflare 的隧道（trycloudflare）**服务器都在海外**，国内经常打不开或卡死。
- 国产穿透（cpolar / natapp）的转发节点在国内，**朋友能稳定打开**你发过去的链接。
- 你本机的游戏（`启动游戏.bat`）完全不用改，和方案 A 一模一样，只是"打洞"工具换成国产的。

---

## 推荐：cpolar（国产，免费档可用）

### 第 1 步：注册 + 下载
1. 打开 <https://www.cpolar.com>（或 <https://www.cpolar.cn>），注册账号。
2. 控制台里复制你的 **Auth Token**（一串字符）。
3. 下载 Windows 客户端并安装（官网有"下载"页，选 Windows 版）。

### 第 2 步：登录 + 打洞
1. 安装完后，打开 PowerShell，先登录（把 `你的TOKEN` 换成控制台里复制的那串）：
   ```
   cpolar authtoken 你的TOKEN
   ```
2. 先双击 `启动游戏.bat` 把游戏跑起来（或者开着也行）。
3. 在 PowerShell 里执行（`-region=cn` 强制走国内节点，朋友访问最快最稳）：
   ```
   cpolar http -region=cn 17000
   ```
4. 稍等几秒，窗口里会打印一行（域名可能是 `.cpolar.top` 或 `.cpolar.cn`，都是国内节点）：
   ```
   Forwarding  https://xxxx.cpolar.top  ->  http://localhost:17000
   ```
   把那一串 `https://` 链接复制发给朋友，他们国内浏览器直接能玩。

### 注意
- 免费档每次重启 `cpolar` 链接都会变，要重新发一次。
- 想拿**固定不变**的链接：cpolar 付费套餐可保留子域名（按需，非必须）。

---

## 备选：natapp（也是国产）

1. 打开 <https://natapp.cn> 注册，买/领取一个免费隧道（本地端口填 `17000`）。
2. 下载 Windows 客户端，把官网给的 `config.ini`（含 authtoken）放进客户端目录。
3. 双击 `natapp.exe`，窗口会显示一个 `http://xxx.natappfree.cc` 链接，发给朋友即可。

---

## 想要「永久固定链接 + 不用开着电脑」怎么办

内网穿透都要你电脑开着。若想要**托管在云上、国内也能开、链接固定**，且 GitHub 能访问，可换：

- **Zeabur（zeabur.com）**：国内可访问的部署平台，连 GitHub 一键部署，比 Render 在国内稳。流程和我们之前写的 `deploy-render-b.md` 几乎一样（建服务 → 连 `algowild` 仓库 → `npm install` / `npm start` / `NODE_VERSION=22` + `MASTER_*`）。可照那篇文档操作，只是平台换成 Zeabur。

---

## 排错

| 现象 | 解决 |
|------|------|
| `cpolar` 不是内部命令 | 客户端没装好或没加进 PATH；重装，或到安装目录里按住 Shift 右键"在此处打开 PowerShell"再跑 |
| 朋友打开是白屏 | 确认你这边 `启动游戏.bat` 还开着、没休眠；你本地先开 `http://localhost:17000/` 确认能玩 |
| 链接变了 | 免费档正常，重启 cpolar 就换，重新发即可 |

---

## 和之前方案的关系

- 方案 A（Cloudflare 隧道）：海外节点，国内常打不开 → 弃用。
- 方案 B（Render 等）：海外托管平台，国内打不开 → 暂搁。
- **本方案（国产内网穿透）**：当前主线，国内可访问、数据在本地。
- WorkBuddy 一键发布：平台故障仍未修复，等修好再说。
