@echo off
cd /d "%~dp0"
setlocal

echo ============================================================
echo   Emerging Lands - start game and generate a China share link
echo ============================================================
echo.

set "CPOLAR="
where cpolar >nul 2>nul
if %errorlevel%==0 set "CPOLAR=cpolar"

if not defined CPOLAR if exist "D:\cpolar\cpolar.exe" set "CPOLAR=D:\cpolar\cpolar.exe"
if not defined CPOLAR if exist "%~dp0cpolar.exe" set "CPOLAR=%~dp0cpolar.exe"
if not defined CPOLAR if exist "%USERPROFILE%\cpolar\cpolar.exe" set "CPOLAR=%USERPROFILE%\cpolar\cpolar.exe"
if not defined CPOLAR if exist "%LOCALAPPDATA%\cpolar\cpolar.exe" set "CPOLAR=%LOCALAPPDATA%\cpolar\cpolar.exe"

if not defined CPOLAR (
  echo [!] cpolar not found.
  echo     Put cpolar.exe in D:\cpolar\  then re-run this file.
  echo     Download: https://www.cpolar.com/download
  echo.
  pause
  exit /b
)
echo [ok] cpolar: %CPOLAR%
echo.

if exist "cpolar_token.txt" (
  for /f "delims=" %%t in (cpolar_token.txt) do (
    "%CPOLAR%" authtoken %%t >nul 2>nul
    goto :startgame
  )
)
if exist "%USERPROFILE%\.cpolar\cpolar.yml" goto :startgame
echo [!] First time setup needed.
echo     Put your cpolar Auth Token in cpolar_token.txt, then re-run.
echo.
pause
exit /b

:startgame
echo [1/3] Starting game server in a new window...
start "algowild-server" cmd /c "where node >nul 2>nul && node server/index.js || C:\Users\JM\.workbuddy\binaries\node\versions\22.22.2-3\node.exe server/index.js"
timeout /t 3 >nul
start "" http://localhost:17000/
echo [2/3] Starting cpolar tunnel (China region)...
echo [3/3] Look for the line:  Tunnel established at https://xxxx.cpolar.cn
echo       That https address is the share URL. Send it to your friends.
echo       (Free plan: the link changes each restart. Keep this PC on.)
echo.
echo ============================================================
"%CPOLAR%" http -region=cn 17000
echo ============================================================
echo.
echo Tunnel closed. To stop the game, close the algowild-server window.
pause
