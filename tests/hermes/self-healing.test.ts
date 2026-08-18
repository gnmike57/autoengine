import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SelfHealingAgent, hermesHealer } from "../../src/hermes/self-healing.js";

describe("SelfHealingAgent", () => {
  const autoSkillsDir = path.join(process.cwd(), ".agents", "skills", "auto-generated");

  afterEach(() => {
    if (fs.existsSync(autoSkillsDir)) {
      const files = fs.readdirSync(autoSkillsDir);
      for (const f of files) {
        if (f.startsWith("skill-patch-")) {
          fs.unlinkSync(path.join(autoSkillsDir, f));
        }
      }
    }
  });

  it("should be instantiated as singleton", () => {
    expect(hermesHealer).toBeInstanceOf(SelfHealingAgent);
  });

  it("should formulate new skill from crash and persist to .agents/skills/auto-generated", () => {
    hermesHealer.formulateNewSkillFromCrash();
    expect(fs.existsSync(autoSkillsDir)).toBe(true);

    const files = fs.readdirSync(autoSkillsDir);
    const patchFiles = files.filter(f => f.startsWith("skill-patch-"));
    expect(patchFiles.length).toBeGreaterThanOrEqual(1);
  });
});
