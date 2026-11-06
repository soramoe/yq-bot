@echo off
rem Download a portable Node.js runtime into runtime\node (Windows).
rem Usage: setup-node.bat [--force]
chcp 65001 >nul
setlocal EnableExtensions
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-node.ps1" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
