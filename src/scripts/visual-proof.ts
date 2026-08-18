import { createSession } from "../../backends/index.js";
import { execSync } from "child_process";

export const testEngines = [
    'cloak-headed',
    'stealth-headed',
    'zendriver-headed',
    'cloak-headed'
];

const COLORS = [
    { name: "BLUE", hex: "#3b82f6" },
    { name: "RED", hex: "#ef4444" },
    { name: "GREEN", hex: "#10b981" },
    { name: "PURPLE", hex: "#8b5cf6" },
    { name: "ORANGE", hex: "#f97316" },
    { name: "PINK", hex: "#ec4899" },
    { name: "YELLOW", hex: "#eab308" },
    { name: "CYAN", hex: "#06b6d4" },
];

async function gracefulKill() {
    console.log("Gracefully shutting down leftover browsers...");
    try { execSync(`osascript -e 'tell application "Camoufox" to quit'`); } catch {}
    try { execSync(`osascript -e 'tell application "Google Chrome" to quit'`); } catch {}
    try { execSync(`osascript -e 'tell application "Chromium" to quit'`); } catch {}
    // Wait for graceful exit
    await new Promise(r => setTimeout(r, 2000));
    // Force kill the rest
    try { execSync('pkill -9 -f "Camoufox"'); } catch {}
    try { execSync('pkill -9 -f "Google Chrome"'); } catch {}
    try { execSync('pkill -9 -f "Chromium"'); } catch {}
}

async function runVisualProof(numWindows: number) {
    console.log(`\n=== Starting Visual Proof with ${numWindows} Windows ===\n`);
    const sessions: any[] = [];

    await gracefulKill();

    // Setup engines array for N windows
    const engines = [];
    for (let i = 0; i < numWindows; i++) {
        engines.push(testEngines[i % testEngines.length]);
    }

    for (let i = 0; i < numWindows; i++) {
        const backend = engines[i]!;
        const color = COLORS[i % COLORS.length]!;
        console.log(`[Slot ${i}] Launching ${backend} with color ${color.name}...`);

        try {
            const s = await createSession({
                backend: backend as any,
                mode: 'headed-grid'
            });
            sessions.push(s);

            const html = `
                <html>
                    <body style="margin:0; padding:0; background-color:${color.hex}; display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; font-family:sans-serif; color:white;">
                        <h1 style="font-size: 5vw; margin:0;">${backend.toUpperCase()}</h1>
                        <h2 style="font-size: 3vw; margin:0; opacity: 0.8;">SLOT ${i}</h2>
                    </body>
                </html>
            `;

            await s.page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

            // Output bounds
            const b = await s.page.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight }));
            console.log(`[Slot ${i} - ${backend}] PHYSICAL BOUNDS: x=${b.x} y=${b.y} outerW=${b.w} outerH=${b.h}`);
        } catch (e: any) {
            console.error(`[Slot ${i}] Failed to launch ${backend}:`, e.message);
        }
    }

    console.log(`\nAll ${numWindows} windows launched! Please visually verify your screen and the Dock.`);
    console.log(`Holding for 15 seconds before tearing down...`);
    await new Promise(r => setTimeout(r, 15000));

    console.log(`Tearing down...`);
    for (const s of sessions) {
        if (s && s.close) {
            try { await s.close(); } catch {}
        }
    }

    await gracefulKill();
}

async function main() {
    const variations = [2, 4, 6, 8];
    for (const v of variations) {
        await runVisualProof(v);
        await new Promise(r => setTimeout(r, 3000));
    }
}
main().catch(console.error);
