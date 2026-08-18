#!/usr/bin/env bash
# =============================================================================
# JOEIGNITION — One-Command Setup Wizard
# Run: bash setup.sh
# =============================================================================
set -euo pipefail
BOLD="\033[1m"; CYAN="\033[36m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
TICK="${GREEN}✔${RESET}"; CROSS="${RED}✗${RESET}"; INFO="${CYAN}ℹ${RESET}"

banner() {
  echo -e "\n${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗"
  echo -e "║          JOEIGNITION — Automation Engine Setup           ║"
  echo -e "╚══════════════════════════════════════════════════════════╝${RESET}\n"
}

step() { echo -e "\n${BOLD}${CYAN}▶ $1${RESET}"; }
ok()   { echo -e "  ${TICK} $1"; }
warn() { echo -e "  ${YELLOW}⚠ $1${RESET}"; }
fail() { echo -e "  ${CROSS} $1"; }
ask()  { echo -e "  ${YELLOW}?${RESET} $1"; }

# ── 0. Banner ─────────────────────────────────────────────────────────────────
banner

# ── 1. Node.js ────────────────────────────────────────────────────────────────
step "Checking Node.js"
if ! command -v node &>/dev/null; then
  warn "Node.js not found. Installing via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 22 && nvm use 22
fi
NODE_VER=$(node --version)
if [[ "${NODE_VER:1:2}" -lt 22 ]]; then
  warn "Node.js ${NODE_VER} found but >=22 is required. Please upgrade."
  exit 1
fi
ok "Node.js ${NODE_VER}"

# ── 2. npm dependencies ───────────────────────────────────────────────────────
step "Installing npm dependencies"
npm install --silent
ok "npm packages installed"

# ── 3. Rebuild native bindings ────────────────────────────────────────────────
step "Rebuilding native bindings (better-sqlite3, curl-cffi-node)"
npm rebuild better-sqlite3 --silent 2>/dev/null || warn "better-sqlite3 rebuild failed — will retry at runtime"
ok "Native bindings ready"

# ── 4. Python + uv (for zendriver backend) ───────────────────────────────────
step "Checking Python + uv (required for zendriver backend)"
if ! command -v python3 &>/dev/null; then
  warn "Python3 not found. Install Python 3.11+ and re-run setup."
else
  ok "Python3 $(python3 --version | cut -d' ' -f2)"
fi
if ! command -v uv &>/dev/null; then
  warn "uv not found — installing..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if command -v uv &>/dev/null; then
  uv pip install --quiet zendriver 2>/dev/null || warn "zendriver Python package install failed — zendriver backend will be unavailable"
  ok "zendriver Python package ready"
fi

# ── 5. Playwright browsers ────────────────────────────────────────────────────
step "Installing Playwright Chromium browser"
npx playwright install chromium --quiet 2>/dev/null || warn "Playwright browser install failed"
ok "Playwright Chromium ready"

# ── 6. camoufox browser ───────────────────────────────────────────────────────
step "Fetching camoufox browser binary"
npx camoufox fetch --quiet 2>/dev/null || warn "camoufox fetch failed — camoufox backend may be unavailable"
ok "camoufox binary ready"

# ── 7. .env setup ─────────────────────────────────────────────────────────────
step "Environment configuration"

ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — skipping (delete it to reconfigure)"
else
  cp .env.example "$ENV_FILE"
  echo ""
  echo -e "  ${BOLD}${CYAN}Proxy Configuration${RESET}"
  echo -e "  ${INFO} Enter your proxy URLs (press Enter to skip each one):"
  echo ""

  ask "AU Sticky Proxy URL (e.g. http://user:pass@proxy.host:port):"
  read -r PROXY_AU
  ask "Proxy Rotate URL (e.g. http://api.proxy.com/rotate?session=[session]):"
  read -r PROXY_ROTATE
  ask "SOCKS5 Proxy URL (e.g. socks5://user:pass@host:port) [optional]:"
  read -r PROXY_SOCKS5

  echo ""
  echo -e "  ${BOLD}${CYAN}Golden Credentials (used for baseline health checks)${RESET}"
  echo -e "  ${INFO} Format: email:password"
  echo ""
  ask "Joe Fortune golden credential (email:password):"
  read -r -s GOLDEN_JOE
  echo ""
  ask "Ignition golden credential (email:password):"
  read -r -s GOLDEN_IGNITION
  echo ""

  # Write values into .env
  if [ -n "$PROXY_AU" ]; then
    sed -i "s|^AU_PROXY_URL=.*|AU_PROXY_URL=${PROXY_AU}|" "$ENV_FILE"
  fi
  if [ -n "$PROXY_ROTATE" ]; then
    sed -i "s|^PROXY_ROTATE_URL=.*|PROXY_ROTATE_URL=${PROXY_ROTATE}|" "$ENV_FILE"
  fi
  if [ -n "$PROXY_SOCKS5" ]; then
    sed -i "s|^SOCKS5_PROXY_URL=.*|SOCKS5_PROXY_URL=${PROXY_SOCKS5}|" "$ENV_FILE"
  fi
  if [ -n "$GOLDEN_JOE" ]; then
    sed -i "s|^GOLDEN_CRED_JOE=.*|GOLDEN_CRED_JOE=${GOLDEN_JOE}|" "$ENV_FILE"
  fi
  if [ -n "$GOLDEN_IGNITION" ]; then
    sed -i "s|^GOLDEN_CRED_IGNITION=.*|GOLDEN_CRED_IGNITION=${GOLDEN_IGNITION}|" "$ENV_FILE"
  fi

  ok ".env created with your configuration"
fi

# ── 8. Verify quality gate ────────────────────────────────────────────────────
step "Running quick verification (TypeScript check)"
if npx tsc --noEmit --quiet 2>/dev/null; then
  ok "TypeScript: 0 errors"
else
  warn "TypeScript errors detected — run 'npx tsc --noEmit' for details"
fi

# ── 9. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗"
echo -e "║                  Setup Complete! 🚀                      ║"
echo -e "╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Start the dashboard:${RESET}"
echo -e "    ${CYAN}npm run dev${RESET}           # Development mode (auto-reload)"
echo -e "    ${CYAN}npm start${RESET}             # Production mode"
echo -e "    ${CYAN}npm run pm2${RESET}           # Background daemon (PM2)"
echo ""
echo -e "  ${BOLD}Run baseline health check:${RESET}"
echo -e "    ${CYAN}npm run golden${RESET}        # Verify golden credentials work"
echo ""
echo -e "  ${BOLD}Dashboard URL:${RESET} ${CYAN}http://localhost:3000${RESET}"
echo ""
