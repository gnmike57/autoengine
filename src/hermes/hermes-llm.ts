/**
 * hermes-llm.ts
 *
 * Unified LLM client for Hermes agents.
 * Supports OpenRouter (cloud) with Ollama (local) fallback.
 * Provides text analysis and vision (screenshot) analysis.
 *
 * Usage:
 *   const llm = new HermesLLM();
 *   const analysis = await llm.analyzeText("What went wrong?", context);
 *   const visionResult = await llm.analyzeScreenshot(buffer, "What do you see?");
 */

import fs from "node:fs";
import { createLogger } from "../core/logger.js";
import { withResilience } from "../core/network-resilience.js";

const log = createLogger("HermesLLM");

// ── Types ──────────────────────────────────────────────────────────────────

export interface LLMResponse {
  content: string;
  model: string;
  provider: "openrouter" | "ollama" | "none";
  latencyMs: number;
  error?: string;
}

export interface LLMConfig {
  /** OpenRouter API key (from env) */
  openRouterApiKey?: string;
  /** Primary model for text analysis (OpenRouter) */
  textModel?: string;
  /** Primary model for vision analysis (OpenRouter) */
  visionModel?: string;
  /** Ollama model for local fallback */
  ollamaModel?: string;
  /** Max tokens for response */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_CONFIG: Required<LLMConfig> = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  textModel: "google/gemini-2.0-flash-001",  // Fast, cheap, good for analysis
  visionModel: "google/gemini-2.0-flash-001", // Supports vision
  ollamaModel: "llama3",
  maxTokens: 1024,
  temperature: 0.3,
};

// ── HermesLLM ──────────────────────────────────────────────────────────────

export class HermesLLM {
  private config: Required<LLMConfig>;
  private requestCount = 0;
  private totalLatencyMs = 0;

  constructor(config?: Partial<LLMConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if any LLM provider is available.
   */
  isAvailable(): boolean {
    return !!this.config.openRouterApiKey;
  }

  /**
   * Analyze text with the LLM. Used for real-time flow analysis,
   * anomaly explanation, and suggestion generation.
   */
  async analyzeText(
    systemPrompt: string,
    userContent: string
  ): Promise<LLMResponse> {
    if (!this.config.openRouterApiKey) {
      return this.tryOllamaFallback(systemPrompt + "\n\n" + userContent);
    }

    const start = performance.now();
    try {
      const response = await withResilience(async () => {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.openRouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://automati.dev",
            "X-Title": "Hermes Observer",
          },
          body: JSON.stringify({
            model: this.config.textModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent }
            ],
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
          })
        });
        
        if (!res.ok) {
          const err = new Error(`OpenRouter API error: ${res.statusText}`) as any;
          err.status = res.status;
          throw err;
        }
        return res;
      }, { contextName: "HermesLLM.analyzeText" });

      const data = (await response.json()) as Record<string, any>;
      const latencyMs = Math.round(performance.now() - start);
      this.requestCount++;
      this.totalLatencyMs += latencyMs;

      if (data.error) {
        log.warn(`[HermesLLM] OpenRouter error: ${JSON.stringify(data.error)}`);
        return this.tryOllamaFallback(systemPrompt + "\n\n" + userContent);
      }

      const content = data.choices?.[0]?.message?.content || "";
      return {
        content,
        model: this.config.textModel,
        provider: "openrouter",
        latencyMs,
      };
    } catch (err) {
      log.warn(`[HermesLLM] OpenRouter failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.tryOllamaFallback(systemPrompt + "\n\n" + userContent);
    }
  }

  /**
   * Analyze a screenshot with vision capabilities.
   * The screenshot is sent as a base64-encoded image.
   */
  async analyzeScreenshot(
    screenshotBuffer: Buffer,
    prompt: string
  ): Promise<LLMResponse> {
    if (!this.config.openRouterApiKey) {
      return { content: "", model: "none", provider: "none", latencyMs: 0, error: "No API key" };
    }

    const start = performance.now();
    const base64Image = screenshotBuffer.toString("base64");

    try {
      const response = await withResilience(async () => {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.openRouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://automati.dev",
            "X-Title": "Hermes Vision",
          },
          body: JSON.stringify({
            model: this.config.visionModel,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ]
              }
            ],
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
          })
        });

        if (!res.ok) {
          const err = new Error(`OpenRouter API error: ${res.statusText}`) as any;
          err.status = res.status;
          throw err;
        }
        return res;
      }, { contextName: "HermesLLM.analyzeScreenshot" });

      const data = (await response.json()) as Record<string, any>;
      const latencyMs = Math.round(performance.now() - start);
      this.requestCount++;
      this.totalLatencyMs += latencyMs;

      if (data.error) {
        log.warn(`[HermesLLM] Vision error: ${JSON.stringify(data.error)}`);
        return { content: "", model: this.config.visionModel, provider: "openrouter", latencyMs, error: String(data.error) };
      }

      return {
        content: data.choices?.[0]?.message?.content || "",
        model: this.config.visionModel,
        provider: "openrouter",
        latencyMs,
      };
    } catch (err) {
      return {
        content: "",
        model: this.config.visionModel,
        provider: "openrouter",
        latencyMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Analyze a screenshot from a file path.
   */
  async analyzeScreenshotFile(
    filePath: string,
    prompt: string
  ): Promise<LLMResponse> {
    try {
      const buffer = fs.readFileSync(filePath);
      return this.analyzeScreenshot(buffer, prompt);
    } catch (err) {
      return {
        content: "",
        model: "none",
        provider: "none",
        latencyMs: 0,
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Try Ollama as a local fallback.
   */
  private async tryOllamaFallback(prompt: string): Promise<LLMResponse> {
    const start = performance.now();
    try {
      const { Ollama } = await import("ollama");
      const ollama = new Ollama();
      const response = await ollama.chat({
        model: this.config.ollamaModel,
        messages: [{ role: "user", content: prompt }],
      });
      return {
        content: response.message.content || "",
        model: this.config.ollamaModel,
        provider: "ollama",
        latencyMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        content: "",
        model: "none",
        provider: "none",
        latencyMs: Math.round(performance.now() - start),
        error: `No LLM available: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get LLM usage statistics.
   */
  getStats(): { requestCount: number; totalLatencyMs: number; avgLatencyMs: number } {
    return {
      requestCount: this.requestCount,
      totalLatencyMs: this.totalLatencyMs,
      avgLatencyMs: this.requestCount > 0 ? Math.round(this.totalLatencyMs / this.requestCount) : 0,
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance: HermesLLM | null = null;

export function getHermesLLM(): HermesLLM {
  if (!_instance) {
    _instance = new HermesLLM();
  }
  return _instance;
}
