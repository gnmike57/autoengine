# Automation Engine — First-Run Setup Guide

This guide covers everything needed to get the engine running from a fresh clone.

---

## 1. Prerequisites

| Dependency | Version | Required For |
|---|---|---|
| **Node.js** | ≥ 22 | All backends |
| **npm** | ≥ 10 | Package install |
| **Python** | ≥ 3.11 | zendriver backend |
| **uv** | latest | zendriver Python env |
| **ffmpeg** | any | Video recording |
| **git** | any | Version control |

Install system dependencies (Ubuntu/Debian):
```bash
sudo apt-get install -y python3 python3-pip ffmpeg
pip3 install uv
```

Install system dependencies (macOS):
```bash
brew install python3 ffmpeg
pip3 install uv
```

---

## 2. Clone and Install

```bash
git clone git@github.com:gnmike57/automation-engine.git
cd automation-engine
npm install
```

> **Note:** `npm install` will automatically rebuild native bindings (`better-sqlite3`)
> for your Node version. If you upgrade Node later, run `npm rebuild` again.

---

## 3. Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in any values you need. The only required change for a basic run:

```env
BACKEND=camoufox        # or: cloakbrowser | zendriver | stealth | curl
PROXY_POOL=off          # or: 6 (Flame Sticky AU)
CONCURRENCY=4
RECORD_VIDEO=true
```

---

## 4. Backend-Specific Setup

### camoufox (default — recommended)
No extra setup. Camoufox is bundled via `camoufox-js` npm package.

```bash
# Verify it works:
node -e "require('camoufox-js'); console.log('camoufox OK')"
```

### cloakbrowser
Requires a CloakBrowser API key. Add to `.env`:
```env
CLOAKBROWSER_API_KEY=your_api_key_here
```

### zendriver
Requires Python + uv. The engine launches zendriver via `uv run` automatically.

```bash
# Verify uv is installed:
uv --version

# Verify zendriver can be fetched:
uv run --with zendriver python -c "import zendriver; print('zendriver OK')"
```

### curl (no browser)
No extra setup. Uses the system `curl` binary via Node child_process.

---

## 5. Credentials

Place your credentials CSV in `credentials/credentials.csv`:

```csv
email,password1,password2,password3
user@example.com,pass1,pass2,pass3
```

Or upload via the dashboard at `http://localhost:3000` after starting the server.

---

## 6. Start the Engine

### Dashboard (recommended)
```bash
npm run dev
# Opens dashboard at http://localhost:3000
```

### CLI (headless)
```bash
npm run start:batch
```

### With PM2 (production — persistent across reboots)
```bash
npm install -g pm2
pm2 start npm --name "automation-engine" -- run dev
pm2 save
pm2 startup
```

---

## 7. Verify the Installation

```bash
# Run the full test suite (should pass 1343+ tests):
npm test

# Run TypeScript type check:
npx tsc --noEmit

# Run lint:
npx eslint src/ backends/ tests/ --max-warnings=9999
```

---

## 8. Troubleshooting

### `better-sqlite3` binding error on startup
```bash
npm rebuild better-sqlite3
```

### camoufox crashes with SIGABRT on macOS
This is a known macOS sandbox issue. Use `zendriver` or `cloakbrowser` as the backend instead, or run on Linux/Docker.

### `uv: command not found` when using zendriver
```bash
pip3 install uv
# or: curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Port 3000 already in use
```bash
PORT=3001 npm run dev
```
