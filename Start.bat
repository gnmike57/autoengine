@echo off
setlocal
echo Starting Automati1-111 Setup...

:: Check if Node.js is installed
node -v >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in your PATH.
    echo Please install Node.js ^(v20 or higher recommended^) from https://nodejs.org/
    echo Once installed, run this script again.
    pause
    exit /b
)

:: Check if node_modules exists, if not install dependencies
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Installing dependencies...
    echo This may take a few minutes depending on your internet connection.
    call npm install
    
    echo [INFO] Installing Playwright and required browsers...
    call npx playwright install chromium
) else (
    echo [INFO] Dependencies are already installed.
)

:: Check for .env file, create from example if missing
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env file not found. Creating one from .env.example...
        copy .env.example .env
    )
)

echo [INFO] Starting the application...
call npm run gui
pause
