---
name: full-system-audit
description: Executes comprehensive multi-layer static analysis, frontend AST/DOM verification, Hermes AI health checks, backend invariant validation, and contract integrity sweeps.
---

# Full System Audit Skill

This skill provides an automated, multi-tiered verification and diagnostic framework across the entire engine codebase.

## Audit Layers

1. **Frontend AST & DOM Integrity (`npm run audit:frontend`)**:
   - Parses `public/js/app.js` and `public/js/galaxy.js` using TypeScript Compiler AST.
   - Audits all scope chains, destructured variables, and identifier declarations.
   - Validates all `document.getElementById(...)` queries against `public/index.html`.
   - Audits all inline HTML event handlers (`onclick`, `onchange`, etc.) to prevent runtime `ReferenceError`s.

2. **Hermes AI Subsystem & Database Health (`npm run audit:hermes`)**:
   - Verifies the availability and exports across all 22 Hermes AI modules.
   - Tests SQLite schema initialization and table generation for `hermes-learning.db` (`decision_journal`, `healing_actions`, `selector_cache`).
   - Audits LLM provider fallback cascades and JSON response safety.

3. **Backend Lifecycle & Golden Template Invariant Auditor (`npm run audit:backends`)**:
   - **Rule 1 (Classification)**: Validates `TEMP_DISABLED` signal prioritization and 4-submit envelope requirement for `NO_ACCOUNT_CONFIRMED`.
   - **Rule 2 (Proxy Invariant)**: Enforces fail-closed proxy routing with zero silent `DIRECT` fallbacks.
   - **Golden Template Directives**: Validates 3-tier CMP dismissal cascade, early "Remember Me" hooks, password visibility eye clicks, zero post-success observation delays, and cashier mutation quiescence settlement.

4. **API, WebSocket & Database Contracts (`npm run audit`)**:
   - Audits 23 REST endpoints and 80+ bidirectional WebSocket message types between server and client.
   - Validates SQL query statements against active SQLite table schemas.
   - Verifies all 29 npm script targets on disk.

5. **Master Verification Suite (`npm run audit:all`)**:
   - Executes all 5 audit layers in a unified sequence and outputs an aggregated health summary.

## Usage

```bash
# Run all audit layers
npm run audit:all

# Run full test suite
npx vitest run
```
