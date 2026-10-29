@echo off
title Trilens - schedule the market-data backup refresh
cd /d "%~dp0"
rem Runs REFRESH_MARKET_DATA_HERE.bat once a day at 21:00 (this PC's clock), after both markets have closed.
rem This is the backup route: GitHub's free servers already refresh data on their own schedule all day.
rem Running this too just gives you a daily safety net from your own PC in case Yahoo ever blocks GitHub's servers.
schtasks /Create /TN "Trilens_Refresh_Backup" /SC DAILY /ST 21:00 /TR "\"%~dp0REFRESH_MARKET_DATA_HERE.bat\" /quiet" /F
echo.
echo Done. To remove it later:  schtasks /Delete /TN Trilens_Refresh_Backup /F
pause
