@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
echo ============================================================
echo   涌现之地 - 启动游戏并生成「分享链接」
echo ============================================================
echo.

:: 检查 cloudflared 是否在当前目录或 PATH
where cloudflared >nul 2>nul
if %errorlevel%==0 (
  goto :start
) else (
  echo [!] 本文件夹里没找到 cloudflared.exe
  echo.
  echo     请先下载它（任选一种，下载后重命名为 cloudflared.exe 放进 D:\workspace\Game）：
  echo.
  echo     ① Cloudflare 官网下载页（点 Windows 按钮）：
  echo        https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo.
  echo     ② 直链下载（打开就能下，不用登录）：
  echo        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  echo.
  echo     放好后，重新双击本「分享游戏.bat」即可。
  echo.
  pause
  exit /b
)

:start
echo [1/3] 启动游戏服务器（在后台黑窗口运行）...
start "algowild-server" cmd /c "where node >nul 2>nul && node server/index.js || C:\Users\JM\.workbuddy\binaries\node\versions\22.22.2-3\node.exe server/index.js"
timeout /t 3 >nul
start "" http://localhost:17000/

echo [2/3] 启动 Cloudflare 隧道（把本机游戏暴露到公网）...
echo [3/3] 稍等几秒，下方会打印一个 https://xxxx.trycloudflare.com 链接：
echo       把这个链接发给朋友，他们就能直接玩了。
echo       提醒：① 每次重开链接都会变；② 你电脑要一直开着；③ 关游戏见最底部说明。
echo.
echo ============================================================
cloudflared tunnel --url http://localhost:17000
echo ============================================================
echo.
echo 隧道已关闭。要完全停止游戏，请关掉那个名为 "algowild-server" 的黑窗口。
pause
