import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as dbMod from "../../src/core/database.js";

const { mockGet, mockAll, mockRun } = vi.hoisted(() => {
  return {
    mockGet: vi.fn(),
    mockAll: vi.fn().mockReturnValue([]),
    mockRun: vi.fn().mockReturnValue({ changes: 0 }),
  };
});

vi.mock("better-sqlite3", () => {
  return {
    default: class MockDatabase {
      pragma = vi.fn();
      exec = vi.fn();
      close = vi.fn();
      transaction = vi.fn((cb) => cb);
      prepare = vi.fn().mockReturnValue({
        get: mockGet,
        all: mockAll,
        run: mockRun,
      });
    }
  };
});

vi.mock("chokidar", () => {
  return {
    default: {
      watch: vi.fn().mockReturnValue({
        on: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }
  };
});

describe("database", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    dbMod.stopDbBackupCron();
    dbMod.stopPruneCron();
    await dbMod.stopCredentialsWatcher();
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("encrypt and decrypt return plain text", () => {
    expect(dbMod.encrypt("secret")).toBe("secret");
    expect(dbMod.decrypt("secret")).toBe("secret");
  });

  it("exports CONFIDENT_OUTCOMES and TESTED_OUTCOMES", () => {
    expect(dbMod.CONFIDENT_OUTCOMES).toBeDefined();
    expect(dbMod.TESTED_OUTCOMES).toBeDefined();
  });

  it("initDB creates tables and pragmas", () => {
    mockGet.mockReturnValue({ cnt: 0 });
    dbMod.initDB();
    mockGet.mockReset();
  });

  it("countCredentials returns a number", () => {
    mockGet.mockReturnValueOnce({ cnt: 42 });
    expect(dbMod.countCredentials()).toBe(42);
  });

  it("countTestRuns returns a number", () => {
    mockGet.mockReturnValueOnce({ cnt: 10 });
    expect(dbMod.countTestRuns()).toBe(10);
  });

  it("closeDB calls close on db", () => {
    dbMod.closeDB();
    expect(dbMod.db.close).toHaveBeenCalled();
  });

  it("startDbBackupCron sets interval", () => {
    dbMod.startDbBackupCron();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    dbMod.stopDbBackupCron();
  });

  it("saveTestRun does not throw", () => {
    mockGet.mockReturnValueOnce({ id: 1 });
    dbMod.saveTestRun("test@example.com", "joe", "success", undefined, "session-123", undefined, 0, ["pass1"]);
    vi.runAllTimers();
    expect(mockRun).toHaveBeenCalled();
  });

  it("getNextBatchIndex returns a number", () => {
    mockGet.mockReturnValueOnce({ id: 1 }).mockReturnValueOnce({ batch_index: 2 });
    expect(dbMod.getNextBatchIndex("test@example.com", "joe")).toBe(2);
  });

  it("advanceBatchIndex executes", () => {
    mockGet.mockReturnValueOnce({ id: 1 });
    mockRun.mockReturnValueOnce({ changes: 1 });
    dbMod.advanceBatchIndex("test@example.com", "joe", 3);
  });

  it("resetBatchIndex executes", () => {
    mockGet.mockReturnValueOnce({ id: 1 });
    mockRun.mockReturnValueOnce({ changes: 1 });
    dbMod.resetBatchIndex("test@example.com", "joe");
  });

  it("getPasswordCount returns count", () => {
    mockGet.mockReturnValueOnce({ password_count: 5 });
    expect(dbMod.getPasswordCount("test@example.com")).toBe(5);
  });

  it("getUntestedCredentials returns array", () => {
    mockAll.mockReturnValueOnce([{ email: "a@b.com", passwords: "[]", target_sites: '["joe"]' }]);
    const res = dbMod.getUntestedCredentials(["joe"]);
    expect(Array.isArray(res)).toBe(true);
  });

  it("getCredentialsByEmails returns array", () => {
    mockAll.mockReturnValueOnce([{ email: "a@b.com", passwords: "[]", target_sites: '["joe"]' }]);
    const res = dbMod.getCredentialsByEmails(["a@b.com"]);
    expect(Array.isArray(res)).toBe(true);
  });

  it("getAllCredentialsHistory returns array", () => {
    mockAll.mockReturnValueOnce([]);
    const res = dbMod.getAllCredentialsHistory();
    expect(Array.isArray(res)).toBe(true);
  });

  it("getCategorizedTempDisabled returns array", () => {
    mockAll.mockReturnValueOnce([{ error: "timeout", count: 1, results: "[]" }]);
    const res = dbMod.getCategorizedTempDisabled();
    expect(Array.isArray(res)).toBe(true);
  });

  it("updateAiVerificationStatus executes", () => {
    mockRun.mockReturnValueOnce({ changes: 1 });
    dbMod.updateAiVerificationStatus("session1", "verified");
    vi.runAllTimers();
    expect(mockRun).toHaveBeenCalled();
  });

  it("saveSessionFingerprint executes", () => {
    mockRun.mockReturnValueOnce({ changes: 1 });
    dbMod.saveSessionFingerprint("session1", "a@b.com", {});
    vi.runAllTimers();
    expect(mockRun).toHaveBeenCalled();
  });
});
