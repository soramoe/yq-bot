@echo off
rem Register two scheduled tasks for the current user:
rem   YuQing-Bot-Boot   at logon (30s delay)
rem   YuQing-Bot-Watch  every 5 minutes, starts the service if it is down
rem Both call scripts\autostart.bat, which respects logs\service.paused.
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%" || exit /b 1
set "WRAP=%ROOT%\scripts\autostart.bat"

if not exist "%WRAP%" (
  echo [FAIL] missing %WRAP%
  popd
  exit /b 1
)

schtasks /create /tn "YuQing-Bot-Boot" /tr "%WRAP%" /sc onlogon /delay 0000:30 /f
if errorlevel 1 (
  echo [FAIL] could not create YuQing-Bot-Boot
  popd
  exit /b 1
)

schtasks /create /tn "YuQing-Bot-Watch" /tr "%WRAP%" /sc minute /mo 5 /f
if errorlevel 1 (
  echo [FAIL] could not create YuQing-Bot-Watch
  popd
  exit /b 1
)

echo [OK] installed: YuQing-Bot-Boot, YuQing-Bot-Watch
popd
exit /b 0
