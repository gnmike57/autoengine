import { Ollama } from 'ollama';
import { generateContentWithFallback } from '../intelligence/llm-provider.js';
import { createLogger } from './logger.js';

const log = createLogger('OllamaClient');

// Create a single shared instance of the Ollama client
// pointing to the local daemon (default port 11434).
export const ollamaClient = new Ollama({ host: 'http://127.0.0.1:11434' });

export async function askLlama(prompt: string, systemPrompt?: string, jsonMode = false): Promise<string> {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    try {
        const response = await ollamaClient.chat({
            model: 'llama3',
            messages,
            format: jsonMode ? 'json' : undefined,
        });
        return response.message.content || "";
    } catch (error) {
        log.warn(`Local Llama3 failed (${String(error)}), falling back to External API...`);
        const fallbackPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
        const result = await generateContentWithFallback({
            prompt: fallbackPrompt,
            timeoutMs: 15000
        });
        return result.text;
    }
}

export async function askLlava(prompt: string, base64Image: string, systemPrompt?: string): Promise<string> {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    // Clean base64 string if it has a data URI prefix
    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

    messages.push({
        role: 'user',
        content: prompt,
        images: [cleanBase64]
    });

    try {
        const response = await ollamaClient.chat({
            model: 'llava',
            messages,
        });
        return response.message.content || "";
    } catch (error) {
        log.warn(`Local Llava failed (${String(error)}), falling back to External API (OpenRouter)...`);
        const fallbackPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
        const imgBuffer = Buffer.from(cleanBase64, 'base64');
        const result = await generateContentWithFallback({
            prompt: fallbackPrompt,
            images: [imgBuffer],
            timeoutMs: 25000
        });
        return result.text;
    }
}
