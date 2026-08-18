# Windows 11 Setup & Launch Guide

This document provides a comprehensive blueprint to configure, build, and run this automation suite on a **Windows 11** machine. It is designed to be fully readable and executable by both human developers and autonomous AI agents.

---

## 🛠️ Prerequisites

Before launching the suite, install the following core platform environments. 

### 1. Node.js (v22+ Recommended)
- **Install**: Run from PowerShell/Command Prompt:
  ```powershell
  winget install OpenJS.NodeJS
  ```
- **Verify**:
  ```powershell
  node --version
  npm --version
  ```

### 2. Rust (For Wicketkeeper PoW Solver compilation)
The Wicketkeeper challenge bypass solver relies on a natively compiled Rust binary.
- **Install**: Download and run the installer from [rustup.rs](https://rustup.rs/), or install via:
  ```powershell
  winget install Rustlang.Rustup
  ```
  *Make sure to install the C++ Build Tools when prompted by the Visual Studio Installer.*
- **Verify**:
  ```powershell
  cargo --version
  ```

### 3. Python (For AI coordinate-mapper / vision overrides)
- **Install**:
  ```powershell
  winget install Python.Python.3.11
  ```
- **Verify**:
  ```powershell
  python --version
  pip --version
  ```

### 4. FFmpeg (For video recording of browser sessions)
The session timeline tracer uses FFmpeg to compile screenshots into trace videos.
- **Install**:
  ```powershell
  winget install Gyan.FFmpeg
  ```
- **Verify**: Restart your terminal and run:
  ```powershell
  ffmpeg -version
  ```

---

## 🚀 Setup & Build Steps

Run the following commands in order inside the project workspace directory:

### 1. Install Project Dependencies & Playwright
```powershell
npm ci
npx playwright install chromium
```

### 2. Compile the Wicketkeeper PoW Solver Binary
Run the compilation inside the `pow-solver` subdirectory:
```powershell
cd pow-solver
cargo build --release
cd ..
```
This builds and places the native executable at:
`pow-solver/target/release/pow-solver.exe`

### 3. Setup Local Environment Variables
Create a local `.env` file copied from `.env.example`:
```powershell
copy .env.example .env
```
Open `.env` in a text editor and fill in the target API keys:
- `SPIDER_API_KEY`: Key for proxy/browser extraction
- `GEMINI_API_KEY`: AI visual verification models
- `PRIMARY_PROXY_URL`: Proxy forwarding configuration

---

## ⚙️ Running the Suite

You can execute the automation engine in two different modes on Windows 11:

### A. Dashboard/GUI Mode (Headed Interactive)
Runs the dashboard server on `http://localhost:3011` with headed browser windows tiled on your screens.
- **Batch Script Launch**:
  Double-click `Start.bat` in the root folder, or execute:
  ```powershell
  .\Start.bat
  ```
- **NPM Script Launch**:
  ```powershell
  npm run gui
  ```

### B. Daemon Mode (24/7 Background Run)
Integrates with **PM2** to run the credential processor continuously as a Windows Service.
- **Install and Register**:
  Open PowerShell as **Administrator** and execute:
  ```powershell
  npm run daemon:install
  ```
  *This script installs PM2, sets up the `pm2-windows-startup` service, loads `ecosystem.config.cjs`, and saves the run registry.*
- **Management Commands**:
  - Check daemon status: `pm2 status`
  - View running logs: `pm2 logs`
  - Restart the workers: `pm2 restart all`
  - Terminate the daemon: `pm2 stop all`

---

## 🔍 Troubleshooting & Evasion Verification

### 1. Headed Grid Tiling fails to place windows
On Windows 11, the native C# `BrowserTiler` uses `node-window-manager` to manipulate coordinates. If Windows prevents window moves:
- Run the terminal hosting the script as Administrator.
- Avoid using the Virtual Desktops feature while running tests, as it confuses Windows monitor resolution indexes.

### 2. Playwright cannot launch Camoufox (Stealth Backend)
The stealth engine uses the Camoufox binary. If it fails to boot:
- Verify that your anti-virus (such as Windows Defender) hasn't sandboxed or blocked the temporary browser profile directories.
- Run `npm run clean:zombies` to clear any dead browser processes holding filesystem locks.
