import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { startCdpEvidenceRecorder } from "../../src/services/cdp-evidence-recorder.js";

describe("CDP Evidence Recorder", () => {
  const baseTestDir = path.join(process.cwd(), "scratch", "cdp-tests");

  afterEach(() => {
    if (fs.existsSync(baseTestDir)) {
      try {
        fs.rmSync(baseTestDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("should return undefined if CDP session creation fails", async () => {
    const outputDir = path.join(baseTestDir, "test-1");
    const mockPage: any = {
      context: () => ({
        newCDPSession: vi.fn().mockRejectedValue(new Error("CDP not supported"))
      })
    };

    const recorder = await startCdpEvidenceRecorder(mockPage, {
      outputDir,
      sessionId: "test-fail"
    });

    expect(recorder).toBeUndefined();
  });

  it("should record CDP events and write to jsonl stream", async () => {
    const outputDir = path.join(baseTestDir, "test-2");
    const emitter = new EventEmitter() as any;
    emitter.send = vi.fn().mockResolvedValue(undefined);
    emitter.detach = vi.fn().mockResolvedValue(undefined);

    const mockPage: any = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(emitter)
      })
    };

    const recorder = await startCdpEvidenceRecorder(mockPage, {
      outputDir,
      sessionId: "test-success"
    });

    expect(recorder).toBeDefined();

    // Emit mock CDP events
    emitter.emit("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { method: "POST", url: "https://example.com/api/login" },
      type: "Fetch"
    });

    emitter.emit("Network.responseReceived", {
      requestId: "req-1",
      response: { status: 200, mimeType: "application/json", url: "https://example.com/api/login" },
      type: "Fetch"
    });

    await recorder!.stop();

    expect(fs.existsSync(recorder!.path)).toBe(true);
    const content = fs.readFileSync(recorder!.path, "utf-8");
    expect(content).toContain("Network.requestWillBeSent");
    expect(content).toContain("Network.responseReceived");
    expect(content).toContain("req-1");
  });
});
