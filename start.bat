@echo off
REM ===========================================================================
REM  NEON BREACH - launcher (Windows)
REM  Double-click this file, or run it from a terminal.
REM  Any arguments are forwarded to tools/launch.mjs, e.g.
REM      start.bat --port 8080 --no-open
REM ===========================================================================
setlocal
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js was not found on PATH.
  echo       Install Node.js 18 or newer from https://nodejs.org/ and try again.
  echo.
  pause
  popd
  exit /b 1
)

node "tools\launch.mjs" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo   [!] Launcher exited with code %EXITCODE%.
  echo.
  pause
)

popd
exit /b %EXITCODE%
