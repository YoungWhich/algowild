@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
echo ============================================================
echo   涌现之地 - 启动游戏并生成「国内可访问」分享链接
echo ============================================================
echo.

:: 1) 检查 cpolar 是否已安装
where cpolar >nul 2>nul
if %errorlevel%==0 (
  goto :authcheck
) else (
  echo [!] 本机还没装 cpolar
  echo     请先到 https://www.cpolar.com 下载 Windows 版并安装。
  echo     装好后重新双击本文件即可。
  echo.
  pause
  exit /b
)

:: 2) 登录：有 token 文件就用它；没有但已登录过也能直接打洞
:authcheck
if exist "cpolar_token.txt" (
  for /f "delims=" %%t in (cpolar_token.txt) do (
    cpolar authtoken %%t >nul 2>nul
    goto :startgame
  )
)
:: 没有 token 文件，但曾登录过（cpolar.yml 里已有 token）也能直接打洞
if exist "%USERPROFILE%\.cpolar\cpolar.yml" goto :startgame
echo [提示] 首次使用，需要先把 cpolar 的 Auth Token 做两件事之一：
echo     ① 在本文件夹新建一个 cpolar_token.txt，里面只写你的 Token；或
echo     ② 自己先跑一次： cpolar authtoken 你的TOKEN
echo     然后重新双击本文件。
echo.
pause
exit /b

:: 3) 启动游戏 + 打洞
:startgame
echo [1/3] 启动游戏服务器（后台窗口）...
start "algowild-server" cmd /c "where node >nul 2>nul && node server/index.js || C:\Users\JM\.workbuddy\binaries\node\versions\22.22.2-3\node.exe server/index.js"
timeout /t 3 >nul
start "" http://localhost:17000/
echo [2/3] 启动 cpolar 内网穿透（强制国内 cn 节点）...
echo [3/3] 稍后出现的 https://xxxx.cpolar.top / .cpolar.cn 就是分享链接，发给朋友即可：
echo       （免费档每次重开链接会变；电脑要一直开着）
echo.
echo ============================================================
cpolar http -region=cn 17000
echo ============================================================
echo.
echo 隧道已关闭。要完全停止游戏，请关掉那个 "algowild-server" 黑窗口。
pause
