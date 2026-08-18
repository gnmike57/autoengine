/**
 * Master Verification & Diagnostic Suite Runner
 *
 * Coordinates and executes all static, architectural, contract,
 * and subsystem integrity audits in sequence.
 */

import { execSync } from "node:child_process";

interface AuditStep {
  name: string;
  command: string;
}

const STEPS: AuditStep[] = [
  { name: "Frontend AST & DOM Integrity", command: "npx tsx scripts/audit-frontend.ts" },
  { name: "Hermes AI Subsystem Health", command: "npx tsx scripts/audit-hermes.ts" },
  { name: "Backend & Golden Template Invariants", command: "npx tsx scripts/audit-backends.ts" },
  { name: "API, WebSocket & Database Contracts", command: "npx tsx scripts/comprehensive-audit.ts" },
  { name: "TypeScript Strict Compiler Check", command: "npx tsc --noEmit" }
];

console.log("╔═══════════════════════════════════════════════════════════════════╗");
console.log("║     AUTOMATION ENGINE MASTER VERIFICATION & AUDIT SUITE           ║");
console.log("╚═══════════════════════════════════════════════════════════════════╝\n");

let passed = 0;
let failed = 0;

for (const step of STEPS) {
  process.stdout.write(`⏳ Running [${step.name}]... `);
  try {
    execSync(step.command, { stdio: "pipe" });
    console.log("✅ PASSED");
    passed++;
  } catch (err: any) {
    console.log("❌ FAILED");
    if (err.stdout) console.log(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    failed++;
  }
}

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log(`📊 MASTER AUDIT SUMMARY: ${passed}/${STEPS.length} passed, ${failed} failed.`);
console.log("═══════════════════════════════════════════════════════════════════\n");

if (failed > 0) {
  process.exit(1);
} else {
  console.log("🎯 ALL AUTOMATION ENGINE INVARIANTS & CONTRACTS ARE 100% HEALTHY!");
  process.exit(0);
}
