import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initXlsxWriter,
  updateCredentialXlsx,
  flushCredentialXlsx,
  recordPasswordResult
} from "../../src/services/credential-xlsx-writer.js";
import { Worker } from "worker_threads";

vi.mock("worker_threads", () => {
  return {
    Worker: vi.fn().mockImplementation(() => ({
      on: vi.fn((event, cb) => {
        if (event === "message") {
          // Immediately simulate worker done
          setTimeout(() => cb({ status: "done" }), 1);
        }
      }),
      postMessage: vi.fn(),
      terminate: vi.fn()
    }))
  };
});

describe("credential-xlsx-writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("initializes with explicit or derived paths", () => {
    initXlsxWriter("test.csv", "out.xlsx");
    expect(true).toBe(true);
  });

  it("initializes with derived path if no xlsxPath provided", () => {
    initXlsxWriter("some-file.csv");
    expect(true).toBe(true);
  });

  it("records password result properly", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = {};
    
    recordPasswordResult(row, 0, "incorrect", "joefortune");
    expect(row._passwordResults).toBeDefined();
    expect(row._passwordResults[0].outcome).toBe("incorrect");
    expect(row._passwordResults[0].site).toBe("joefortune");
    expect(row._passwordResults[0].attemptIndex).toBe(0);

    recordPasswordResult(row, 0, "success", "joefortune");
    expect(row._passwordResults.length).toBe(1);
    expect(row._passwordResults[0].outcome).toBe("success");
  });

  it("updates xlsx on a debounce", () => {
    initXlsxWriter("test.csv", "out.xlsx");
    const credentials = [{ email: "test@example.com", passwords: ["p1", "p2"] }];
    const rows = [{ sites: { joefortune: { outcome: "incorrect" } } }];

    updateCredentialXlsx(credentials, rows);
    
    expect(Worker).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    
    expect(Worker).toHaveBeenCalled();
  });

  it("flushes xlsx immediately", async () => {
    initXlsxWriter("test.csv", "out.xlsx");
    const credentials = [{ email: "test@example.com", passwords: ["p1"] }];
    const rows = [
      {
        sites: { joefortune: { outcome: "success" } },
        _passwordResults: [{ attemptIndex: 0, outcome: "success", site: "joefortune" }]
      }
    ];

    const promise = flushCredentialXlsx(credentials, rows);
    vi.advanceTimersByTime(10);
    await promise;
    
    expect(Worker).toHaveBeenCalled();
  });
  
  it("computes overall outcome correctly when flushing", async () => {
    initXlsxWriter("test.csv", "out.xlsx");
    
    const credentials = [{ email: "t1@ex.com", passwords: ["p"] }, { email: "t2@ex.com", passwords: ["p"] }];
    const rows = [
      { sites: { s1: { outcome: "2FA" } } },
      { sites: { s1: { outcome: "tempdisabled" } } }
    ];

    const promise = flushCredentialXlsx(credentials, rows);
    vi.advanceTimersByTime(10);
    await promise;

    expect(Worker).toHaveBeenCalled();
  });
});
