@echo off
rem Stop then start the service. This is a manual restart, so it
rem clears the pause flag written by stop.bat.
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%" || exit /b 1

call "scripts\stop.bat"
if errorlevel 1 (
  echo [WARN] stop reported a problem; trying to start anyway...
)
call "scripts\start.bat"
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
