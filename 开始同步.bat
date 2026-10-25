@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KCB Sync Console

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [ERROR] Node.js not found in PATH.
    echo  Please install Node.js first: https://nodejs.org
    echo.
    pause
    exit /b 1
)

node console-server.js

if errorlevel 1 (
    echo.
    echo  Console exited with an error. See messages above.
    pause
)
