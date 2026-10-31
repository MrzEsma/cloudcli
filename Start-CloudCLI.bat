@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo [ERROR] runtime\node.exe not found. Re-extract the whole ZIP folder.
  pause
  exit /b 1
)
chcp 65001 >nul
title CloudCLI
"runtime\node.exe" "desktop\bootstrap.mjs"
echo.
echo CloudCLI stopped. You can close this window.
pause >nul
