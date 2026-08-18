import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TimelineAnalyzer, timelineEvents } from "../../src/hermes/timeline-analyzer.js";

// Mock ollamaClient
vi.mock("../../src/core/ollama-client.js", () => ({
  ollamaClient: {
    chat: vi.fn().mockImplementation(async ({ model }) => {
      if (model === "llava") {
        return { message: { content: "Timeline Analysis: Login completed [SUCCESS]" } };
      }
      return { message: { content: "Timeline Analysis: Login confirmed [SUCCESS]" } };
    })
  }
}));

import { ollamaClient } from "../../src/core/ollama-client.js";

describe("TimelineAnalyzer", () => {
  const sessionId = "test-session-timeline";
  const sessionDir = path.join(process.cwd(), "screenshots", "timelines", sessionId);

  beforeEach(() => {
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("should return null if manifest does not exist", async () => {
    const result = await TimelineAnalyzer.analyzeTimeline("non-existent-session");
    expect(result).toBeNull();
  });

  it("should return null if manifest has 0 frames", async () => {
    const manifestPath = path.join(sessionDir, "timeline-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ frames: [] }));

    const result = await TimelineAnalyzer.analyzeTimeline(sessionId);
    expect(result).toBeNull();
  });

  it("should analyze timeline frames and persist analysis file on consensus", async () => {
    const framePath = path.join(sessionDir, "0ms.jpeg");
    fs.writeFileSync(framePath, "fake-image-binary");

    const manifestPath = path.join(sessionDir, "timeline-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        sessionId,
        frames: [{ offsetMs: 0, timestamp: new Date().toISOString(), imagePath: "0ms.jpeg" }]
      })
    );

    const result = await TimelineAnalyzer.analyzeTimeline(sessionId);
    expect(result).toContain("CONSENSUS REACHED");
    expect(result).toContain("Timeline Analysis");

    const analysisFile = path.join(sessionDir, "hermes-analysis.md");
    expect(fs.existsSync(analysisFile)).toBe(true);
  });

  it("should emit human-query-required event when models disagree", async () => {
    const framePath = path.join(sessionDir, "0ms.jpeg");
    fs.writeFileSync(framePath, "fake-image-binary");

    const manifestPath = path.join(sessionDir, "timeline-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        sessionId,
        frames: [{ offsetMs: 0, timestamp: new Date().toISOString(), imagePath: "0ms.jpeg" }]
      })
    );

    (ollamaClient.chat as any).mockImplementationOnce(async () => ({
      message: { content: "Outcome was [SUCCESS]" }
    })).mockImplementationOnce(async () => ({
      message: { content: "Outcome was [FAILED]" }
    }));

    let humanQueryEmitted = false;
    timelineEvents.once("human-query-required", (data) => {
      if (data.sessionId === sessionId) humanQueryEmitted = true;
    });

    const result = await TimelineAnalyzer.analyzeTimeline(sessionId);
    expect(result).toContain("CONSENSUS FAILED");
    expect(humanQueryEmitted).toBe(true);
  });
});
