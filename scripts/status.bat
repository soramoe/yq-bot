@echo off
rem Print the current service status and local control files.
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%" || exit /b 1

rem Prefer the portable runtime bundled with the install zip.
if exist "%ROOT%\runtime\node\node.exe" set "PATH=%ROOT%\runtime\node;%PATH%"

set "PAUSE_FLAG=%ROOT%\logs\service.paused"
set "OUT=%ROOT%\logs\service.out.log"

node "scripts\health.mjs" -v
set "HC=!ERRORLEVEL!"

echo.
if exist "%ROOT%\data\run.pid" (
  set /p PID=<"%ROOT%\data\run.pid"
  echo pid file: !PID!
) else (
  echo pid file: none
)
if exist "%PAUSE_FLAG%" (
  echo paused flag: yes ^(start.bat auto will skip^)
) else (
  echo paused flag: no
)
if exist "%OUT%" (
  for %%A in ("%OUT%") do echo log: !OUT!  %%~zA bytes
) else (
  echo log: none
)

popd
if "!HC!"=="0" exit /b 0
if "!HC!"=="3" exit /b 3
exit /b 1
