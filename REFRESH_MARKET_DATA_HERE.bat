@echo off
title Trilens - refresh market data from this PC
cd /d "%~dp0"
rem Backup route. Normally GitHub's free servers refresh prices, filings and sentiment for you.
rem If Yahoo ever blocks those servers, run this once a day instead: it fetches here and uploads the result.
call tools\_py.bat || exit /b 1
%PY% -m pip install --quiet --disable-pip-version-check -r pipeline\requirements.txt
%PY% tools\push_data.py %*
if /i "%~1"=="/quiet" exit /b %errorlevel%
echo.
pause
