import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TimelineRecorder } from "../../src/services/timeline-recorder.js";

describe("TimelineRecorder", () => {
  let recorder: TimelineRecorder;

  afterEach(() => {
    if (recorder) recorder.stop();
  });

  it("should initialize session directory and manifest", () => {
    const mockPage: any = {
      isClosed: () => false,
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-jpeg"))
    };

    recorder = new TimelineRecorder(mockPage, "test@example.com", "joe", "stealth");
    expect(recorder.sessionId).toContain("email-");
    expect(recorder.sessionId).toContain("joe");
  });

  it("should capture frames and write manifest on stop", async () => {
    const mockPage: any = {
      isClosed: () => false,
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-jpeg"))
    };

    recorder = new TimelineRecorder(mockPage, "user@test.com", "ignition", "cloak");
    recorder.start();

    // Wait for at least one interval tick
    await new Promise((r) => setTimeout(r, 600));
    recorder.stop();

    const sessionDir = path.join(process.cwd(), "screenshots", "timelines", recorder.sessionId);
    const manifestPath = path.join(sessionDir, "timeline-manifest.json");

    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.backend).toBe("cloak");
  });
});
