import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AutomationEngine,
  DEFAULT_TARGETS,
  type Credential,
  type EngineConfig,
  type RowStatus,
} from "../src/core/engine.js";
import {
  classifyAccountEvidence,
  type CanonicalAccountOutcome,
  type SubmitAcceptanceEvidence,
} from "../src/core/account-classification.js";
import {
  REGISTERED_SUBMIT_VARIATIONS,
  type SubmitMethod,
} from "../src/stealth/random-login-actions.js";
import { verifySiteRecording } from "../src/services/video-verifier.js";
import type {
  LoginDiscoveryVariant,
  LoginEntryVariant,
  LoginAcceptanceVariant,
} from "../src/targets/login-step-variants.js";
import type { MullvadSessionMode } from "../src/proxy/mullvad-session-adapter.js";

interface MatrixRow {
  cell_id: string;
  site: string;
  backend: string;
  comparison_layer: string;
  variation: string;
  discovery_variant: string;
  entry_variant: string;
  submit_variation: string;
  acceptance_variant: string;
  repetition: string;
  status: string;
  run_id: string;
  outcome: string;
  accepted_submit_count: string;
  action_count: string;
  duration_ms: string;
  evidence_dir: string;
  failure_class: string;
}

interface Args {
  matrix: string;
  evidenceRoot: string;
  events: string;
  cellId?: string;
  timeoutMs: number;
}

const MATRIX_HEADERS: Array<keyof MatrixRow> = [
  "cell_id", "site", "backend", "comparison_layer", "variation",
  "discovery_variant", "entry_variant", "submit_variation", "acceptance_variant",
  "repetition", "status", "run_id",
  "outcome", "accepted_submit_count", "action_count", "duration_ms", "evidence_dir", "failure_class",
];
const FULL_EVIDENCE_BACKENDS = new Set([
  "cloak-headed", "cloak-headless", "cloak-headed-nocloak", "cloak-headless-nocloak",
  "stealth", "stealth-headed", "stealth-httpcloak", "zendriver", "zendriver-headed",
]);

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values.set(key.slice(2), value);
    i += 1;
  }
  const matrix = values.get("matrix");
  const evidenceRoot = values.get("evidence-root");
  const events = values.get("events");
  if (!matrix || !evidenceRoot || !events) {
    throw new Error("usage: run-evidence-matrix --matrix <csv> --evidence-root <dir> --events <jsonl> [--cell-id <id>] [--timeout-ms <ms>]");
  }
  return {
    matrix: path.resolve(matrix),
    evidenceRoot: path.resolve(evidenceRoot),
    events: path.resolve(events),
    cellId: values.get("cell-id"),
    timeoutMs: Number(values.get("timeout-ms") ?? 240_000),
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function quoteCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function readMatrix(file: string): MatrixRow[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("matrix contains no cells");
  const headers = parseCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) as unknown as MatrixRow;
    return row;
  });
}

function writeMatrix(file: string, rows: MatrixRow[]): void {
  const content = [
    MATRIX_HEADERS.join(","),
    ...rows.map((row) => MATRIX_HEADERS.map((header) => quoteCsv(row[header] ?? "")).join(",")),
  ].join("\n") + "\n";
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
}

function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function copyArtifact(source: string | undefined, destination: string): string | undefined {
  if (!source || !fs.existsSync(source) || fs.statSync(source).size <= 0) return undefined;
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

function syntheticCredential(cellId: string, site: string): Credential {
  const seed = crypto.createHash("sha256").update(`${cellId}:${site}`).digest("hex");
  return {
    email: `baseline-${seed.slice(0, 18)}@invalid.example`,
    passwords: [
      `B!${seed.slice(0, 14)}a9`,
      `C!${seed.slice(14, 28)}b8`,
      `D!${seed.slice(28, 42)}c7`,
    ],
    target_sites: [site],
  };
}

function sanitizeEvent(event: SubmitAcceptanceEvidence, row: MatrixRow, runId: string): Record<string, unknown> {
  return {
    cell_id: row.cell_id,
    run_id: runId,
    attempt_id: event.attemptId,
    invocation_index: event.invocationIndex,
    comparison_layer: row.comparison_layer,
    tested_variation: row.variation,
    discovery_variant: row.discovery_variant,
    entry_variant: row.entry_variant,
    submit_variation: row.submit_variation || row.variation,
    acceptance_variant: row.acceptance_variant,
    variation: event.variation,
    invoked: event.invoked,
    action_count: event.actionCount ?? (event.invoked ? 1 : 0),
    action_kind: event.actionKind,
    action_coordinates: event.actionCoordinates,
    protocol_event_count: event.protocolEventCount,
    observer_variant: event.observerVariant,
    accepted: event.accepted,
    acceptance_signal_count: event.acceptanceSignalCount,
    acceptance_signals: event.acceptanceSignals,
    dom_mutation: event.domMutation,
    network_activity: event.networkActivity,
    form_state_changed: event.formStateChanged,
    response_observed: event.responseObserved,
    response_class: event.responseClass,
    response_latency_ms: event.responseLatencyMs,
    verification_method: event.verificationMethod,
  };
}

function canonicalToEngine(outcome: CanonicalAccountOutcome): string {
  switch (outcome) {
    case "NO_ACCOUNT_CONFIRMED": return "noaccount";
    case "TEMP_DISABLED_ACCOUNT_EXISTS": return "tempdisabled";
    case "PERM_DISABLED_ACCOUNT_EXISTS": return "permdisabled";
    case "SUCCESSFUL_LOGIN": return "success";
    default: return "inconclusive";
  }
}

function updateGlobalEvents(eventsPath: string, cellId: string, events: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
  const retained: Array<Record<string, unknown>> = [];
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.cell_id !== cellId) retained.push(parsed);
      } catch {
        // Invalid prior evidence is dropped rather than copied into a new run.
      }
    }
  }
  const output = [...retained, ...events].map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(eventsPath, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
}

async function runCell(row: MatrixRow, args: Args): Promise<void> {
  const startedAt = Date.now();
  row.status = "RUNNING";
  row.failure_class = "";
  writeMatrix(args.matrix, matrixRows);

  const submitVariation = (row.submit_variation || row.variation) as SubmitMethod;
  if (!REGISTERED_SUBMIT_VARIATIONS.includes(submitVariation)) {
    row.status = "BLOCKED";
    row.failure_class = "unknown-submit-variation";
    return;
  }
  if (!FULL_EVIDENCE_BACKENDS.has(row.backend)) {
    row.status = "INCONCLUSIVE";
    row.outcome = "INCONCLUSIVE";
    row.failure_class = "backend-cannot-produce-full-browser-evidence";
    return;
  }
  const target = DEFAULT_TARGETS.find((candidate) => candidate.name === row.site);
  if (!target) {
    row.status = "BLOCKED";
    row.failure_class = "unknown-site";
    return;
  }

  const cellDir = path.join(args.evidenceRoot, row.cell_id);
  fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
  const credential = syntheticCredential(row.cell_id, row.site);
  const engine = new AutomationEngine();
  let completedRows: RowStatus[] = [];
  engine.on("complete", (payload: { rows?: RowStatus[] }) => {
    if (Array.isArray(payload.rows)) completedRows = payload.rows;
  });

  const mullvadSessionMode = (process.env.EVIDENCE_MULLVAD_MODE?.trim() || "disabled") as MullvadSessionMode;
  const config: EngineConfig = {
    concurrency: 1,
    maxRetries: 0,
    targets: [target],
    backend: row.backend as EngineConfig["backend"],
    liveTest: true,
    recordVideo: true,
    enablePlaywrightTracing: true,
    evidenceMode: true,
    primarySubmitVariation: submitVariation,
    loginDiscoveryVariant: (row.discovery_variant || "configured_css") as LoginDiscoveryVariant,
    loginEntryVariant: (row.entry_variant || "input_text") as LoginEntryVariant,
    loginAcceptanceVariant: (row.acceptance_variant || "request_response_dom_acceptance") as LoginAcceptanceVariant,
    dryRun: false,
    cleanSession: true,
    proxyPool: mullvadSessionMode === "disabled" ? (process.env.EVIDENCE_PROXY_POOL?.trim() || "6") : undefined,
    mullvadSessionMode,
    requireProxy: true,
    enableVerification: false,
    captureFlowSteps: true,
    flowDebug: false,
    useVisionCoordinates: true,
    parallelSiteTesting: false,
    recycleSessionOnIncorrect: false,
  };

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      engine.start([credential], config),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          engine.stop();
          reject(new Error(`cell timeout after ${args.timeoutMs}ms`));
        }, args.timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    row.status = "FAIL";
    row.outcome = "INCONCLUSIVE";
    row.failure_class = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 120) : "cell-execution-error";
    return;
  } finally {
    if (timeout) clearTimeout(timeout);
    engine.cleanup();
  }

  const engineRow = completedRows[0];
  const siteStatus = engineRow?.sites[row.site];
  const evidence = siteStatus?.submitEvidence ?? [];
  const runId = siteStatus?.evidenceRunId ?? evidence[0]?.runId ?? "";
  const actionCount = evidence.reduce((total, event) => total + (event.actionCount ?? (event.invoked ? 1 : 0)), 0);
  const acceptedCount = evidence.filter((event) => event.accepted).length;
  const provisional = classifyAccountEvidence(evidence, {
    videoPresent: true,
    evidenceComplete: true,
    actionCount,
    dryRun: false,
  });

  const video = copyArtifact(engineRow?.recordingUrl, path.join(cellDir, "video.webm"));
  const playwrightTrace = copyArtifact(engineRow?.tracePath, path.join(cellDir, "playwright-trace.zip"));
  const cdp = copyArtifact(engineRow?.cdpEvidencePath, path.join(cellDir, "cdp.jsonl"));
  const domPath = path.join(cellDir, "dom.json");
  const coordinatesPath = path.join(cellDir, "coordinates.json");
  const networkPath = path.join(cellDir, "network.json");
  const aiPath = path.join(cellDir, "ai.json");
  writeJson(domPath, evidence.map((event) => ({
    invocation_index: event.invocationIndex,
    dom_mutation: event.domMutation,
    form_state_changed: event.formStateChanged,
    response_observed: event.responseObserved,
    accepted: event.accepted,
    acceptance_signals: event.acceptanceSignals,
  })));
  writeJson(coordinatesPath, evidence.map((event) => ({
    invocation_index: event.invocationIndex,
    variation: event.variation,
    action_count: event.actionCount ?? (event.invoked ? 1 : 0),
    action_kind: event.actionKind,
    protocol_event_count: event.protocolEventCount ?? null,
    coordinates: event.actionCoordinates ?? null,
  })));
  writeJson(networkPath, evidence.map((event) => ({
    invocation_index: event.invocationIndex,
    network_activity: event.networkActivity,
    response_observed: event.responseObserved,
    response_class: event.responseClass,
    response_latency_ms: event.responseLatencyMs,
    observer_variant: event.observerVariant,
  })));

  const ai = video
    ? await verifySiteRecording(video, canonicalToEngine(provisional.outcome), row.site)
    : {
        aiVerdict: "unclear", confidence: "low", matches: false,
        reasoning: "video artifact unavailable", framesAnalyzed: 0,
        modelUsed: "none", durationMs: 0, signalAvailable: false,
      };
  writeJson(aiPath, ai);

  const requiredFiles: Record<string, string | undefined> = {
    video,
    dom: domPath,
    coordinates: coordinatesPath,
    network: networkPath,
    playwright: playwrightTrace,
    cdp,
    ai: aiPath,
  };
  const allArtifactsPresent = Object.values(requiredFiles).every((file) => file && fs.existsSync(file) && fs.statSync(file).size > 0);
  const aiConfirmed = ai.signalAvailable === true && ai.matches === true;
  const decision = classifyAccountEvidence(evidence, {
    videoPresent: Boolean(video),
    evidenceComplete: allArtifactsPresent && aiConfirmed,
    actionCount,
    dryRun: false,
  });
  const events = evidence.map((event) => sanitizeEvent(event, row, runId));
  updateGlobalEvents(args.events, row.cell_id, events);

  const artifacts = Object.fromEntries(Object.entries(requiredFiles).map(([name, file]) => [name, file ? {
    path: path.basename(file),
    sha256: sha256File(file),
  } : { path: "", sha256: "" }]));
  const manifest = {
    schema_version: 1,
    cell_id: row.cell_id,
    run_id: runId,
    site: row.site,
    backend: row.backend,
    comparison_layer: row.comparison_layer || "submit",
    variation: row.variation,
    discovery_variant: row.discovery_variant || "configured_css",
    entry_variant: row.entry_variant || "input_text",
    submit_variation: submitVariation,
    acceptance_variant: row.acceptance_variant || "request_response_dom_acceptance",
    selector_provenance: siteStatus?.selectorProvenance,
    repetition: Number(row.repetition),
    identity_sha256: crypto.createHash("sha256").update(credential.email).digest("hex"),
    dry_run: false,
    action_count: actionCount,
    accepted_submit_count: acceptedCount,
    outcome: decision.outcome,
    ai_signal_available: ai.signalAvailable === true,
    ai_matches: ai.matches === true,
    artifacts,
  };
  writeJson(path.join(cellDir, "evidence-manifest.json"), manifest);

  row.run_id = runId;
  row.outcome = decision.outcome;
  row.accepted_submit_count = String(acceptedCount);
  row.action_count = String(actionCount);
  row.duration_ms = String(Date.now() - startedAt);
  row.evidence_dir = cellDir;
  if (!runId) {
    row.status = "FAIL";
    row.failure_class = "missing-run-id";
  } else if (decision.outcome !== "NO_ACCOUNT_CONFIRMED") {
    row.status = "INCONCLUSIVE";
    row.failure_class = decision.reason;
  } else if (!allArtifactsPresent || !aiConfirmed) {
    row.status = "INCONCLUSIVE";
    row.failure_class = !allArtifactsPresent ? "missing-required-artifact" : "ai-evidence-unavailable-or-disputed";
  } else {
    row.status = "PASS";
    row.failure_class = "";
  }
}

const args = parseArgs(process.argv.slice(2));
const matrixRows = readMatrix(args.matrix);
const selected = matrixRows.filter((row) => !args.cellId || row.cell_id === args.cellId);
if (selected.length === 0) throw new Error("no matching matrix cells");
fs.mkdirSync(args.evidenceRoot, { recursive: true, mode: 0o700 });

for (const row of selected) {
  await runCell(row, args);
  writeMatrix(args.matrix, matrixRows);
  process.stdout.write(`${JSON.stringify({ cell_id: row.cell_id, status: row.status, outcome: row.outcome, failure_class: row.failure_class })}\n`);
}
