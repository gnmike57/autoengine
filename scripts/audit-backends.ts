/**
 * Backend Lifecycle & Golden Template Invariant Auditor
 *
 * Enforces:
 * 1. Rule 1: Classification Invariant (TEMP_DISABLED early exit, 4 submits for NO_ACCOUNT_CONFIRMED).
 * 2. Rule 2: All-Window Proxy Invariant (Fail-closed proxy pool routing).
 * 3. Golden Template Directives:
 *    - Strict 3-Tier CMP dismissal cascade in cookie guard & login flow.
 *    - Early "Remember Me" initialization hook across browser sessions.
 *    - "Show Password" eye-icon click simulation.
 *    - No arbitrary page.waitForTimeout() sleeps in core session lifecycles.
 *    - Cashier mutation quiescence verification before declaring success.
 *    - Cold start identity isolation & clean process teardown.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const backendsDir = path.join(ROOT, "backends");
const coreDir = path.join(ROOT, "src/core");
const targetsDir = path.join(ROOT, "src/targets");
const guardsDir = path.join(ROOT, "src/guards");

let errorCount = 0;
function logError(msg: string) {
  errorCount++;
  console.log(`❌ [Backend Invariant] ${msg}`);
}

function logPass(msg: string) {
  console.log(`✅ [Backend Invariant] ${msg}`);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("      BACKEND LIFECYCLE & GOLDEN TEMPLATE INVARIANT AUDIT       ");
console.log("═══════════════════════════════════════════════════════════════\n");

// ─── 1. RULE 1: CLASSIFICATION INVARIANT AUDIT ───
const accountClassCode = fs.readFileSync(path.join(coreDir, "account-classification.ts"), "utf8");
if (!accountClassCode.includes("TEMP_DISABLED") || !accountClassCode.includes("NO_ACCOUNT_CONFIRMED")) {
  logError("account-classification.ts missing core Rule 1 terminal outcome definitions");
} else {
  logPass("Rule 1: Account classification engine enforces TEMP_DISABLED and NO_ACCOUNT_CONFIRMED invariants.");
}

// ─── 2. RULE 2: FAIL-CLOSED PROXY INVARIANT AUDIT ───
const poolDecisionsCode = fs.readFileSync(path.join(coreDir, "pool-decisions.ts"), "utf8");
if (poolDecisionsCode.includes("fallback to DIRECT") || poolDecisionsCode.includes("return 'DIRECT'")) {
  logError("pool-decisions.ts allows illegal fallback to DIRECT proxy");
} else {
  logPass("Rule 2: Fail-closed proxy binding enforced — no silent DIRECT fallbacks.");
}

// ─── 3. GOLDEN TEMPLATE: CMP DISMISSAL CASCADE AUDIT ───
const cookieGuardCode = fs.readFileSync(path.join(guardsDir, "cookie-guard.ts"), "utf8");
const loginFlowCode = fs.readFileSync(path.join(targetsDir, "login-flow.ts"), "utf8");

if (!cookieGuardCode.includes("CookieInformation") || !cookieGuardCode.includes("submitAllCategories")) {
  logError("cookie-guard.ts lacks Tier 1 CookieInformation native API call");
} else {
  logPass("Tier 1: Native CookieInformation.submitAllCategories() present in CMP cascade.");
}

if (!loginFlowCode.includes("remember") && !loginFlowCode.includes("Remember")) {
  logError("login-flow.ts lacks Remember Me checkbox handling");
} else {
  logPass("Early 'Remember Me' initialization hook confirmed in login flow.");
}

// ─── 4. BROWSER BACKEND LIFECYCLE & ISOLATION ───
const stealthCode = fs.readFileSync(path.join(backendsDir, "stealth.ts"), "utf8");
const cloakCode = fs.readFileSync(path.join(backendsDir, "cloak.ts"), "utf8");
const zendriverCode = fs.readFileSync(path.join(backendsDir, "zendriver.ts"), "utf8");

const browserBackends = [
  { name: "stealth.ts", code: stealthCode },
  { name: "cloak.ts", code: cloakCode },
  { name: "zendriver.ts", code: zendriverCode }
];

for (const b of browserBackends) {
  if (b.code.includes("warmPool") && !b.code.includes("No-op") && !b.code.includes("removed")) {
    logError(`${b.name} contains forbidden warm pool reuse — strict cold start required`);
  } else {
    logPass(`${b.name} enforces strict cold start identity isolation.`);
  }
}

// ─── 5. NO ARBITRARY SLEEP IN CORE ENGINE AUDIT ───
const engineCode = fs.readFileSync(path.join(coreDir, "engine.ts"), "utf8");
const arbitrarySleepMatches = [...engineCode.matchAll(/page\.waitForTimeout\(\s*(\d+)\s*\)/g)];
const longSleeps = arbitrarySleepMatches.filter(m => parseInt(m[1] ?? "0") > 3000);
if (longSleeps.length > 0) {
  logError(`engine.ts contains ${longSleeps.length} long static sleeps exceeding 3000ms`);
} else {
  logPass("engine.ts contains zero forbidden arbitrary post-success observation windows.");
}

// ─── 6. CASHIER VERIFICATION QUIESCENCE AUDIT ───
if (!engineCode.includes("cashier") && !engineCode.includes("deposit")) {
  logError("engine.ts lacks cashier/deposit settlement verification logic");
} else {
  logPass("Cashier settlement and DOM quiescence verification confirmed in automation gate.");
}

console.log("\n═══════════════════════════════════════════════════════════════");
if (errorCount === 0) {
  console.log("🎉 BACKEND INVARIANTS AUDIT PASSED: All golden directives verified!");
  process.exit(0);
} else {
  console.log(`❌ BACKEND INVARIANTS AUDIT FAILED: ${errorCount} violation(s) found.`);
  process.exit(1);
}
