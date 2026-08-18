import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright-core";

export interface CdpEvidenceRecorder {
  path: string;
  stop(): Promise<void>;
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeExceptionText(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(password|passwd|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

export async function startCdpEvidenceRecorder(
  page: Page,
  options: { outputDir: string; sessionId: string },
): Promise<CdpEvidenceRecorder | undefined> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return undefined;
  }

  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(options.outputDir, `cdp-${options.sessionId}.jsonl`);
  const stream = fs.createWriteStream(outputPath, { flags: "w", mode: 0o600 });
  let stopped = false;

  const write = (event: Record<string, unknown>): void => {
    if (stopped || stream.destroyed) return;
    stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  };

  session.on("Network.requestWillBeSent", (payload: any) => {
    write({
      type: "Network.requestWillBeSent",
      request_id: payload.requestId,
      method: payload.request?.method,
      url_sha256: typeof payload.request?.url === "string" ? hashValue(payload.request.url) : undefined,
      resource_type: payload.type,
    });
  });
  session.on("Network.responseReceived", (payload: any) => {
    write({
      type: "Network.responseReceived",
      request_id: payload.requestId,
      status: payload.response?.status,
      mime_type: payload.response?.mimeType,
      url_sha256: typeof payload.response?.url === "string" ? hashValue(payload.response.url) : undefined,
      resource_type: payload.type,
    });
  });
  session.on("Page.frameNavigated", (payload: any) => {
    write({
      type: "Page.frameNavigated",
      frame_id: payload.frame?.id,
      parent_frame_id: payload.frame?.parentId,
      url_sha256: typeof payload.frame?.url === "string" ? hashValue(payload.frame.url) : undefined,
    });
  });
  session.on("Runtime.exceptionThrown", (payload: any) => {
    write({
      type: "Runtime.exceptionThrown",
      exception: safeExceptionText(payload.exceptionDetails?.text ?? payload.exceptionDetails?.exception?.description),
    });
  });

  try {
    await Promise.all([
      session.send("Network.enable"),
      session.send("Page.enable"),
      session.send("Runtime.enable"),
    ]);
    write({ type: "recorder.started", session_id_sha256: hashValue(options.sessionId) });
  } catch {
    await session.detach().catch(() => {});
    stream.end();
    return undefined;
  }

  return {
    path: outputPath,
    async stop(): Promise<void> {
      if (stopped) return;
      write({ type: "recorder.stopped", session_id_sha256: hashValue(options.sessionId) });
      stopped = true;
      await session.detach().catch(() => {});
      await new Promise<void>((resolve) => {
        stream.once("finish", resolve);
        stream.end();
      });
    },
  };
}
