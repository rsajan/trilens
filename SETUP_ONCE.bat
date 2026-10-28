@echo off
title Trilens - one-time setup
cd /d "%~dp0"
call tools\_py.bat || exit /b 1
echo Installing the small Python packages this PC needs...
%PY% -m pip install --quiet --disable-pip-version-check -r pipeline\requirements-pc.txt
%PY% tools\setup_wizard.py
echo.
pause
