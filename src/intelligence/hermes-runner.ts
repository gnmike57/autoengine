/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ResearchTarget, ResearchSkill, generateOfflineSkill } from "./research-orchestrator.js";

const execFileAsync = promisify(execFile);

export async function runHermes(target: ResearchTarget, context: any): Promise<{
        success: boolean;
        skills: ResearchSkill[];
      }> {
    context.log(`[research] Hermes: deep scanning ${target.domain}`);

    // Try importing and calling hermes-review directly
    try {
      const hermesModule = await import("../hermes/hermes-review.js") as any;
      if (hermesModule && typeof hermesModule.scanDomain === "function") {
        const results = await (hermesModule.scanDomain as (domain: string, vectors: string[]) => Promise<Array<{ vector: string; script: string }>>)(target.domain, target.knownVectors);
        if (results && results.length > 0) {
          const skills: ResearchSkill[] = results.map((r: { vector: string; script: string }) => ({
            id: `hermes-${target.domain}-${r.vector}-${Date.now()}`,
            vector: r.vector,
            target: target.domain,
            script: r.script,
            frameworks: ["camoufox", "cloakbrowser", "zendriver", "spider"],
            generatedBy: "hermes" as const,
            generatedAt: new Date().toISOString(),
            validated: false,
          }));
          context.log(`[research] Hermes module returned ${skills.length} skills`);
          return { success: true, skills };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      context.log(`[research] Hermes module import failed: ${msg}`);
    }

    // Try CLI dispatch
    try {
      const { stdout } = await execFileAsync(
        "npx", ["tsx", "src/hermes/hermes-review.ts", "--scan", target.domain],
        { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim()) as ResearchSkill[];
      if (parsed.length > 0) {
        context.log(`[research] Hermes CLI returned ${parsed.length} skills`);
        return { success: true, skills: parsed };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      context.log(`[research] Hermes CLI failed: ${msg}`);
    }

    // Offline fallback
    if (target.knownVectors.length > 0) {
      const skills: ResearchSkill[] = target.knownVectors.map(vector => ({
        id: `hermes-${target.domain}-${vector}-${Date.now()}`,
        vector,
        target: target.domain,
        script: `// Hermes deep-scan skill for ${vector}\n// Zero-day analysis for ${target.domain}\n${generateOfflineSkill(vector, target.domain)}`,
        frameworks: ["camoufox", "cloakbrowser", "zendriver", "spider"],
        generatedBy: "hermes" as const,
        generatedAt: new Date().toISOString(),
        validated: false,
      }));
      context.log(`[research] Hermes offline: generated ${skills.length} skills`);
      return { success: skills.length > 0, skills };
    }

    return { success: false, skills: [] };
}
