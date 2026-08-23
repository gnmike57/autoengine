import fs from "node:fs";
import path from "node:path";
import type { TimelineManifest } from "../services/timeline-recorder.js";
import { ollamaClient } from "../core/ollama-client.js";
import { generateContentWithFallback, isAiAvailable } from "../intelligence/llm-provider.js";
import { createLogger } from "../core/logger.js";
import { EventEmitter } from "node:events";

export const timelineEvents = new EventEmitter();

const log = createLogger("TimelineAnalyzer");

export class TimelineAnalyzer {
  static async analyzeTimeline(sessionId: string): Promise<string | null> {
    const sessionDir = path.join(process.cwd(), "screenshots", "timelines", sessionId);
    const manifestPath = path.join(sessionDir, "timeline-manifest.json");

    if (!fs.existsSync(manifestPath)) {
      log.warn(`Manifest not found for session ${sessionId}`);
      return null;
    }

    const manifest: TimelineManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (manifest.frames.length === 0) {
      log.warn(`No frames found in timeline for ${sessionId}`);
      return null;
    }

    // Limit to max 15 frames for AI token limits (take evenly spaced samples if > 15)
    let selectedFrames = manifest.frames;
    if (selectedFrames.length > 15) {
      const step = Math.ceil(selectedFrames.length / 15);
      selectedFrames = selectedFrames.filter((_, i) => i % step === 0).slice(0, 15);
    }

    let promptText = `
You are Hermes AI, the ultimate QA automation engineer.
I am providing you a sequence of screenshots captured every 500ms during an automated browser execution on a specific target site.
These screenshots represent the visual timeline of the execution.

Your task:
1. Identify if the login was successful or if it failed.
2. If it failed, point out exactly which step (timestamp/offset) the failure or anomaly occurred (e.g., CAPTCHA appeared, page crashed, incorrect password error, Cloudflare block).
3. Evaluate the automation's interaction based on the visual evidence. Did it type credentials? Did it click submit? Was it blocked before it could?

Provide a structured, chronological breakdown of the execution timeline and your final diagnostic conclusion.
    `;
    const base64Images: string[] = [];
    const imageBuffers: Buffer[] = [];

    for (const frame of selectedFrames) {
      const imgPath = path.join(sessionDir, frame.imagePath);
      if (fs.existsSync(imgPath)) {
        const buf = fs.readFileSync(imgPath);
        imageBuffers.push(buf);
        const rawBase64 = buf.toString("base64");
        const cleanBase64 = rawBase64.replace(/^data:image\/\w+;base64,/, '');
        base64Images.push(cleanBase64);
        promptText += `\nFrame at +${frame.offsetMs}ms`;
      }
    }

    try {
      log.thought("Hermes", `Analyzing timeline for session ${sessionId} with ${selectedFrames.length} frames...`);

      // 1. Try local Ollama models first
      let response1 = "";
      let response2 = "";

      const queryModel = async (modelName: string) => {
        try {
          const response = await ollamaClient.chat({
            model: modelName,
            messages: [{
              role: 'user',
              content: promptText + "\nEND YOUR RESPONSE WITH EITHER [SUCCESS], [FAILED], OR [UNKNOWN].",
              images: base64Images
            }]
          });
          return response.message?.content?.trim() || "";
        } catch (err) {
          return "";
        }
      };

      [response1, response2] = await Promise.all([
        queryModel('llava'),
        queryModel('llava:latest')
      ]);

      // 2. If Ollama is unavailable, fallback to OpenRouter / Gemini
      if (!response1 && isAiAvailable()) {
        try {
          log.info(`[TimelineAnalyzer] Local Ollama unavailable — routing timeline analysis to cloud vision model...`);
          const cloudRes = await generateContentWithFallback({
            prompt: promptText + "\nEND YOUR RESPONSE WITH EITHER [SUCCESS], [FAILED], OR [UNKNOWN].",
            images: imageBuffers,
            timeoutMs: 30000,
          });
          response1 = cloudRes.text.trim();
        } catch (cloudErr) {
          log.warn(`Cloud vision fallback failed: ${String(cloudErr)}`);
        }
      }

      const extractVerdict = (text: string) => {
        if (text.includes("[SUCCESS]")) return "success";
        if (text.includes("[FAILED]")) return "failed";
        return "unknown";
      };

      const verdict1 = extractVerdict(response1);
      const verdict2 = response2 ? extractVerdict(response2) : verdict1;

      let finalResponse = "";

      if (verdict1 !== "unknown" && (verdict1 === verdict2 || !response2)) {
        log.thought("Hermes", `Timeline Diagnosis: ${verdict1.toUpperCase()}`);
        finalResponse = `=== TIMELINE ANALYSIS ===\n\nVerdict: [${verdict1.toUpperCase()}]\n\n${response1}`;
      } else if (response1 || response2) {
        finalResponse = `=== TIMELINE ANALYSIS ===\n\nModel 1:\n${response1}\n\nModel 2:\n${response2}`;
      } else {
        finalResponse = `=== TIMELINE ANALYSIS ===\n\nNo vision models available to analyze timeline.`;
      }

      const analysisPath = path.join(sessionDir, "hermes-analysis.md");
      fs.writeFileSync(analysisPath, finalResponse);

      return finalResponse;

    } catch (localErr) {
      log.warn(`Timeline analysis error (${String(localErr)}).`);
    }

    return null;
  }
}
