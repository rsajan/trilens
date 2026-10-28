@echo off
title Trilens - upload my changes
cd /d "%~dp0"
call tools\_py.bat || exit /b 1
%PY% tools\push_changes.py
echo.
pause
