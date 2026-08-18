import { describe, it, expect, vi } from "vitest";
import { startAsyncFingerprintAudit } from "../../src/stealth/live-auditor.js";

describe("live-auditor", () => {
  function makeMockPage() {
    return {
      evaluate: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("calls page.evaluate with the correct audit URL and args", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = makeMockPage();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    startAsyncFingerprintAudit(page, "Mozilla/5.0 Chrome", "windows", 3011);

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [, args] = page.evaluate.mock.calls[0]!;
    expect(args.url).toBe("http://localhost:3011/audit-fp");
    expect(args.expectedUA).toBe("Mozilla/5.0 Chrome");
    expect(args.expectedOS).toBe("windows");
  });

  it("uses the custom server port when provided", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = makeMockPage();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    startAsyncFingerprintAudit(page, "UA-string", "linux", 9999);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [, args] = page.evaluate.mock.calls[0]!;
    expect(args.url).toBe("http://localhost:9999/audit-fp");
  });

  it("defaults to port 3011 when not specified", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = makeMockPage();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    startAsyncFingerprintAudit(page, "UA", "macos");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [, args] = page.evaluate.mock.calls[0]!;
    expect(args.url).toBe("http://localhost:3011/audit-fp");
  });

  it("gracefully handles page.evaluate rejection without throwing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error("Target closed")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // startAsyncFingerprintAudit is void — the .catch inside handles it
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    expect(() => startAsyncFingerprintAudit(page, "UA", "windows")).not.toThrow();
  });

  it("passes a function as the first evaluate argument", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = makeMockPage();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    startAsyncFingerprintAudit(page, "UA", "windows");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const [evalFn] = page.evaluate.mock.calls[0]!;
    expect(typeof evalFn).toBe("function");
  });
});
