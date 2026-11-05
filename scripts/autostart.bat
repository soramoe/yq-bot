@echo off
rem Wrapper used by the scheduled tasks. "auto" means: respect the pause
rem flag written by stop.bat, so a manual stop is not undone by a watchdog.
chcp 65001 >nul
call "%~dp0start.bat" auto
exit /b %ERRORLEVEL%
