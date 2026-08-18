/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ResearchTarget, ResearchSkill, generateOfflineSkill } from "./research-orchestrator.js";

const execFileAsync = promisify(execFile);

export async function runAutoResearchClaw(target: ResearchTarget, context: any): Promise<{
        success: boolean;
        skills: ResearchSkill[];
      }> {
    context.log(`[research] ARC: scanning ${target.domain} for vectors: ${target.knownVectors.join(", ")}`);

    // Try local Node.js script first
    try {
      const tsScriptPath = "scripts/arc-scan.ts";
      if (fs.existsSync(tsScriptPath)) {
        const { stdout } = await execFileAsync(
          "npx", ["tsx", tsScriptPath, "--target", target.domain, "--vectors", target.knownVectors.join(",")],
          { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout.trim()) as ResearchSkill[];
        if (parsed.length > 0) {
          context.log(`[research] ARC script returned ${parsed.length} skills`);
          return { success: true, skills: parsed };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      context.log(`[research] ARC script failed: ${msg}`);
    }

    // Try Python deploy_skills.py
    try {
      const pyScriptPath = "deploy_skills.py";
      if (fs.existsSync(pyScriptPath)) {
        const { stdout } = await execFileAsync(
          "python", [pyScriptPath, "--target", target.domain, "--browser", "zendriver"],
          { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout.trim()) as ResearchSkill[];
        if (parsed.length > 0) {
          context.log(`[research] ARC Python returned ${parsed.length} skills`);
          return { success: true, skills: parsed };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      context.log(`[research] ARC Python failed: ${msg}`);
    }

    // Offline mode: generate skills from known detection vectors
    if (target.knownVectors.length > 0) {
      const skills: ResearchSkill[] = target.knownVectors.map(vector => ({
        id: `arc-${target.domain}-${vector}-${Date.now()}`,
        vector,
        target: target.domain,
        script: generateOfflineSkill(vector, target.domain),
        frameworks: ["camoufox", "cloakbrowser", "zendriver", "spider"],
        generatedBy: "autoresearchclaw" as const,
        generatedAt: new Date().toISOString(),
        validated: false,
      }));
      context.log(`[research] ARC offline mode: generated ${skills.length} skills from known vectors`);
      return { success: skills.length > 0, skills };
    }

    return { success: false, skills: [] };
}
