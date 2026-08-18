/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unused-vars */
/**
 * Integration Test: /audit-fp + live-auditor round-trip
 *
 * Tests the full HTTP round-trip from the live-auditor's POST body
 * through the Express endpoint's localhost guard, null-safety checks,
 * and mismatch detection logic — without spinning up a real browser.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";

// Build a minimal Express app that mirrors the /audit-fp handler
function createTestApp() {
  const app = express();

  function readHeader(req: express.Request, name: string): string | undefined {
    const v = req.headers[name];
    return typeof v === "string" ? v : undefined;
  }

  const logs: string[] = [];
  const log = {
    warn: (msg: string) => logs.push(`WARN: ${msg}`),
    info: (msg: string) => logs.push(`INFO: ${msg}`),
    error: (msg: string, ...a: any[]) => logs.push(`ERROR: ${msg} ${a.join(" ")}`),
  };

  app.post("/audit-fp", express.json(), (req, res) => {
    try {
      const remoteAddr = req.socket.remoteAddress || "";
      if (!remoteAddr.includes("127.0.0.1") && remoteAddr !== "::1") {
        return res.status(403).json({ error: "forbidden" });
      }

      const { expectedUA, expectedOS, jsEvidence } = req.body;
      if (!jsEvidence?.userAgent || !jsEvidence?.platform) {
        return res.status(400).json({ error: "missing jsEvidence fields" });
      }

      const isMismatch = !jsEvidence.userAgent.includes(expectedUA) ||
        !jsEvidence.platform.toLowerCase().includes(expectedOS.toLowerCase());

      if (isMismatch) {
        log.warn(`Mismatch Detected! Expected UA: ${expectedUA}, OS: ${expectedOS}. Got: ${jsEvidence.userAgent}`);
      } else {
        log.info(`Coherent fingerprint verified for ${expectedOS}`);
      }

      res.json({ success: true, isMismatch });
    } catch (err: any) {
      log.error("Submission error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return { app, logs };
}

describe("/audit-fp integration", () => {
  let server: http.Server;
  let port: number;
  let logs: string[];

  beforeAll(async () => {
    const { app, logs: appLogs } = createTestApp();
    logs = appLogs;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "0.0.0.0", () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postAudit(body: any): Promise<{ status: number; data: any }> {
    const res = await fetch(`http://127.0.0.1:${port}/audit-fp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  it("returns success=true with isMismatch=false for coherent fingerprint", async () => {
    const { status, data } = await postAudit({
      expectedUA: "Chrome/120",
      expectedOS: "win",
      jsEvidence: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0",
        platform: "Win32",
      },
    });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.isMismatch).toBe(false);
  });

  it("detects mismatch when UA doesn't contain expected string", async () => {
    const { status, data } = await postAudit({
      expectedUA: "Firefox/121",
      expectedOS: "windows",
      jsEvidence: {
        userAgent: "Mozilla/5.0 Chrome/120.0",
        platform: "Win32",
      },
    });

    expect(status).toBe(200);
    expect(data.isMismatch).toBe(true);
  });

  it("detects mismatch when OS doesn't match platform", async () => {
    const { status, data } = await postAudit({
      expectedUA: "Chrome",
      expectedOS: "macos",
      jsEvidence: {
        userAgent: "Mozilla/5.0 Chrome/120.0",
        platform: "Win32",
      },
    });

    expect(status).toBe(200);
    expect(data.isMismatch).toBe(true);
  });

  it("returns 400 when jsEvidence is missing", async () => {
    const { status, data } = await postAudit({
      expectedUA: "Chrome",
      expectedOS: "windows",
    });

    expect(status).toBe(400);
    expect(data.error).toBe("missing jsEvidence fields");
  });

  it("returns 400 when jsEvidence.userAgent is missing", async () => {
    const { status, data } = await postAudit({
      expectedUA: "Chrome",
      expectedOS: "windows",
      jsEvidence: { platform: "Win32" },
    });

    expect(status).toBe(400);
    expect(data.error).toBe("missing jsEvidence fields");
  });
});
