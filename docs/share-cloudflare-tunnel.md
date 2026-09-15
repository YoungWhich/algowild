# 没有 GitHub 也能发外链：Cloudflare 隧道（方案 A，零账号）

> 适用：**没有 GitHub 账号**、想马上给朋友一个能玩的外网链接。
> 优点：**不需要 GitHub、不需要任何账号、免费**，数据全在你自己电脑上。
> 缺点：① 每次重开链接都会变（要重新发一次）；② 你电脑得一直开着；③ 朋友是通过 Cloudflare 中转连到你电脑。

原理一句话：你电脑上先跑游戏（本地 `localhost:17000`），再用 `cloudflared` 打一条隧道，把那个本地端口变成 `https://xxxx.trycloudflare.com` 公网地址。

---

## 第 1 步：下载 cloudflared（只需要这一次）

`cloudflared` 是个小程序，负责打隧道。下载方式任选一种：

**方式 ①（最简单，不用登录）** —— 直接复制下面这个网址到浏览器打开，会自动下载：
```
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```
> 这是 GitHub 的「发布文件」直链，**下载不需要登录**，没账号也能下。

**方式 ②** —— 打开 Cloudflare 官方下载页，点 Windows 按钮下载：
```
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

下载下来的文件名大概是 `cloudflared-windows-amd64.exe`，通常在 `C:\Users\JM\Downloads`（下载文件夹）里。

---

## 第 2 步：把文件放到游戏目录并改名

1. 打开「文件资源管理器」，进 `C:\Users\JM\Downloads`，找到刚下的 `cloudflared-windows-amd64.exe`。
2. 右键 → **重命名**，改成 `cloudflared.exe`（注意末尾的 `.exe` 要保留）。
3. 把它**剪切/复制**到 `D:\workspace\Game` 文件夹里（和 `启动游戏.bat`、`分享游戏.bat` 放一起）。

> 小提示：如果你电脑「不显示文件扩展名」，重命名时可能只看到 `cloudflared-windows-amd64`。
> 那就直接整段改名为 `cloudflared.exe` 即可，Windows 会保留 `.exe`。
> 放好后，`D:\workspace\Game` 里应当能看到一个 `cloudflared.exe`。

---

## 第 3 步：双击「分享游戏.bat」

1. 打开 `D:\workspace\Game` 文件夹。
2. **双击 `分享游戏.bat`**（不是 `启动游戏.bat`——那个只本地玩，这个才会生成分享链接）。
3. 会弹出**两个黑窗口**：
   - 一个叫 `algowild-server`（游戏服务器，别关）
   - 另一个是 `分享游戏.bat` 自己的窗口，稍等几秒会打印一行类似：
     ```
     https://xxxx.trycloudflare.com
     ```
     （`xxxx` 是一串随机字母，每次都不一样）

4. 第一次运行时，Windows 可能弹出**「Windows 防火墙」询问**——两个程序（node / cloudflared）都点**「允许访问」**。

---

## 第 4 步：复制链接发给朋友

1. 在 `分享游戏.bat` 窗口里，用鼠标**选中那行 `https://xxxx.trycloudflare.com`**，右键复制（或 Ctrl+C）。
2. 通过微信 / QQ 发给朋友。
3. 朋友在浏览器打开这个链接，就能直接玩你的游戏了（实时联机也通，因为隧道支持 WebSocket）。

---

## 第 5 步：怎么停 / 注意事项

- **停止分享**：关掉 `分享游戏.bat` 那个窗口（按 Ctrl+C 或点右上角 ×）；然后**再关掉**那个 `algowild-server` 黑窗口，游戏才完全停。
- **链接会变**：每次重开 `分享游戏.bat`，都会得到一个新的 `https://xxxx.trycloudflare.com`，要重新发一次给朋友。
- **电脑要开着**：朋友能玩的前提是你这台电脑没关机、且 `分享游戏.bat` 在运行。
- **数据在你这**：玩家账号、房间都存在你电脑的本地数据库里，不走第三方。

---

## 常见问题

| 现象 | 解决 |
|------|------|
| 双击 `分享游戏.bat` 提示「没找到 cloudflared.exe」 | 回到第 2 步，确认 `cloudflared.exe` 已经放进 `D:\workspace\Game` 并改名正确 |
| 窗口一闪而过 / 报错 | 看窗口里的红字；多半是 cloudflared 没放对位置，或网络不通 |
| 朋友打开链接白屏 | 确认你这边 `分享游戏.bat` 还在运行、电脑没休眠；你本地先刷新 `http://localhost:17000/` 确认能玩 |
| 想「固定不变」的链接 | 这个免费隧道做不到。想要永久固定链接，可以去注册一个免费 GitHub 账号，改走 `deploy-render-b.md`（方案 B）用 Render 部署 |

---

## 和方案 B 的关系

- 方案 B（Render/Railway）**需要 GitHub 账号**（从 GitHub 拉代码部署），你目前没有，所以先用本方案 A。
- 等你有 GitHub 账号了，随时可以再看 `deploy-render-b.md` 走方案 B，拿到**永久固定**的 `https://algowild.onrender.com`。
- 两个不冲突：方案 A 临时分享，方案 B 长期托管。
