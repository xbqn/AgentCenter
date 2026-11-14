@echo off
rem ============================================================
rem  AgentCenter H5 - one click launcher
rem  1) start local service (node serve.mjs) if not running
rem  2) open H5 in a dedicated browser app window
rem  Usage: start-h5.cmd [port]   (default 7788)
rem ============================================================
setlocal
cd /d "%~dp0"

set "PORT=7788"
if not "%~1"=="" set "PORT=%~1"
set "URL=http://127.0.0.1:%PORT%/"
set "LOG=%LOCALAPPDATA%\AgentCenter\h5.log"

where node >nul 2>nul
if errorlevel 1 (
  echo [AgentCenter] Node.js not found. Please install Node.js 22.15+ first.
  echo               https://nodejs.org/
  pause
  exit /b 1
)

rem ---- Node 版本检查：zstd 会话需要 22.15+ / 23.8+，更早的版本会让服务启动即报错 ----
for /f "delims=" %%v in ('node -p "process.versions.node" 2^>nul') do set "NODEVER=%%v"
node -e "const [a,b]=process.versions.node.split('.').map(Number);const major=a;const ok=(major>23)||(major===23&&b>=8)||(major===22&&b>=15)||(major>22&&major<23);process.exit(ok?0:1)"
if errorlevel 1 (
  echo [AgentCenter] Node.js %NODEVER% is too old.
  echo               Need 22.15+ or 23.8+ ^(the DSH .zstd session reader uses node:zlib zstd^).
  echo               Download: https://nodejs.org/
  echo.
  echo               You can still run it: other agents scan fine, only DeepSeek Harness
  echo               sessions are skipped. Continue anyway?
  choice /c YN /n /m "  [Y] continue with limited features, [N] quit: "
  if errorlevel 2 exit /b 1
) else (
  echo [AgentCenter] Node.js %NODEVER%
)

if not exist "%LOCALAPPDATA%\AgentCenter" mkdir "%LOCALAPPDATA%\AgentCenter" >nul 2>nul

rem ---- already running? ----
call :probe
if not errorlevel 1 (
  echo [AgentCenter] Service already running on port %PORT%.
  goto :open
)

echo [AgentCenter] Starting local service on port %PORT% ...
start "AgentCenterH5" /min node serve.mjs --port %PORT%

rem ---- wait up to ~10s ----
for /l %%i in (1,1,20) do (
  call :probe
  if not errorlevel 1 goto :open
  ping -n 1 -w 500 127.0.0.1 >nul
)

echo [AgentCenter] Service did not respond in time.
echo               Check log: %LOG%
pause
exit /b 1

:open
set "BROWSER="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "D:\Users\%USERNAME%\AppData\Local\Google\Chrome\Application\chrome.exe" set "BROWSER=D:\Users\%USERNAME%\AppData\Local\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined BROWSER (
  echo [AgentCenter] Opening app window: %URL%
  start "" "%BROWSER%" --app=%URL% --window-size=430,900
) else (
  echo [AgentCenter] No Chromium browser found, opening default browser.
  start "" "%URL%"
)
endlocal
exit /b 0

:probe
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{ $r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0} else {exit 1} }catch{ exit 1 }" >nul 2>nul
exit /b %errorlevel%
