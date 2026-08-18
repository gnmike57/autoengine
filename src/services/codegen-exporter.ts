import fs from 'fs';
import path from 'path';

class CodegenExporter {
  private outputDir: string;
  private isEnabled: boolean;
  private activeSessions: Set<string> = new Set();

  constructor() {
    this.isEnabled = process.env.ENGINE_CODEGEN_DEBUG === 'true';
    this.outputDir = path.join(process.cwd(), 'codegen_out');

    if (this.isEnabled) {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
    }
  }

  private getFilepath(sessionId: string, siteName: string) {
    return path.join(this.outputDir, `session-${sessionId}-${siteName}.spec.ts`);
  }

  /**
   * Initializes a new tracking session if not already tracking for this site.
   */
  public startSession(sessionId: string, siteName: string) {
    if (!this.isEnabled) return;
    const key = `${sessionId}-${siteName}`;
    if (this.activeSessions.has(key)) return;
    this.activeSessions.add(key);

    const header = [
      `import { test, expect } from '@playwright/test';\n`,
      `// Auto-generated via Automati Codegen Exporter`,
      `// Site: ${siteName}`,
      `// Session: ${sessionId}\n`,
      `test('engine flow - ${siteName}', async ({ page }) => {\n`,
    ];
    fs.writeFileSync(this.getFilepath(sessionId, siteName), header.join('\n'), 'utf8');
  }

  /**
   * Logs a specific action with an exact duration or timestamp.
   */
  public logAction(sessionId: string, actionDesc: string, siteName?: string) {
    if (!this.isEnabled) return;

    // Find the current active site name for this session (naive fallback)
    let activeSite = siteName;
    if (!activeSite) {
      for (const key of this.activeSessions) {
        if (key.startsWith(`${sessionId}-`)) {
          activeSite = key.split('-').slice(1).join('-');
          break;
        }
      }
    }
    if (!activeSite) return;

    // Get current time formatting (e.g. MM:SS.ms)
    const now = new Date();
    const ts = `${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;

    const lines = [
      `  // [${ts}]`,
      `  ${actionDesc}\n`
    ];
    fs.appendFileSync(this.getFilepath(sessionId, activeSite), lines.join('\n'), 'utf8');
  }

  /**
   * Logs a sleep/delay.
   */
  public logSleep(sessionId: string, ms: number) {
    if (!this.isEnabled) return;
    this.logAction(sessionId, `await page.waitForTimeout(${ms});`);
  }

  /**
   * Ends a session and cleans up the active tracking set.
   */
  public endSession(sessionId: string, siteName: string) {
    if (!this.isEnabled) return;
    const key = `${sessionId}-${siteName}`;
    if (this.activeSessions.has(key)) {
      this.activeSessions.delete(key);
      const footer = `});\n`;
      try {
        fs.appendFileSync(this.getFilepath(sessionId, siteName), footer, 'utf8');
      } catch {
        // Ignore write errors on shutdown
      }
    }
  }
}

export const codegenExporter = new CodegenExporter();
