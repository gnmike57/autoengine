import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function persistHealedSelector(siteName: string, field: 'username' | 'password', newSelector: string) {
    try {
        // Resolve to src/targets/index.ts
        const filePath = path.resolve(__dirname, '..', 'targets', 'index.ts');
        let content = fs.readFileSync(filePath, 'utf-8');

        // Find the block for the specific site
        // Matches from "export const Target..." down to "};" ensuring it contains name: "siteName"
        const siteRegex = new RegExp(`export const Target[A-Za-z0-9_]+: SiteConfig = (?:(?!export const Target)[\\s\\S])*?name: "${siteName}"[\\s\\S]*?selectors: {[\\s\\S]*?};`, 'g');
        const match = siteRegex.exec(content);

        if (match) {
            let block = match[0];
            const fieldRegex = new RegExp(`${field}: ".*"`, 'g');
            // Escape any quotes in the new selector
            const escapedSelector = newSelector.replace(/"/g, '\\"');
            block = block.replace(fieldRegex, `${field}: "${escapedSelector}"`);

            content = content.slice(0, match.index) + block + content.slice(match.index + match[0].length);
            fs.writeFileSync(filePath, content, 'utf-8');
            console.log(`[Hermes Cache] 💾 Permanently updated ${field} selector for site ${siteName} in src/targets/index.ts`);
        } else {
            console.warn(`[Hermes Cache] Could not find SiteConfig block for ${siteName} in index.ts`);
        }
    } catch (e: unknown) {
        console.warn(`[Hermes Cache] Failed to persist selector: ${e instanceof Error ? e.message : String(e)}`);
    }
}
