import fetch from "node-fetch";
import fs from "fs";

/**
 * Visual Verification Lock
 * Validates the terminal DOM outcome against the OpenRouter vision model's analysis
 * of the final screenshot.
 */
export async function enforceVisualLock(imagePath: string, domOutcome: string): Promise<"CONFIRM" | "REJECT" | "RATE_LIMIT"> {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
        console.warn("[Visual Lock] OPENROUTER_API_KEY is not set.");
        return "REJECT";
    }

    if (!fs.existsSync(imagePath)) {
        console.warn(`[Visual Lock] Missing screenshot at ${imagePath}, failing open.`);
        return "REJECT";
    }

    const base64Image = fs.readFileSync(imagePath).toString("base64");

    try {
        console.log(`[Visual Lock] Querying nemotron-nano for visual confirmation of: ${domOutcome}`);
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nvidia/nemotron-nano-12b-v2-vl:free",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `Does this image clearly show a "${domOutcome}" outcome? Reply only with [CONFIRM] or [REJECT].` },
                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                        ]
                    }
                ]
            })
        });

        if (response.status === 429) {
            console.warn("[Visual Lock] OpenRouter Rate Limit Exceeded (HTTP 429).");
            return "RATE_LIMIT";
        }

        const data = await response.json() as any;
        if (data?.error?.message?.toLowerCase().includes("rate limit")) {
             console.warn("[Visual Lock] OpenRouter Rate Limit Exceeded (Error msg).");
             return "RATE_LIMIT";
        }

        const reply = data.choices?.[0]?.message?.content?.trim() || "";

        console.log(`[Visual Lock] Vision Model Reply: ${reply}`);
        return reply.includes("[CONFIRM]") ? "CONFIRM" : "REJECT";
    } catch (e: any) {
        if (e.message?.includes("timeout") || e.message?.includes("429")) {
             console.warn("[Visual Lock] API Rate Limit / Timeout:", e);
             return "RATE_LIMIT";
        }
        console.error("[Visual Lock] API failure:", e);
        return "REJECT"; // Fail closed by default if it's a random failure
    }
}
