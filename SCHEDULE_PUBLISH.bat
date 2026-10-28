@echo off
title Trilens - schedule the Technical publish
cd /d "%~dp0"
rem Runs PUBLISH.bat every day at 08:30 and 20:30 (this PC's clock), after your 07:00 and 19:00 scans have finished.
schtasks /Create /TN "Trilens_Publish_AM" /SC DAILY /ST 08:30 /TR "\"%~dp0PUBLISH.bat\" /quiet" /F
schtasks /Create /TN "Trilens_Publish_PM" /SC DAILY /ST 20:30 /TR "\"%~dp0PUBLISH.bat\" /quiet" /F
echo.
echo Done. To remove them later:  schtasks /Delete /TN Trilens_Publish_AM /F  and  schtasks /Delete /TN Trilens_Publish_PM /F
pause
