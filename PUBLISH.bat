@echo off
title Trilens - publish Technical page
cd /d "%~dp0"
call tools\_py.bat || exit /b 1
%PY% tools\publish.py %*
if /i "%~1"=="/quiet" exit /b %errorlevel%
echo.
pause
