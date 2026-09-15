@echo off
cd /d "%~dp0"

echo ============================================================
echo   Emerging Lands - start game and generate a China-accessible share link
echo ============================================================
echo.

:: 1) check cpolar installed
where cpolar >nul 2>nul
if %errorlevel%==0 (
  goto :authcheck
) else (
  echo [!] cpolar not found. Download from https://www.cpolar.com and install it.
  echo     Then re-run this file.
  echo.
  pause
  exit /b
)

:: 2) auth: use token file if present, else use existing login
:authcheck
if exist "cpolar_token.txt" (
  for /f "delims=" %%t in (cpolar_token.txt) do (
    cpolar authtoken %%t >nul 2>nul
    goto :startgame
  )
)
if exist "%USERPROFILE%\.cpolar\cpolar.yml" goto :startgame
echo [!] First time setup needed. Put your cpolar Auth Token in cpolar_token.txt,
echo     or run once: cpolar authtoken YOUR_TOKEN
echo     Then re-run this file.
echo.
pause
exit /b

:: 3) start game + tunnel
:startgame
echo [1/3] Starting game server (new window)...
start "algowild-server" cmd /c "where node >nul 2>nul && node server/index.js || C:\Users\JM\.workbuddy\binaries\node\versions\22.22.2-3\node.exe server/index.js"
timeout /t 3 >nul
start "" http://localhost:17000/
echo [2/3] Starting cpolar tunnel (China region)...
echo [3/3] The https://xxxx.cpolar.cn (or .cpolar.top) line below is your share URL. Send it to friends.
echo       (Free plan: link changes each restart; keep this PC on.)
echo.
echo ============================================================
cpolar http -region=cn 17000
echo ============================================================
echo.
echo Tunnel closed. To fully stop the game, close the "algowild-server" window.
pause
