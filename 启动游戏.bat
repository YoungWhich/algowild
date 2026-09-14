@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set PORT=17000
echo ============================================
echo   Emerging Lands / 游戏"涌现之地" 启动中...
echo   稍后浏览器会自动打开，即可游玩。
echo   如果浏览器是白屏，按 F5 刷新一次。
echo ============================================
timeout /t 3 >nul
start "" http://localhost:17000/
REM 优先用系统 node；找不到则用 WorkBuddy 自带的 node（无需额外安装）
where node >nul 2>nul
if %errorlevel%==0 (
  node server/index.js
) else (
  "C:\Users\JM\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" server/index.js
)
echo.
echo 游戏已停止。关闭此窗口即可。
pause
