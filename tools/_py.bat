@echo off
rem Finds Python and puts its command in %PY%.  Used by the other .bat files.
set "PY="
set "PYTHONUTF8=1"
rem The python.org installer's per-user location, for whoever is logged in (3.12 first: the
rem pipeline's packages are installed there), then whatever "python" / "py" is on PATH.
for %%V in (312 313 311 310) do if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (where py >nul 2>nul && set "PY=py -3")
if not defined PY (
  echo Python was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
