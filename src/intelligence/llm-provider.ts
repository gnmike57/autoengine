/* eslint-disable @typescript-eslint/no-explicit-any */
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { createLogger } from "../core/logger.js";

const log = createLogger("llm-provider");

export const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();

export const OPENROUTER_MODEL_NAME = process.env.OPENROUTER_MODEL || "nvidia/nemotron-nano-12b-v2-vl:free";

export interface GenerateOptions {
  prompt: string;
  images?: Buffer[];
  schema?: any;
  timeoutMs?: number;
  modelNameOverride?: string;
  maxAttempts?: number;
}

export interface GenerateResult {
  text: string;
  modelUsed: string;
  durationMs: number;
}

export function isAiAvailable(): boolean {
  return !!OPENROUTER_API_KEY;
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] || "").trim().toLowerCase());
}

export function createOpenRouterProxyAgent(proxyUrl = (process.env.OPENROUTER_PROXY_URL || "").trim()): SocksProxyAgent | HttpsProxyAgent<string> | undefined {
  if (!proxyUrl) {
    if (envFlag("OPENROUTER_REQUIRE_PROXY")) {
      throw new Error("OpenRouter proxy is required but OPENROUTER_PROXY_URL is missing");
    }
    return undefined;
  }
  const protocol = new URL(proxyUrl).protocol.toLowerCase();
  if (protocol === "socks5:" || protocol === "socks5h:") {
    return new SocksProxyAgent(proxyUrl);
  }
  if (protocol === "http:" || protocol === "https:") {
    return new HttpsProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported OpenRouter proxy protocol: ${protocol}`);
}

export async function generateContentWithFallback(options: GenerateOptions): Promise<GenerateResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs || 30_000;
  const maxAttempts = options.maxAttempts || 3;

  if (!isAiAvailable()) {
    throw new Error("No AI providers configured (missing OPENROUTER_API_KEY)");
  }

  // Attempt: OpenRouter Fallback
  const endpoint = "https://openrouter.ai/api/v1/chat/completions";
  const modelName = options.modelNameOverride || OPENROUTER_MODEL_NAME;

  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter fallback requested but no OPENROUTER_API_KEY is configured.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "Automati1-111"
  };

  log.info(`[LLM] Attempting generation with OpenRouter using model: ${modelName}`);

  let finalPrompt = options.prompt;
  if (options.schema) {
    finalPrompt += `\n\nReturn EXACTLY a JSON object matching this schema:\n${JSON.stringify(options.schema, null, 2)}`;
  }

  const messages = [
    {
      role: "user",
      content: [
        ...(options.images || []).map(frame => ({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${frame.toString("base64")}` }
        })),
        { type: "text", text: finalPrompt }
      ]
    }
  ];

  const proxyAgent = createOpenRouterProxyAgent();
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      let timer: NodeJS.Timeout;
      const result = await Promise.race([
        fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelName,
            messages,
            response_format: options.schema ? { type: "json_object" } : undefined
          }),
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OpenRouter/MiniCPM timeout")), timeoutMs);
        })
      ]).finally(() => clearTimeout(timer!));

      if (!result.ok) {
        const errorText = await result.text();
        throw new Error(`OpenRouter HTTP error: ${result.status} ${result.statusText} - ${errorText}`);
      }

      const json = await result.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content?.trim() || "";

      return {
        text,
        modelUsed: modelName,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      attempts++;
      const msg = err instanceof Error ? err.message : String(err);

      if (attempts >= maxAttempts) {
         throw new Error(`Fallback generation failed after ${attempts} attempts: ${msg}`);
      }
      const backoff = 2000;
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  throw new Error("Failed to generate content");
}
