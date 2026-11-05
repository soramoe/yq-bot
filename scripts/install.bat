@echo off
rem ===========================================================
rem  YuQing Bilibili Live Assistant / one-click environment
rem  Checks Node.js, installs dependencies, creates runtime dirs.
rem  ASCII only: cmd.exe parses this file with the OEM code page.
rem ===========================================================
setlocal EnableExtensions
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%"

echo ===========================================================
echo   YuQing Bilibili Live Assistant - environment setup
echo   Folder: %ROOT%
echo ===========================================================

where node >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Node.js was not found.
  echo        Install Node.js 22 LTS or newer from https://nodejs.org/
  echo        Then run this file again.
  start "" "https://nodejs.org/en/download"
  popd
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
echo [OK] Node.js found: v%NODE_MAJOR%
if %NODE_MAJOR% LSS 22 (
  echo [FAIL] Node.js 22 or newer is required. Please upgrade first.
  popd
  exit /b 1
)

if not exist "logs" md "logs"
if not exist "data" md "data"
echo [OK] Runtime folders are ready: logs\, data\

echo.
node -e "require('ws')" >nul 2>&1
if not errorlevel 1 (
  echo [OK] ws is bundled; skipping npm install.
  goto :DEPS_OK
)

echo [STEP] Installing dependencies ^(only ws^)...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo [FAIL] npm install failed. Check the network or run: npm install
  popd
  exit /b 1
)

node -e "require('ws'); console.log('[OK] ws module is available')"
if errorlevel 1 (
  echo [FAIL] ws module is still missing after npm install.
  popd
  exit /b 1
)

:DEPS_OK
echo.
echo [DONE] Environment is ready.
echo        Start:  scripts\start.bat
echo        Status: scripts\status.bat
echo        Stop:   scripts\stop.bat
popd
exit /b 0
