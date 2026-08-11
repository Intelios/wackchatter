@echo off
rem WackChatter launcher (Windows).
rem
rem     git clone https://github.com/Intelios/wackchatter.git
rem     cd wackchatter
rem     Start.bat
rem
rem Updating is `git pull` and then this again - or Update.bat, which does both.
rem
rem Dependencies and the frontend bundle are refreshed on every launch. Both finish in
rem well under a second when nothing changed, which is the point: there is no build step
rem left to forget after a pull, and no way to end up running a stale bundle.

setlocal
title WackChatter
pushd "%~dp0"

rem Bun's installer adds itself to PATH for new terminals only, so a fresh install can be
rem present and still invisible to `where`. Check the default location before giving up.
set "BUN=bun"
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
  ) else (
    echo.
    echo WackChatter runs on Bun, which is not installed. Install it with one of:
    echo.
    echo     powershell -c "irm bun.sh/install.ps1 ^| iex"
    echo     winget install Oven-sh.Bun
    echo.
    echo Then open a new terminal and run Start.bat again.
    echo.
    pause
    popd
    exit /b 1
  )
)

echo.
echo ==^> Installing dependencies
call "%BUN%" install || goto :failed

rem Deliberately `build:app` rather than `build`, which also runs `tsc --noEmit` and prints
rem the full asset table. A type error is a problem for whoever wrote it, not a reason to
rem refuse to launch the app for someone who only ran `git pull`. Build errors still stop us.
echo.
echo ==^> Building the app
call "%BUN%" run --silent build:app || goto :failed

echo.
echo ==^> Starting WackChatter
set NODE_ENV=production
call "%BUN%" run server/index.ts %*
popd
exit /b %errorlevel%

:failed
echo.
echo WackChatter could not start. The error above says why.
pause
popd
exit /b 1
