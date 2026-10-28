@echo off
rem Finds Python and puts its command in %PY%.  Used by the other .bat files.
set "PY="
set "PYTHONUTF8=1"
if exist "C:\Users\rsaja\AppData\Local\Programs\Python\Python312\python.exe" set "PY=C:\Users\rsaja\AppData\Local\Programs\Python\Python312\python.exe"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (where py >nul 2>nul && set "PY=py -3")
if not defined PY (
  echo Python was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
