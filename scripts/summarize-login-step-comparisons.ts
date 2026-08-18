import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import {
  summarizeLoginStepComparisons,
  type LoginStepLayer,
  type LoginStepObservation,
} from "../src/targets/login-step-comparison.js";

interface MatrixRecord {
  cell_id: string;
  comparison_layer?: string;
  variation: string;
  status: string;
  outcome: string;
  accepted_submit_count: string;
  action_count: string;
  duration_ms: string;
  evidence_dir?: string;
}

interface Args {
  matrix: string;
  evidenceRoot: string;
  outputJson: string;
  outputCsv: string;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const matrix = values.get("matrix");
  const evidenceRoot = values.get("evidence-root");
  const outputJson = values.get("output-json");
  const outputCsv = values.get("output-csv");
  if (!matrix || !evidenceRoot || !outputJson || !outputCsv) {
    throw new Error("usage: summarize-login-step-comparisons --matrix <csv> --evidence-root <dir> --output-json <json> --output-csv <csv>");
  }
  return {
    matrix: path.resolve(matrix),
    evidenceRoot: path.resolve(evidenceRoot),
    outputJson: path.resolve(outputJson),
    outputCsv: path.resolve(outputCsv),
  };
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function evidenceSignalCount(cellDirectory: string): number {
  return [
    "video.webm",
    "dom.json",
    "coordinates.json",
    "network.json",
    "playwright-trace.zip",
    "cdp.jsonl",
    "ai.json",
  ].filter((name) => {
    const file = path.join(cellDirectory, name);
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  }).length;
}

function csvValue(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const args = parseArgs(process.argv.slice(2));
const records = parse(fs.readFileSync(args.matrix, "utf8"), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
}) as MatrixRecord[];

const observations: LoginStepObservation[] = records.map((record) => {
  const layer = (record.comparison_layer || "submit") as LoginStepLayer;
  if (!["discovery", "entry", "submit", "acceptance"].includes(layer)) {
    throw new Error(`cannot rank comparison layer ${layer}; use one-factor mode`);
  }
  const cellDirectory = record.evidence_dir
    ? path.resolve(record.evidence_dir)
    : path.join(args.evidenceRoot, record.cell_id);
  const manifest = readJson(path.join(cellDirectory, "evidence-manifest.json"));
  const provenance = manifest?.selector_provenance as Record<string, unknown> | undefined;
  const expectedOutcome = "NO_ACCOUNT_CONFIRMED";
  const acceptedCount = Number.parseInt(record.accepted_submit_count || "0", 10);
  const actionCount = Number.parseInt(record.action_count || "0", 10);
  const durationMs = Number.parseInt(record.duration_ms || "0", 10);
  const signalCount = evidenceSignalCount(cellDirectory);
  return {
    layer,
    variant: record.variation,
    runId: String(manifest?.run_id ?? record.cell_id),
    success: record.status === "PASS" && record.outcome === expectedOutcome,
    latencyMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
    acceptedSubmit: acceptedCount >= 3,
    evidenceSignalCount: signalCount,
    driftFixturePassed: provenance?.variant === record.variation ? true : undefined,
    falsePass: record.status === "PASS" && (record.outcome !== expectedOutcome || actionCount !== 4 || signalCount !== 7),
  };
});

const summaries = summarizeLoginStepComparisons(observations);
fs.mkdirSync(path.dirname(args.outputJson), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(args.outputCsv), { recursive: true, mode: 0o700 });
fs.writeFileSync(args.outputJson, `${JSON.stringify({ observations, summaries }, null, 2)}\n`, { mode: 0o600 });
const headers = [
  "layer", "variant", "runs", "success_count", "success_rate", "accepted_submit_rate",
  "evidence_complete_rate", "drift_pass_rate", "false_pass_count", "median_latency_ms", "p95_latency_ms",
];
const rows = summaries.map((summary) => [
  summary.layer,
  summary.variant,
  summary.runs,
  summary.successCount,
  summary.successRate,
  summary.acceptedSubmitRate ?? "",
  summary.evidenceCompleteRate ?? "",
  summary.driftPassRate ?? "",
  summary.falsePassCount,
  summary.medianLatencyMs,
  summary.p95LatencyMs,
]);
fs.writeFileSync(args.outputCsv, `${headers.join(",")}\n${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ observations: observations.length, variants: summaries.length, output_json: args.outputJson, output_csv: args.outputCsv })}\n`);
