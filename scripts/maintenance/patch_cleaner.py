import sys

with open('src/services/process-cleaner.ts', 'r') as f:
    c = f.read()

# Add sync global cleanup handler
sync_code = """
export function installGlobalCleanupHandlers(opts: { label?: string } = {}): void {
  const log = makeLogger(opts.label || "global-hook");
  const cleanup = () => {
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /F /IM cloakbrowser.exe /T 2>NUL`);
        execSync(`taskkill /F /IM camoufox.exe /T 2>NUL`);
      } else {
        // Fallback for Unix: try to kill pids based on naive search
        // We can't easily do ps -axo async here because we might be in a sync exit hook
        // but we can run a sync command.
        try {
          const out = execSync("ps -axo pid=,command=").toString();
          for (const line of out.split('\\n')) {
            const m = line.match(/^\\s*(\\d+)\\s+(.+)$/);
            if (!m) continue;
            const pid = parseInt(m[1], 10);
            const cmd = m[2];
            if (/(camoufox|cloakbrowser|chrome.*--user-data-dir)/i.test(cmd)) {
              if (cmd.includes("chrome-dashboard")) continue;
              try { process.kill(pid, "SIGKILL"); } catch { }
            }
          }
        } catch {}
      }
    } catch { }
  };

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
  });
  
  process.on("unhandledRejection", (err) => {
    log.error(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
  });
  
  process.on("exit", () => {
    cleanup();
  });
}
"""

if "export function installGlobalCleanupHandlers" not in c:
    c += "\n" + sync_code

with open('src/services/process-cleaner.ts', 'w') as f:
    f.write(c)
