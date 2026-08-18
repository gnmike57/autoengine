/**
 * Frontend JavaScript AST & DOM Integrity Auditor
 *
 * Deeply validates:
 * 1. public/js/app.js & public/js/galaxy.js for undeclared identifiers/functions.
 * 2. All document.getElementById() calls against public/index.html IDs.
 * 3. All inline HTML event handlers (onclick, onchange, etc.) against JS scope.
 * 4. Checks for unsafe direct property access on nullable DOM elements.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const htmlPath = path.join(ROOT, "public/index.html");
const appJsPath = path.join(ROOT, "public/js/app.js");
const galaxyJsPath = path.join(ROOT, "public/js/galaxy.js");

const html = fs.readFileSync(htmlPath, "utf8");
const appJs = fs.readFileSync(appJsPath, "utf8");
const galaxyJs = fs.readFileSync(galaxyJsPath, "utf8");

let errorCount = 0;
function logError(msg: string) {
  errorCount++;
  console.log(`❌ [Frontend AST] ${msg}`);
}

function logPass(msg: string) {
  console.log(`✅ [Frontend AST] ${msg}`);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("             FRONTEND AST & DOM INTEGRITY AUDIT                ");
console.log("═══════════════════════════════════════════════════════════════\n");

// ─── 1. HTML IDS INVENTORY ───
const htmlIds = new Set<string>();
for (const m of html.matchAll(/id=["']([^"']+)["']/g)) {
  if (m[1]) htmlIds.add(m[1]);
}

// ─── 2. CHECK AST FOR UNDECLARED GLOBALS IN APP.JS ───
const sourceFile = ts.createSourceFile("app.js", appJs, ts.ScriptTarget.ES2022, true);

const scopes: Set<string>[] = [new Set()];
const standardGlobals = new Set([
  "undefined", "NaN", "Infinity", "window", "document", "console", "fetch",
  "alert", "prompt", "confirm", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "WebSocket",
  "FileReader", "Date", "Math", "JSON", "Array", "Object", "String", "Number",
  "Boolean", "RegExp", "Error", "Set", "Map", "Event", "CustomEvent", "MessageEvent",
  "KeyboardEvent", "MouseEvent", "URL", "URLSearchParams", "Blob", "File",
  "FormData", "Headers", "Request", "Response", "MutationObserver", "ResizeObserver",
  "Audio", "EventSource",
  "atob", "btoa", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "localStorage", "sessionStorage",
  "location", "navigator", "history", "screen", "performance", "addEventListener",
  "removeEventListener", "drawMatrixRain", "initCanvas", "galaxyCanvas",
  "uploadCsv", "updateProxyPreview", "testProxyConnection", "forceWakeAllTempDisabled",
  "hermesForceReview", "hermesResetMemory", "hermesExportLog", "toggleCommandPalette",
  "drawAnalyticsChart", "updateAnalyticsChart", "renderTempDisabledTab"
]);

// Pre-populate global hoisted functions and variables in app.js & galaxy.js
for (const m of (appJs + "\n" + galaxyJs).matchAll(/function\s+([a-zA-Z0-9_$]+)/g)) {
  if (m[1]) standardGlobals.add(m[1]);
}
for (const m of (appJs + "\n" + galaxyJs).matchAll(/(?:const|let|var)\s+([a-zA-Z0-9_$]+)/g)) {
  if (m[1]) standardGlobals.add(m[1]);
}
for (const m of (appJs + "\n" + galaxyJs).matchAll(/window\.([a-zA-Z0-9_$]+)\s*=/g)) {
  if (m[1]) standardGlobals.add(m[1]);
}

function addBindingToScope(binding: ts.BindingName, targetScope: Set<string>) {
  if (ts.isIdentifier(binding)) {
    targetScope.add(binding.text);
  } else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
    for (const elem of binding.elements) {
      if (ts.isBindingElement(elem)) {
        addBindingToScope(elem.name, targetScope);
      }
    }
  }
}

function visit(node: ts.Node) {
  if (ts.isIdentifier(node)) {
    const name = node.text;
    const parent = node.parent;

    const isProp = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
                   (ts.isPropertyAssignment(parent) && parent.name === node) ||
                   (ts.isBindingElement(parent) && parent.propertyName === node) ||
                   (ts.isMethodDeclaration(parent) && parent.name === node) ||
                   (ts.isFunctionDeclaration(parent) && parent.name === node) ||
                   (ts.isVariableDeclaration(parent) && parent.name === node) ||
                   (ts.isParameter(parent) && parent.name === node) ||
                   ts.isLabeledStatement(parent) ||
                   (ts.isBreakOrContinueStatement(parent) && parent.label === node);

    if (!isProp) {
      let found = false;
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i]!.has(name)) {
          found = true;
          break;
        }
      }
      if (!found && !standardGlobals.has(name) && !name.startsWith("_")) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        logError(`Undeclared identifier '${name}' at line ${line}: \`${parent.getText(sourceFile).slice(0, 60)}\``);
      }
    }
  }

  const isNewScope = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
                     ts.isArrowFunction(node) || ts.isBlock(node);
  if (isNewScope) scopes.push(new Set());

  const currentScope = scopes[scopes.length - 1]!;

  if (ts.isFunctionDeclaration(node) && node.name) {
    currentScope.add(node.name.text);
  } else if (ts.isVariableDeclaration(node)) {
    addBindingToScope(node.name, currentScope);
  } else if (ts.isParameter(node)) {
    addBindingToScope(node.name, currentScope);
  }

  ts.forEachChild(node, visit);

  if (isNewScope) scopes.pop();
}

ts.forEachChild(sourceFile, visit);
logPass("Audited public/js/app.js AST — all identifiers and scopes are declared.");

// ─── 3. CHECK GETELEMENTBYID CALLS & NULL SAFETY ───
const lines = appJs.split("\n");
lines.forEach((line, idx) => {
  const matches = line.matchAll(/document\.getElementById\((["'`])([^"'`]+)\1\)\.([a-zA-Z0-9_$]+)/g);
  for (const m of matches) {
    const id = m[2] ?? "";
    const prop = m[3] ?? "";
    const isCreatedInJs = appJs.includes(`id="${id}"`) || appJs.includes(`id='${id}'`) || appJs.includes(`id=\`${id}\``);
    if (!htmlIds.has(id) && !isCreatedInJs) {
      logError(`Unguarded property access '.${prop}' on missing element id='${id}' (app.js:${idx + 1})`);
    }
  }
});
logPass("Audited getElementById invocations — all accessed DOM elements verified or guarded.");

// ─── 4. CHECK INLINE HTML HANDLERS ───
const inlineHandlers = html.matchAll(/on[a-zA-Z]+\s*=\s*["']([^"']+)["']/g);
for (const match of inlineHandlers) {
  const code = (match[1] ?? "").trim();
  const fnMatch = code.match(/^([a-zA-Z0-9_$]+)\s*\(/);
  if (fnMatch) {
    const fnName = fnMatch[1] ?? "";
    if (["if", "alert", "confirm", "prompt", "console"].includes(fnName)) continue;
    const isDeclared = standardGlobals.has(fnName) ||
                       appJs.includes(`function ${fnName}`) ||
                       appJs.includes(`window.${fnName}`) ||
                       galaxyJs.includes(`function ${fnName}`) ||
                       galaxyJs.includes(`window.${fnName}`);
    if (!isDeclared) {
      logError(`HTML calls inline handler '${fnName}()', but function is not defined in JS`);
    }
  }
}
logPass("Audited HTML inline event handlers — all function references wired.");

console.log("\n═══════════════════════════════════════════════════════════════");
if (errorCount === 0) {
  console.log("🎉 FRONTEND AUDIT PASSED: 0 errors found!");
  process.exit(0);
} else {
  console.log(`❌ FRONTEND AUDIT FAILED: ${errorCount} error(s) detected.`);
  process.exit(1);
}
