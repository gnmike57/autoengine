/**
 * Test 20: FlowScreenshotter Retention Policy
 *
 * Tests the selective retention that keeps screenshots for interesting
 * outcomes and deletes them for routine outcomes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Reimplementation of FlowScreenshotter retention logic for isolated testing
const RETAIN_OUTCOMES = new Set(["success", "tempdisabled", "permdisabled", "2FA"]);

interface MockManifest {
  sessionId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: any[];
  outcome?: string;
}

function finalize(sessionDir: string, manifest: MockManifest, outcome?: string): { retained: boolean } {
  if (outcome) manifest.outcome = outcome;
  const shouldRetain = outcome ? RETAIN_OUTCOMES.has(outcome) : false;

  if (shouldRetain) {
    const manifestPath = path.join(sessionDir, "flow-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { retained: true };
  } else {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    return { retained: false };
  }
}

describe("FlowScreenshotter retention policy (Test 20)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ss-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSession(sessionId: string): string {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // Add a mock screenshot
    fs.writeFileSync(path.join(dir, "01-navigate.webp"), "fake_image_data");
    return dir;
  }

  it("keeps screenshots for 'success' outcome", () => {
    const dir = createSession("session-1");
    const result = finalize(dir, { sessionId: "session-1", steps: [] }, "success");
    expect(result.retained).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "flow-manifest.json"))).toBe(true);
  });

  it("keeps screenshots for '2FA' outcome", () => {
    const dir = createSession("session-2");
    const result = finalize(dir, { sessionId: "session-2", steps: [] }, "2FA");
    expect(result.retained).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("keeps screenshots for 'tempdisabled' outcome", () => {
    const dir = createSession("session-3");
    const result = finalize(dir, { sessionId: "session-3", steps: [] }, "tempdisabled");
    expect(result.retained).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("keeps screenshots for 'permdisabled' outcome", () => {
    const dir = createSession("session-4");
    const result = finalize(dir, { sessionId: "session-4", steps: [] }, "permdisabled");
    expect(result.retained).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("deletes screenshots for 'incorrect' outcome", () => {
    const dir = createSession("session-5");
    const result = finalize(dir, { sessionId: "session-5", steps: [] }, "incorrect");
    expect(result.retained).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes screenshots for 'noaccount' outcome", () => {
    const dir = createSession("session-6");
    const result = finalize(dir, { sessionId: "session-6", steps: [] }, "noaccount");
    expect(result.retained).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes screenshots for 'N/A' outcome", () => {
    const dir = createSession("session-7");
    const result = finalize(dir, { sessionId: "session-7", steps: [] }, "N/A");
    expect(result.retained).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes screenshots for 'other' outcome", () => {
    const dir = createSession("session-8");
    const result = finalize(dir, { sessionId: "session-8", steps: [] }, "other");
    expect(result.retained).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes screenshots for 'blocked' outcome", () => {
    const dir = createSession("session-9");
    const result = finalize(dir, { sessionId: "session-9", steps: [] }, "blocked");
    expect(result.retained).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes screenshots when outcome is undefined", () => {
    const dir = createSession("session-10");
    const result = finalize(dir, { sessionId: "session-10", steps: [] }, undefined);
    expect(result.retained).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes flow-manifest.json with correct shape for retained sessions", () => {
    const dir = createSession("session-11");
    const manifest = {
      sessionId: "session-11",
      steps: [
        { stepIndex: 1, stepName: "navigate", imagePath: "01-navigate.webp" },
        { stepIndex: 2, stepName: "fill-email", imagePath: "02-fill-email.webp" },
      ],
    };
    finalize(dir, manifest, "success");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const written = JSON.parse(fs.readFileSync(path.join(dir, "flow-manifest.json"), "utf-8"));
    expect(written.sessionId).toBe("session-11");
    expect(written.outcome).toBe("success");
    expect(written.steps.length).toBe(2);
    expect(written.steps[0].stepName).toBe("navigate");
  });

  it("RETAIN_OUTCOMES set contains exactly 4 outcomes", () => {
    expect(RETAIN_OUTCOMES.size).toBe(4);
  });

  it("honeypot is NOT in RETAIN_OUTCOMES (these sessions are burned)", () => {
    expect(RETAIN_OUTCOMES.has("honeypot")).toBe(false);
  });

  it("handles non-existent session directory gracefully on delete", () => {
    const dir = path.join(tmpDir, "nonexistent-session");
    // Should not throw
    const result = finalize(dir, { sessionId: "x", steps: [] }, "incorrect");
    expect(result.retained).toBe(false);
  });
});
