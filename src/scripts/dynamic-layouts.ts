import path from "node:path";
import { createSession } from "../../backends/index.js";
import { BrowserTiler, globalTiler } from "../../src/services/browser-tiler.js";
import { execSync } from "child_process";
import type { ScreenBounds } from "../../src/profiles/viewport-resolver.js";
import os from "os";

// We use 8 windows for the complex layouts
const NUM_WINDOWS = 8;
const ENGINES = ['cloak-headed', 'stealth-headed', 'zendriver-headed', 'stealth-headed', 'cloak-headed', 'zendriver-headed', 'stealth-headed', 'cloak-headed'];

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
    await new Promise(r => setTimeout(r, 2000));
    try { execSync('pkill -9 -f "Camoufox"'); } catch {}
    try { execSync('pkill -9 -f "Google Chrome"'); } catch {}
    try { execSync('pkill -9 -f "Chromium"'); } catch {}
}

// Generate the 15 mathematical layout definitions for 8 windows
function getLayouts(desktopW: number, desktopH: number): ScreenBounds[][] {
    const layouts: ScreenBounds[][] = [];
    const w = desktopW;
    const h = desktopH;

    // Helper to push a valid array of exactly NUM_WINDOWS bounds
    const addLayout = (b: ScreenBounds[]) => {
        // Pad or slice to exactly NUM_WINDOWS
        let padIdx = 0;
        while (b.length < NUM_WINDOWS) {
            // Neatly stack leftover windows off to the side so they don't awkwardly cover things
            b.push({ x: (padIdx * 50), y: 31, width: 200, height: 200 });
            padIdx++;
        }

        // Offset all y-coordinates by 31 to avoid the macOS menu bar
        const adjusted = b.slice(0, NUM_WINDOWS).map(pos => ({
            ...pos,
            y: pos.y + 31
        }));

        layouts.push(adjusted);
    };

    // 1. Classic 4x2 Grid (Top-to-bottom, Left-to-right)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: (i % 4) * (w / 4), y: Math.floor(i / 4) * (h / 2),
        width: w / 4, height: h / 2
    })));

    // 2. Vertical Strips (1x8)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: i * (w / 8), y: 0,
        width: w / 8, height: h
    })));

    // 3. Horizontal Strips (8x1)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: 0, y: i * (h / 8),
        width: w, height: h / 8
    })));

    // 4. Picture-in-Picture Cascading (Main large window, others small overlay)
    const pip = [{ x: 0, y: 0, width: w, height: h }];
    for (let i = 1; i < 8; i++) pip.push({ x: w - (i * 150), y: h - 200, width: 140, height: 190 });
    addLayout(pip);

    // 5. Diagonal Stepping
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: i * (w / 8), y: i * (h / 8),
        width: w / 8, height: h / 8
    })));

    // 6. Centered Diamond/Cross (approximate via overlapping)
    addLayout(Array.from({length: 8}).map((_, i) => {
        const cx = w/2, cy = h/2;
        const radius = Math.min(w, h) / 3;
        const angle = (i / 8) * Math.PI * 2;
        return { x: cx + Math.cos(angle) * radius - (w/8), y: cy + Math.sin(angle) * radius - (h/8), width: w/4, height: h/4 };
    }));

    // 7. Radar Sweep (Circle overlapping)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: (w/2 - 200) + Math.cos((i/8) * Math.PI*2) * 300,
        y: (h/2 - 200) + Math.sin((i/8) * Math.PI*2) * 300,
        width: 400, height: 400
    })));

    // 8. 2x4 Grid (2 Cols, 4 Rows)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: (i % 2) * (w / 2), y: Math.floor(i / 2) * (h / 4),
        width: w / 2, height: h / 4
    })));

    // 9. Split Screen (2 massive, 6 tiny)
    addLayout([
        { x: 0, y: 0, width: w/2, height: h },
        { x: w/2, y: 0, width: w/2, height: h },
        ...Array.from({length: 6}).map((_, i) => ({ x: (i*w/6), y: h/2 - 50, width: w/6, height: 100 }))
    ]);

    // 10. Golden Spiral (Fibonacci approximation)
    addLayout([
        { x: 0, y: 0, width: w, height: h }, // Doesn't exactly fit golden ratio to full screen, just aesthetic
        { x: w*0.618, y: 0, width: w*0.382, height: h },
        { x: w*0.618, y: h*0.618, width: w*0.382, height: h*0.382 },
        { x: w*0.618, y: h*0.618, width: w*0.146, height: h*0.382 },
        { x: 0, y: 0, width: 300, height: 300 },
        { x: 300, y: 0, width: 300, height: 300 },
        { x: 600, y: 0, width: 300, height: 300 },
        { x: 900, y: 0, width: 300, height: 300 }
    ]);

    // 11. Staggered Cascade (macOS style window dropping)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: i * 80, y: i * 50,
        width: w * 0.5, height: h * 0.6
    })));

    // 12. Reverse Cascade
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: w - (i * 80) - (w * 0.5), y: h - (i * 50) - (h * 0.6),
        width: w * 0.5, height: h * 0.6
    })));

    // 13. Outer Ring (Hollow Center)
    addLayout([
        { x: 0, y: 0, width: w/3, height: h/3 }, { x: w/3, y: 0, width: w/3, height: h/3 }, { x: (w/3)*2, y: 0, width: w/3, height: h/3 },
        { x: 0, y: h/3, width: w/3, height: h/3 }, /* skip center */ { x: (w/3)*2, y: h/3, width: w/3, height: h/3 },
        { x: 0, y: (h/3)*2, width: w/3, height: h/3 }, { x: w/3, y: (h/3)*2, width: w/3, height: h/3 }, { x: (w/3)*2, y: (h/3)*2, width: w/3, height: h/3 }
    ]);

    // 14. Convergence (All squished to center)
    addLayout(Array.from({length: 8}).map(() => ({
        x: w/2 - 100, y: h/2 - 100,
        width: 200, height: 200
    })));

    // 15. Explosion (All scatter back to classic 4x2)
    addLayout(Array.from({length: 8}).map((_, i) => ({
        x: (i % 4) * (w / 4), y: Math.floor(i / 4) * (h / 2),
        width: w / 4, height: h / 2
    })));

    return layouts;
}

async function run() {
    console.log(`\n=== Dynamic WebExtension Layout Rotation Engine ===\n`);
    await gracefulKill();

    // Get true screen size from OS (fallback to 1920x1080)
    let deskW = 1920; let deskH = 1080 - 31;
    try {
        if (os.platform() === 'darwin') {
            const raw = execSync("system_profiler SPDisplaysDataType | grep Resolution").toString();
            const m = raw.match(/(\d+)\s*x\s*(\d+)/);
            if (m && m[1] && m[2]) { deskW = parseInt(m[1]); deskH = parseInt(m[2]) - 31; } // Subtract 31 for Apple Menu Bar
        }
    } catch {}

    const layouts = getLayouts(deskW, deskH);
    const sessions: any[] = [];

    // Configure global tiler just to satisfy initial headed-grid launch (we'll override dynamically anyway)
    globalTiler.reconfigure(NUM_WINDOWS, { cols: 4, rows: 2 });

    console.log(`[Phase 1] Launching all ${NUM_WINDOWS} windows concurrently...`);
    const launchPromises = Array.from({ length: NUM_WINDOWS }).map(async (_, i) => {
        const backend = ENGINES[i % ENGINES.length]!;
        const color = COLORS[i % COLORS.length]!;
        try {
            const s = await createSession({ backend: backend as any, mode: 'headed-grid' });

            // Go to a real URL so WebExtension content scripts inject properly (they ignore data: and about:blank)
            await s.page.goto('http://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {});

            const html = `
                <html>
                    <body style="margin:0; padding:0; background-color:${color.hex}; display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; font-family:sans-serif; color:white; overflow:hidden;">
                        <h1 style="font-size: 5vw; margin:0; text-align:center;">${backend.toUpperCase()}</h1>
                        <h2 style="font-size: 3vw; margin:0; opacity: 0.8;">SLOT ${i}</h2>
                    </body>
                </html>
            `;
            await s.page.setContent(html).catch(() => {});
            return { session: s, backend };
        } catch (e: any) {
            console.error(`Failed to launch slot ${i}:`, e.message);
            return null;
        }
    });

    const results = await Promise.all(launchPromises);
    for (const r of results) {
        if (r) sessions.push(r);
    }

    console.log(`\n[Phase 2] Initializing dynamic rotation! Stand back and watch the screen...`);
    await new Promise(r => setTimeout(r, 2000));

    for (let step = 0; step < layouts.length; step++) {
        console.log(`\n-> Applying Layout ${step + 1}/${layouts.length}`);
        const currentLayout = layouts[step];

        // Issue simultaneous move commands
        const movePromises = sessions.map((sData, idx) => {
            const targetBounds = currentLayout![idx];
            return BrowserTiler.moveWindowDynamically(sData.session, sData.backend, targetBounds!);
        });

        await Promise.all(movePromises);
        console.log(`   Layout ${step + 1} locked. Holding for 4 seconds...`);
        await new Promise(r => setTimeout(r, 4000));
    }

    console.log(`\n[Phase 3] Teardown`);
    for (const s of sessions) {
        if (s && s.session && s.session.close) {
            try { await s.session.close(); } catch {}
        }
    }
    await gracefulKill();
}

export { getLayouts, run as runDynamicLayouts };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  run().catch(console.error);
}

