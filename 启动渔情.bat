@echo off
chcp 65001 >nul
rem Root shortcut: the real logic lives in scripts\, keep one copy only.
call "%~dp0scripts\start.bat" %*
