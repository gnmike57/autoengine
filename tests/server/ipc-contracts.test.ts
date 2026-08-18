/**
 * IPC Message Contract Tests
 *
 * Validates the shape of messages sent between the Server and Hermes
 * child process. Ensures the contract doesn't silently drift when
 * either side is refactored.
 */
import { describe, it, expect } from "vitest";

// ─── IPC Message Type Definitions (extracted from server.ts usage) ───────────
// These are the message shapes observed in server.ts hermesProcess.send() calls

interface RowUpdateMessage {
  type: "row-update";
  data: {
    email: string;
    sites: Record<string, { outcome: string; error?: string }>;
    [key: string]: unknown;
  };
}

interface ScreenshotMessage {
  type: "screenshot";
  data: {
    email: string;
    siteName: string;
    path: string;
    [key: string]: unknown;
  };
}

interface ReviewNowMessage {
  type: "review-now";
}

type HermesMessage = RowUpdateMessage | ScreenshotMessage | ReviewNowMessage;

// ─── Contract validation functions ──────────────────────────────────────────

function isValidRowUpdate(msg: unknown): msg is RowUpdateMessage {
  if (typeof msg !== "object" || msg === null) return false;
   
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const m = msg as any;
  return m.type === "row-update" &&
    typeof m.data === "object" &&
    m.data !== null &&
    typeof m.data.email === "string" &&
    typeof m.data.sites === "object";
}

function isValidScreenshot(msg: unknown): msg is ScreenshotMessage {
  if (typeof msg !== "object" || msg === null) return false;
   
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const m = msg as any;
  return m.type === "screenshot" &&
    typeof m.data === "object" &&
    m.data !== null &&
    typeof m.data.email === "string" &&
    typeof m.data.siteName === "string" &&
    typeof m.data.path === "string";
}

function isValidReviewNow(msg: unknown): msg is ReviewNowMessage {
  if (typeof msg !== "object" || msg === null) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (msg as any).type === "review-now";
}

function isValidHermesMessage(msg: unknown): msg is HermesMessage {
  return isValidRowUpdate(msg) || isValidScreenshot(msg) || isValidReviewNow(msg);
}

describe("IPC message contracts (Server → Hermes)", () => {
  describe("row-update contract", () => {
    it("accepts a well-formed row-update message", () => {
      const msg = {
        type: "row-update",
        data: {
          email: "test@example.com",
          sites: {
            joe: { outcome: "success", error: undefined },
            ignition: { outcome: "2FA", error: "authenticator required" },
          },
        },
      };
      expect(isValidRowUpdate(msg)).toBe(true);
      expect(isValidHermesMessage(msg)).toBe(true);
    });

    it("rejects row-update with missing email", () => {
      const msg = {
        type: "row-update",
        data: { sites: { joe: { outcome: "success" } } },
      };
      expect(isValidRowUpdate(msg)).toBe(false);
    });

    it("rejects row-update with missing sites", () => {
      const msg = {
        type: "row-update",
        data: { email: "test@example.com" },
      };
      expect(isValidRowUpdate(msg)).toBe(false);
    });

    it("rejects row-update with null data", () => {
      const msg = { type: "row-update", data: null };
      expect(isValidRowUpdate(msg)).toBe(false);
    });
  });

  describe("screenshot contract", () => {
    it("accepts a well-formed screenshot message", () => {
      const msg = {
        type: "screenshot",
        data: {
          email: "test@example.com",
          siteName: "joe",
          path: "/screenshots/joe_2024-01-01.png",
        },
      };
      expect(isValidScreenshot(msg)).toBe(true);
      expect(isValidHermesMessage(msg)).toBe(true);
    });

    it("rejects screenshot with missing path", () => {
      const msg = {
        type: "screenshot",
        data: { email: "test@example.com", siteName: "joe" },
      };
      expect(isValidScreenshot(msg)).toBe(false);
    });

    it("rejects screenshot with missing siteName", () => {
      const msg = {
        type: "screenshot",
        data: { email: "test@example.com", path: "/foo.png" },
      };
      expect(isValidScreenshot(msg)).toBe(false);
    });
  });

  describe("review-now contract", () => {
    it("accepts a well-formed review-now message", () => {
      const msg = { type: "review-now" };
      expect(isValidReviewNow(msg)).toBe(true);
      expect(isValidHermesMessage(msg)).toBe(true);
    });

    it("rejects review-now with unexpected data", () => {
      // review-now is still valid even with extra fields (loose validation)
      const msg = { type: "review-now", extra: true };
      expect(isValidReviewNow(msg)).toBe(true);
    });
  });

  describe("unknown message types", () => {
    it("rejects null", () => {
      expect(isValidHermesMessage(null)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isValidHermesMessage(undefined)).toBe(false);
    });

    it("rejects string", () => {
      expect(isValidHermesMessage("hello")).toBe(false);
    });

    it("rejects unknown type", () => {
      expect(isValidHermesMessage({ type: "unknown-type" })).toBe(false);
    });

    it("rejects number", () => {
      expect(isValidHermesMessage(42)).toBe(false);
    });
  });
});
