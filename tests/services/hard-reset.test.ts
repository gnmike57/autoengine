import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resetProgressJson, profileRoots } from "../../src/services/hard-reset.js";

describe("Hard Reset Service", () => {
  const testProgressPath = path.join(process.cwd(), "scratch", "test-hard-reset-progress.json");

  beforeEach(() => {
    fs.mkdirSync(path.dirname(testProgressPath), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testProgressPath)) {
      try {
        fs.unlinkSync(testProgressPath);
      } catch {}
    }
  });

  it("should return profile root candidate directories", () => {
    const roots = profileRoots();
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.some(r => r.includes("cloak-profiles"))).toBe(true);
  });

  it("should reset misdirected/failed site progress in progress.json", async () => {
    const initialData = {
      updatedAt: new Date().toISOString(),
      rows: [
        {
          email: "test@example.com",
          status: "done",
          sites: {
            joe: { outcome: "N/A", attempts: 1, error: "misdirection: UPDATE YOUR PIN required" },
            ignition: { outcome: "queued", attempts: 0 }
          }
        }
      ]
    };

    fs.writeFileSync(testProgressPath, JSON.stringify(initialData, null, 2));

    const result = await resetProgressJson(testProgressPath);
    expect(result.rowsTouched).toBe(1);
    expect(result.sitesReset).toBe(1);

    const updated = JSON.parse(fs.readFileSync(testProgressPath, "utf-8"));
    expect(updated.rows[0].sites.joe.outcome).toBe("queued");
    expect(updated.rows[0].sites.joe.attempts).toBe(0);
    expect(updated.rows[0].sites.joe.error).toBeUndefined();
  });
});
