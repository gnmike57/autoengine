import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { codegenExporter } from "../../src/services/codegen-exporter.js";
import fs from "node:fs";

vi.mock("node:fs", () => {
  return {
    default: {
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn()
    }
  };
});

describe("codegen-exporter", () => {
  const originalEnv = process.env.ENGINE_CODEGEN_DEBUG;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.ENGINE_CODEGEN_DEBUG = originalEnv;
    // Reset internal sets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).activeSessions.clear();
  });

  it("does nothing if disabled", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).isEnabled = false;
    codegenExporter.startSession("123", "test-site");
    codegenExporter.logAction("123", "action");
    codegenExporter.logSleep("123", 100);

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });

  it("creates header when session starts", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).isEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).activeSessions.clear();

    codegenExporter.startSession("123", "test-site");

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const content = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
    expect(content).toContain("import { test, expect } from '@playwright/test';");
    expect(content).toContain("test('engine flow - test-site'");
    
    // Starting the same session again should not rewrite the header
    codegenExporter.startSession("123", "test-site");
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("appends action when session is active", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).isEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).activeSessions.add("123-test-site");

    codegenExporter.logAction("123", "await page.click('#btn');");

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const content = vi.mocked(fs.appendFileSync).mock.calls[0]![1] as string;
    expect(content).toContain("await page.click('#btn');");
  });

  it("infers active site if siteName is omitted", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).isEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).activeSessions.add("abc-inferred-site");

    codegenExporter.logAction("abc", "await page.type('#input', 'text');");

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const filename = vi.mocked(fs.appendFileSync).mock.calls[0]![0] as string;
    expect(filename).toContain("abc-inferred-site.spec.ts");
  });

  it("appends sleep properly", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).isEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (codegenExporter as any).activeSessions.add("123-test-site");

    codegenExporter.logSleep("123", 1500);

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const content = vi.mocked(fs.appendFileSync).mock.calls[0]![1] as string;
    expect(content).toContain("await page.waitForTimeout(1500);");
  });
});
