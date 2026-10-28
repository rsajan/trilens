@echo off
title Trilens - local preview
cd /d "%~dp0"
call tools\_py.bat || exit /b 1
echo Building the Technical page from your scanner folders (private copy for this PC only)...
%PY% pipeline\build_technical.py
echo.
echo Opening http://localhost:8080/  -  close this window to stop the preview.
start "" "http://localhost:8080/"
%PY% -m http.server 8080
