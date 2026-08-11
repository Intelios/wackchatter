@echo off
rem Pull the latest WackChatter and start it (Windows).
rem
rem Nothing you own is touched: data\ is gitignored, so characters, chats, presets and
rem keys are invisible to git and survive every update.

setlocal
title WackChatter - Update
pushd "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo git is not installed, so there is nothing to update from.
  echo Install git, or download the latest release manually.
  echo.
  pause
  popd
  exit /b 1
)

rem Whatever this branch tracks - naming it beats guessing origin/main, which is wrong for
rem anyone following a different branch and produces advice that does the wrong thing.
set "UPSTREAM=origin/main"
for /f "delims=" %%u in ('git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2^>nul') do set "UPSTREAM=%%u"

echo.
echo ==^> Updating from %UPSTREAM%
rem --ff-only keeps this honest: with work of your own the pull stops rather than
rem inventing a merge commit on your behalf.
git pull --ff-only
if errorlevel 1 (
  echo.
  echo Could not fast-forward - this clone has diverged from %UPSTREAM%.
  echo.
  echo Uncommitted edits, set aside and restored:
  echo     git stash  ^&^&  Update.bat  ^&^&  git stash pop
  echo.
  echo Commits of your own, replayed on top of the update:
  echo     git pull --rebase  ^&^&  Start.bat
  echo.
  echo Or discard your changes and take the update as it is:
  echo     git reset --hard %UPSTREAM%
  echo.
  echo Your data folder survives all three - it is gitignored, so git cannot touch it.
  echo.
  pause
  popd
  exit /b 1
)

popd
call "%~dp0Start.bat" %*
