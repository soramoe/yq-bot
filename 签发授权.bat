@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [FAIL] 没找到 Node.js，请先安装 Node 22 或更新版本。
  pause
  exit /b 1
)
echo 正在打开授权签发台...
echo 只会监听本机 127.0.0.1:8910，签完直接关掉这个窗口即可。
node server\tools\license-studio.mjs
pause
