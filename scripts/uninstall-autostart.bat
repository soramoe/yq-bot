@echo off
rem Remove the scheduled tasks created by install-autostart.bat.
chcp 65001 >nul
setlocal EnableExtensions
schtasks /delete /tn "YuQing-Bot-Boot" /f >nul 2>&1
if not errorlevel 1 echo [OK] removed YuQing-Bot-Boot
schtasks /delete /tn "YuQing-Bot-Watch" /f >nul 2>&1
if not errorlevel 1 echo [OK] removed YuQing-Bot-Watch
exit /b 0
