# Automati Daemon Installer (Windows PowerShell)
# Installs PM2, registers startup hook, and starts all daemon processes.

$ErrorActionPreference = "Stop"

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  Automati 24/7 Daemon Installer" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Node.js version
Write-Host "[1/6] Checking Node.js version..." -ForegroundColor Yellow
$nodeVersion = (node --version 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Node.js not found. Install Node.js v22+ first." -ForegroundColor Red
    exit 1
}
Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green

# 2. Install PM2 globally if not present
Write-Host "[2/6] Checking PM2..." -ForegroundColor Yellow
$pm2Version = $null
try {
    $pm2Version = (pm2 --version 2>&1)
} catch { }

if (-not $pm2Version -or $LASTEXITCODE -ne 0) {
    Write-Host "  Installing PM2 globally..." -ForegroundColor Yellow
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to install PM2." -ForegroundColor Red
        exit 1
    }
    # Install PM2 Windows startup module
    npm install -g pm2-windows-startup
    pm2-startup install
} else {
    Write-Host "  PM2 already installed: v$pm2Version" -ForegroundColor Green
}

# 3. Install pm2-windows-service for auto-start
Write-Host "[3/6] Registering PM2 startup hook..." -ForegroundColor Yellow
try {
    pm2-startup install 2>&1 | Out-Null
    Write-Host "  PM2 startup hook registered" -ForegroundColor Green
} catch {
    Write-Host "  Note: pm2-windows-startup may need admin. Run as Administrator if needed." -ForegroundColor Yellow
}

# 4. Create logs directory
Write-Host "[4/6] Creating logs directory..." -ForegroundColor Yellow
$logsDir = Join-Path $PSScriptRoot ".." "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}
Write-Host "  Logs directory: $logsDir" -ForegroundColor Green

# 5. Check for OpenClaw
Write-Host "[5/6] Checking OpenClaw..." -ForegroundColor Yellow
$openclawVersion = $null
try {
    $openclawVersion = (openclaw --version 2>&1)
} catch { }

if (-not $openclawVersion -or $LASTEXITCODE -ne 0) {
    Write-Host "  OpenClaw not found. Install with: npm install -g openclaw" -ForegroundColor Yellow
    Write-Host "  The daemon will start without OpenClaw for now." -ForegroundColor Yellow
} else {
    Write-Host "  OpenClaw: $openclawVersion" -ForegroundColor Green
}

# 6. Start the ecosystem
Write-Host "[6/6] Starting daemon processes..." -ForegroundColor Yellow
$ecosystemPath = Join-Path $PSScriptRoot ".." "ecosystem.config.cjs"

Set-Location (Join-Path $PSScriptRoot "..")
pm2 start $ecosystemPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to start PM2 ecosystem." -ForegroundColor Red
    exit 1
}

# Save the PM2 process list for auto-restart on reboot
pm2 save

Write-Host ""
Write-Host "===================================" -ForegroundColor Green
Write-Host "  Daemon Started Successfully!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Green
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Cyan
Write-Host "  pm2 status          - View process status" -ForegroundColor White
Write-Host "  pm2 logs            - Stream all logs" -ForegroundColor White
Write-Host "  pm2 logs automati   - Stream server logs" -ForegroundColor White
Write-Host "  pm2 restart all     - Restart all processes" -ForegroundColor White
Write-Host "  pm2 stop all        - Stop all processes" -ForegroundColor White
Write-Host "  pm2 monit           - Interactive monitoring" -ForegroundColor White
Write-Host ""
