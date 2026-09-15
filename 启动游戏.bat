@echo off
cd /d "%~dp0"
set PORT=17000
echo ============================================
echo   Emerging Lands - starting game...
echo   Browser will open automatically. If blank, press F5 to refresh.
echo ============================================
timeout /t 3 >nul
start "" http://localhost:17000/
REM prefer system node; fall back to WorkBuddy bundled node
where node >nul 2>nul
if %errorlevel%==0 (
  node server/index.js
) else (
  "C:\Users\JM\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" server/index.js
)
echo.
echo Game stopped. Close this window to exit.
pause
