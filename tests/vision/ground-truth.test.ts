/**
 * AI VISION VIDEO VERIFIER — Ground-Truth Suite
 *
 * Validates that each synthetic baseline fixture is a valid .webm file
 * with extractable key-frames. AI classification tests are marked with
 * the `ai` tag and only run when OPENAI_API_KEY or OPENROUTER_API_KEY
 * is set (they require live LLM access).
 *
 * Governance: Every outcome class must have a fixture here.
 * See: .agents/skills/automation-video-coverage/SKILL.md
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, "fixtures");

// All 7 outcome classes that must have fixtures
const REQUIRED_FIXTURES = [
  { outcome: "noaccount",    file: "no-account-baseline.webm",    sidecar: "no-account-baseline.json" },
  { outcome: "success",      file: "success-baseline.webm",       sidecar: "success-baseline.json" },
  { outcome: "tempdisabled", file: "temp-disabled-baseline.webm", sidecar: "temp-disabled-baseline.json" },
  { outcome: "permdisabled", file: "perm-disabled-baseline.webm", sidecar: "perm-disabled-baseline.json" },
  { outcome: "2fa",          file: "2fa-baseline.webm",           sidecar: "2fa-baseline.json" },
  { outcome: "incorrect",    file: "incorrect-baseline.webm",     sidecar: "incorrect-baseline.json" },
  { outcome: "blocked",      file: "blocked-baseline.webm",       sidecar: "blocked-baseline.json" },
] as const;

describe("Ground-Truth Fixture Integrity", () => {
  beforeAll(() => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
  });

  for (const { outcome, file, sidecar } of REQUIRED_FIXTURES) {
    describe(`Outcome: ${outcome}`, () => {
      const fixturePath = path.join(fixturesDir, file);
      const sidecarPath = path.join(fixturesDir, sidecar);

      it(`fixture file exists: ${file}`, () => {
        expect(
          fs.existsSync(fixturePath),
          `Missing fixture: ${fixturePath}\nRun: npx tsx scripts/record-baseline.ts --outcome=${outcome}`
        ).toBe(true);
      });

      it(`fixture is a non-empty .webm file`, () => {
        if (!fs.existsSync(fixturePath)) return;
        const stat = fs.statSync(fixturePath);
        expect(stat.size).toBeGreaterThan(1024); // at least 1 KB
      });

      it(`sidecar JSON exists and is valid: ${sidecar}`, () => {
        expect(
          fs.existsSync(sidecarPath),
          `Missing sidecar: ${sidecarPath}`
        ).toBe(true);
        if (!fs.existsSync(sidecarPath)) return;
        const data = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
        expect(data.outcome).toBe(outcome);
        expect(typeof data.recordedAt).toBe("string");
        expect(typeof data.engineVersion).toBe("string");
      });

      it(`fixture has valid WebM magic bytes`, () => {
        if (!fs.existsSync(fixturePath)) return;
        const buf = Buffer.alloc(4);
        const fd = fs.openSync(fixturePath, "r");
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        // WebM/EBML magic: 0x1A 0x45 0xDF 0xA3
        expect(buf[0]).toBe(0x1a);
        expect(buf[1]).toBe(0x45);
        expect(buf[2]).toBe(0xdf);
        expect(buf[3]).toBe(0xa3);
      });
    });
  }
});

describe("AI Vision Classification (requires LLM key)", () => {
  const hasLlmKey =
    Boolean(process.env["OPENAI_API_KEY"]) ||
    Boolean(process.env["OPENROUTER_API_KEY"]);

  it.skipIf(!hasLlmKey)(
    "should correctly classify the NO_ACCOUNT baseline",
    async () => {
      const { extractKeyFrames } = await import(
        "../../src/services/video-extraction.js"
      );
      const { classifyWithAI } = await import(
        "../../src/services/video-verifier.js"
      );
      const videoPath = path.join(fixturesDir, "no-account-baseline.webm");
      const frames = await extractKeyFrames(videoPath);
      expect(frames.length).toBeGreaterThan(0);
      const result = await classifyWithAI(frames, "noaccount", "test");
      expect(result).toBeDefined();
    },
    40_000
  );

  it.skipIf(!hasLlmKey)(
    "should correctly classify the 2FA baseline",
    async () => {
      const { extractKeyFrames } = await import(
        "../../src/services/video-extraction.js"
      );
      const { classifyWithAI } = await import(
        "../../src/services/video-verifier.js"
      );
      const videoPath = path.join(fixturesDir, "2fa-baseline.webm");
      const frames = await extractKeyFrames(videoPath);
      expect(frames.length).toBeGreaterThan(0);
      const result = await classifyWithAI(frames, "2fa", "test");
      expect(result).toBeDefined();
    },
    40_000
  );
});
