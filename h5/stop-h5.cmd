@echo off
rem Stop the AgentCenter H5 local service listening on the given port (default 7788)
setlocal
set "PORT=7788"
if not "%~1"=="" set "PORT=%~1"

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:"127.0.0.1:%PORT%" ^| findstr /C:"LISTENING"') do (
  echo [AgentCenter] Killing PID %%P on port %PORT% ...
  taskkill /F /PID %%P >nul 2>nul
  set "FOUND=1"
)
if not defined FOUND echo [AgentCenter] No listener found on port %PORT%.
endlocal
