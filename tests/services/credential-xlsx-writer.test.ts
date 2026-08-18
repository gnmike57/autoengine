import { describe, it, expect } from "vitest";
import {
  initXlsxWriter,
  recordPasswordResult
} from "../../src/services/credential-xlsx-writer.js";

describe("Credential XLSX Writer", () => {
  it("should initialize XLSX writer path correctly", () => {
    initXlsxWriter("data/credentials.csv");
    initXlsxWriter("data/credentials.csv", "data/custom.xlsx");
  });

  it("should record password results into row object", () => {
    const row: any = {};
    recordPasswordResult(row, 0, "incorrect", "joe");
    expect(row._passwordResults.length).toBe(1);
    expect(row._passwordResults[0].outcome).toBe("incorrect");
    expect(row._passwordResults[0].attemptIndex).toBe(0);

    // Update existing
    recordPasswordResult(row, 0, "tempdisabled", "joe");
    expect(row._passwordResults.length).toBe(1);
    expect(row._passwordResults[0].outcome).toBe("tempdisabled");
  });
});
