import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  waitForWicketkeeperToken,
  WicketkeeperTokenFarm,
  handleWicketkeeper,
  getTokenFarm,
  _resetTokenFarm,
  type WicketkeeperToken
} from "../../src/stealth/wicketkeeper-handler.js";

describe("Wicketkeeper Handler", () => {
  const testQueuePath = path.join(process.cwd(), "scratch", "test-wk-tokens.json");

  afterEach(() => {
    _resetTokenFarm();
    if (fs.existsSync(testQueuePath)) {
      try {
        fs.unlinkSync(testQueuePath);
      } catch {}
    }
  });

  it("should passively wait for token via page evaluate", async () => {
    const mockPage: any = {
      evaluate: vi.fn().mockResolvedValue("test-token-jwt-1234567890")
    };

    const token = await waitForWicketkeeperToken(mockPage, 1000);
    expect(token).toBe("test-token-jwt-1234567890");
  });

  it("should push and pop tokens using file-based token farm", async () => {
    const farm = new WicketkeeperTokenFarm({ tokenQueuePath: testQueuePath });

    const token: WicketkeeperToken = {
      jwt: "jwt-sample-string",
      nonce: "nonce-sample",
      domain: "joefortune.zone",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000
    };

    await farm.pushToken(token);

    const depth = await farm.getQueueDepth("joefortune.zone");
    expect(depth).toBe(1);

    const popped = await farm.popToken("joefortune.zone");
    expect(popped).not.toBeNull();
    expect(popped?.jwt).toBe("jwt-sample-string");

    const emptyDepth = await farm.getQueueDepth("joefortune.zone");
    expect(emptyDepth).toBe(0);
  });

  it("should orchestrate multi-tier resolution in handleWicketkeeper", async () => {
    const mockPage: any = {
      evaluate: vi.fn().mockResolvedValue("passive-resolved-token-string")
    };

    const token = await handleWicketkeeper(mockPage, "joefortune.zone", {
      tokenQueuePath: testQueuePath,
      passiveTimeoutMs: 500
    });

    expect(token).toBe("passive-resolved-token-string");
  });

  it("should manage singleton token farm", () => {
    const f1 = getTokenFarm();
    const f2 = getTokenFarm();
    expect(f1).toBe(f2);
  });
});
