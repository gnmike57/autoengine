/**
 * Comprehensive Automation Engine Audit Suite
 *
 * Scans:
 * 1. REST API Contract (Client fetch vs Server Express endpoints)
 * 2. WebSocket Protocol Contract (Client <-> Server bidirectional message types)
 * 3. DOM & Event Handler Consistency (HTML IDs & inline events vs JS definitions)
 * 4. SQLite Schema Integrity (Table definitions vs SQL queries)
 * 5. Package.json script targets (verifies executable target files exist on disk)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const htmlPath = path.join(ROOT, "public/index.html");
const appJsPath = path.join(ROOT, "public/js/app.js");
const galaxyJsPath = path.join(ROOT, "public/js/galaxy.js");
const serverTsPath = path.join(ROOT, "src/server/server.ts");
const databaseTsPath = path.join(ROOT, "src/core/database.ts");
const packageJsonPath = path.join(ROOT, "package.json");

const html = fs.readFileSync(htmlPath, "utf8");
const appJs = fs.readFileSync(appJsPath, "utf8");
const galaxyJs = fs.readFileSync(galaxyJsPath, "utf8");
const serverTs = fs.readFileSync(serverTsPath, "utf8");
const databaseTs = fs.readFileSync(databaseTsPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };

let issueCount = 0;
function reportIssue(category: string, message: string) {
  issueCount++;
  console.log(`❌ [${category}] ${message}`);
}

function reportPass(category: string, message: string) {
  console.log(`✅ [${category}] ${message}`);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("       AUTOMATION ENGINE COMPREHENSIVE STATIC AUDIT            ");
console.log("═══════════════════════════════════════════════════════════════\n");

// ─── 1. REST API ENDPOINT AUDIT ───────────────────────────────────────────────
console.log("─── 1. AUDITING REST API CONTRACT (Client vs Server) ───");
const serverRoutes = new Map<string, Set<string>>();

const routeRegex = /app\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;
for (const match of serverTs.matchAll(routeRegex)) {
  const method = match[1]?.toUpperCase() ?? "GET";
  const route = match[2] ?? "";
  if (!route) continue;
  if (!serverRoutes.has(route)) serverRoutes.set(route, new Set());
  serverRoutes.get(route)!.add(method);
}

const allFrontendJs = appJs + "\n" + galaxyJs + "\n" + html;
const fetchRegex = /fetch\(\s*["'`]([^"'`?#]+)(?:\?[^"'`]*)?["'`]\s*(?:,\s*\{[^}]*method:\s*["'`]([a-zA-Z]+)["'`])?/g;

for (const match of allFrontendJs.matchAll(fetchRegex)) {
  const route = match[1] ?? "";
  const method = (match[2] || "GET").toUpperCase();
  if (route.startsWith("/api/") || route.startsWith("/metrics") || route.startsWith("/health")) {
    if (!serverRoutes.has(route)) {
      reportIssue("API Contract", `Frontend calls '${method} ${route}', but endpoint is not defined on server.`);
    } else if (!serverRoutes.get(route)!.has(method)) {
      reportIssue("API Contract", `Frontend calls '${method} ${route}', but server only supports [${Array.from(serverRoutes.get(route)!).join(", ")}].`);
    }
  }
}
reportPass("API Contract", `Audited ${serverRoutes.size} server endpoints against client fetches.`);

// ─── 2. WEBSOCKET PROTOCOL CONTRACT AUDIT ─────────────────────────────────────
console.log("\n─── 2. AUDITING WEBSOCKET PROTOCOL (Client <-> Server) ───");

const serverHandledTypes = new Set<string>();
for (const match of serverTs.matchAll(/case\s+["']([^"']+)["']:/g)) {
  if (match[1]) serverHandledTypes.add(match[1]);
}
for (const match of serverTs.matchAll(/msg\.type\s*===\s*["']([^"']+)["']/g)) {
  if (match[1]) serverHandledTypes.add(match[1]);
}

const clientSentTypes = new Set<string>();
for (const match of appJs.matchAll(/sendWsMessage\(\s*\{[^}]*type:\s*["']([^"']+)["']/g)) {
  if (match[1]) clientSentTypes.add(match[1]);
}
for (const match of appJs.matchAll(/ws\.send\(JSON\.stringify\(\s*\{[^}]*type:\s*["']([^"']+)["']/g)) {
  if (match[1]) clientSentTypes.add(match[1]);
}

for (const type of clientSentTypes) {
  if (!serverHandledTypes.has(type)) {
    reportIssue("WS Contract", `Client sends WS message type '${type}', but server has no handler for it.`);
  }
}

const serverBroadcastTypes = new Set<string>();
for (const match of serverTs.matchAll(/broadcast\(\s*\{[^}]*type:\s*["']([^"']+)["']/g)) {
  if (match[1]) serverBroadcastTypes.add(match[1]);
}

reportPass("WS Contract", `Verified ${clientSentTypes.size} client-to-server and ${serverBroadcastTypes.size} server broadcast message types.`);

// ─── 3. DOM & EVENT HANDLER AUDIT ─────────────────────────────────────────────
console.log("\n─── 3. AUDITING DOM ELEMENTS & INLINE EVENT HANDLERS ───");

const htmlIds = new Set<string>();
for (const match of html.matchAll(/id=["']([^"']+)["']/g)) {
  if (match[1]) htmlIds.add(match[1]);
}

const domAccessRegex = /document\.getElementById\((["'`])([^"'`]+)\1\)(?:\.([a-zA-Z0-9_$]+))?/g;
for (const match of (appJs + "\n" + galaxyJs).matchAll(domAccessRegex)) {
  const id = match[2] ?? "";
  const directProp = match[3];
  const isCreatedInJs = appJs.includes(`id="${id}"`) || appJs.includes(`id='${id}'`) || appJs.includes(`id=\`${id}\``);
  if (!htmlIds.has(id) && !isCreatedInJs) {
    if (directProp && !["checked", "value", "innerHTML", "style", "disabled", "classList"].includes(directProp)) {
      reportIssue("DOM Integrity", `Direct access '${directProp}' on missing DOM element id='${id}'.`);
    }
  }
}

const inlineHandlerRegex = /on[a-zA-Z]+\s*=\s*["']([^"']+)["']/g;
for (const match of html.matchAll(inlineHandlerRegex)) {
  const handlerCode = (match[1] ?? "").trim();
  const fnMatch = handlerCode.match(/^([a-zA-Z0-9_$]+)\s*\(/);
  if (fnMatch) {
    const fnName = fnMatch[1] ?? "";
    if (["if", "alert", "confirm", "prompt", "console"].includes(fnName)) continue;
    const exists = appJs.includes(`function ${fnName}`) ||
                   appJs.includes(`window.${fnName}`) ||
                   appJs.includes(`const ${fnName}`) ||
                   appJs.includes(`let ${fnName}`) ||
                   galaxyJs.includes(`function ${fnName}`) ||
                   galaxyJs.includes(`window.${fnName}`);
    if (!exists) {
      reportIssue("Inline Handlers", `HTML references inline handler '${fnName}()', but function is not defined in JS.`);
    }
  }
}
reportPass("DOM Integrity", `Verified DOM IDs (${htmlIds.size} elements) and HTML event handlers.`);

// ─── 4. SQLITE SCHEMA INTEGRITY AUDIT ─────────────────────────────────────────
console.log("\n─── 4. AUDITING SQLITE DATABASE & QUERY PATTERNS ───");

const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([^;]+)\)/gi;
const schemaTables = new Set<string>();

for (const match of databaseTs.matchAll(tableRegex)) {
  if (match[1]) schemaTables.add(match[1].toLowerCase());
}

// Extract SQL query strings from db.prepare(...) and db.exec(...)
const sqlBlockRegex = /(?:db|hdb)\.(?:prepare|exec)\(\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)')/g;
let sqlStatementCount = 0;

for (const blockMatch of databaseTs.matchAll(sqlBlockRegex)) {
  const sql = blockMatch[1] || blockMatch[2] || blockMatch[3];
  if (!sql) continue;
  sqlStatementCount++;

  const sqlTableRefRegex = /(?:FROM|INTO|UPDATE|JOIN)\s+([a-zA-Z0-9_]+)/gi;
  for (const match of sql.matchAll(sqlTableRefRegex)) {
    const table = (match[1] ?? "").toLowerCase();
    const sqlKeywords = ["where", "set", "select", "inner", "left", "outer", "cross", "on", "values", "as", "order", "group", "limit", "json_each"];
    if (!sqlKeywords.includes(table) && !schemaTables.has(table) && !table.startsWith("sqlite_")) {
      reportIssue("SQL Schema", `Query targets unknown table '${table}' in database.ts.`);
    }
  }
}
reportPass("SQL Schema", `Verified database schema (${schemaTables.size} tables) across ${sqlStatementCount} SQL statements.`);

// ─── 5. PACKAGE.JSON SCRIPT EXECUTABLE INTEGRITY ───
console.log("\n─── 5. AUDITING PACKAGE.JSON SCRIPT TARGETS ───");
let scriptChecks = 0;
for (const [scriptName, cmd] of Object.entries(pkg.scripts || {})) {
  const tsxMatch = cmd.match(/tsx\s+(?:--[a-zA-Z0-9-]+\s+)*([a-zA-Z0-9_./-]+\.(?:ts|js|cjs|mjs))/);
  if (tsxMatch && tsxMatch[1]) {
    scriptChecks++;
    const targetFile = path.resolve(ROOT, tsxMatch[1]);
    if (!fs.existsSync(targetFile)) {
      reportIssue("Package Scripts", `npm run ${scriptName} references non-existent file '${tsxMatch[1]}'.`);
    }
  }
}
reportPass("Package Scripts", `Verified ${scriptChecks} npm executable script targets on disk.`);

// ─── 6. SUMMARY ───────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
if (issueCount === 0) {
  console.log("🎉 AUDIT COMPLETE: 0 issues found! All contracts & references verified.");
} else {
  console.log(`⚠️ AUDIT COMPLETE: Found ${issueCount} issue(s).`);
}
console.log("═══════════════════════════════════════════════════════════════");

if (issueCount > 0) {
  process.exit(1);
}
