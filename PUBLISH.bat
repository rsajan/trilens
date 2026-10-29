@echo off
setlocal enabledelayedexpansion
title Trilens - publish Technical page
cd /d "%~dp0"
call tools\_py.bat || exit /b 1
if /i "%~1"=="/quiet" (
  rem Scheduled runs (Trilens_Publish_AM/PM) have no console, so capture
  rem output here -- otherwise a failure leaves no trace to diagnose.
  echo ---- %date% %time% ---- >> "%~dp0publish.log"
  %PY% tools\publish.py %* >> "%~dp0publish.log" 2>&1
  set RC=!errorlevel!
  echo exit !RC! >> "%~dp0publish.log"
  exit /b !RC!
)
%PY% tools\publish.py %*
echo.
pause
