@echo off
chcp 65001 >nul
title ChainVote - push to GitHub

echo ==========================================================
echo   ChainVote  -  push local repo to GitHub
echo ==========================================================
echo.

rem --- make sure git is reachable even if not on PATH ---
set "PATH=D:\Git\cmd;D:\Git\bin;C:\Program Files\Git\cmd;%PATH%"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found.
  echo         Expected at D:\Git\cmd\git.exe
  echo         Please check your Git for Windows install.
  echo.
  pause
  exit /b 1
)

if not exist "D:\chainvote-repo\.git" (
  echo [ERROR] D:\chainvote-repo\.git not found.
  echo         The prepared repo is missing. Tell the assistant.
  echo.
  pause
  exit /b 1
)

cd /d D:\chainvote-repo

echo [1/3] working directory:
cd
echo.
echo [2/3] remote:
git remote -v
echo.
echo [3/3] pushing to GitHub ...
echo      (a browser window may pop up asking you to sign in)
echo.

git push -u origin master
set RC=%ERRORLEVEL%
echo.

if "%RC%"=="0" goto ok
echo ==========================================================
echo   PUSH FAILED  (exit code %RC%)
echo   Select the text above with the mouse, copy it,
echo   and send it to the assistant.
echo ==========================================================
goto end

:ok
echo ==========================================================
echo   PUSH OK
echo   Opening the Actions page in your browser ...
echo ==========================================================
start "" "https://github.com/timje666/xukaidechangku/actions"

:end
echo.
echo Press any key to close this window.
pause >nul
