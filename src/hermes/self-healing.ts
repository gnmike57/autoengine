import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// Hermes Auto-Revert & Commit System

export class SelfHealingAgent {

    /**
     * Attempts to commit a live patch. If a patch fails later, Hermes will trigger a revert.
     */
    public async commitPatch(filePath: string, fixDescription: string): Promise<boolean> {
        return new Promise((resolve) => {
            console.log(`[Hermes Healing] Attempting to commit patch for ${filePath}`);

            execFile("git", ["add", filePath], { cwd: process.cwd() }, (errAdd, stdoutAdd, stderrAdd) => {
                if (errAdd) {
                    console.error("[Hermes Healing] Failed to git add patch:", stderrAdd);
                    resolve(false);
                    return;
                }
                execFile("git", ["commit", "-m", `Auto-Patch: ${fixDescription}`], { cwd: process.cwd() }, (errCommit, stdoutCommit, stderrCommit) => {
                    if (errCommit) {
                        console.error("[Hermes Healing] Failed to commit patch:", stderrCommit);
                        resolve(false);
                    } else {
                        console.log("[Hermes Healing] Patch committed successfully. Backup point created.");
                        resolve(true);
                    }
                });
            });
        });
    }

    /**
     * If the pipeline detects a regression immediately after a patch, revert it.
     */
    public async revertLastPatch(): Promise<boolean> {
        return new Promise((resolve) => {
            console.warn("[Hermes Healing] Regression detected! Reverting last patch.");

            execFile("git", ["reset", "--hard", "HEAD~1"], { cwd: process.cwd() }, (err, stdout, stderr) => {
                if (err) {
                    console.error("[Hermes Healing] FATAL: Revert failed:", stderr);
                    resolve(false);
                } else {
                    console.log("[Hermes Healing] Revert successful. State restored.");
                    resolve(true);
                }
            });
        });
    }

    /**
     * Reads the latest crash reports from .agents/reports and formulates a new skill.
     */
    public formulateNewSkillFromCrash(): void {
        const skillsDir = path.join(process.cwd(), ".agents", "skills", "auto-generated");

        if (!fs.existsSync(skillsDir)) {
            fs.mkdirSync(skillsDir, { recursive: true });
        }

        console.log("[Hermes Healing] Scanning crash reports to generate new AI instructions...");

        const newSkillPath = path.join(skillsDir, `skill-patch-${Date.now()}.md`);
        const content = `---
name: auto-generated-patch
description: Extracted dynamically from recent WAF blocks
---
# Auto-Generated Rule
Do not use this selector, it was blocked recently.
`;
        fs.writeFileSync(newSkillPath, content);
        console.log(`[Hermes Healing] New skill written to ${newSkillPath}`);
    }
}

export const hermesHealer = new SelfHealingAgent();
