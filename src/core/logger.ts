/**
 * Leveled, tagged logger.
 *
 * Wraps `console.*` so:
 *   • Every line is prefixed with a stable `[tag]` (the existing convention
 *     across the codebase) without each call site having to repeat it.
 *   • Output below the active level is suppressed at zero per-call cost
 *     (single integer comparison).
 *   • Tests that `spyOn(console, "warn"|"error"|...)` continue to work
 *     because the underlying methods are still invoked.
 *
 * Active level is read once from `LOG_LEVEL` (env) at module load. Override
 * at runtime via `setLogLevel()` — used by the dashboard's verbose toggle.
 *
 *   LOG_LEVEL=debug npm start   # show everything
 *   LOG_LEVEL=warn  npm start   # only warn/error
 *   LOG_LEVEL=silent npm test   # mute all log output
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const LEVEL_NAMES: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

// ANSI Color Codes
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bgMagenta: "\x1b[45m",
  white: "\x1b[37m"
};

function readLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

let threshold: number = LEVEL_ORDER[readLevel()];

/** Override the active log level. Returns the previous level. */
export function setLogLevel(level: LogLevel): LogLevel {
  const previous = LEVEL_NAMES[threshold] ?? "info";
  threshold = LEVEL_ORDER[level];
  return previous;
}

/** Read the active log level. */
export function getLogLevel(): LogLevel {
  return LEVEL_NAMES[threshold] ?? "info";
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Logs AI thought processes vividly to the console. Always prints if level <= info. */
  thought(agentName: string, ...args: unknown[]): void;
}

/**
 * Create a logger bound to a `[tag]` prefix.
 *
 * The prefix is computed once per call to `createLogger` and reused by every
 * subsequent emission — keeping the hot path a single string + spread.
 */
export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`;
  const dimPrefix = `${c.dim}${prefix}${c.reset}`;

  return {
    debug: (...args: unknown[]) => {
      if (threshold <= LEVEL_ORDER.debug) console.debug(dimPrefix, c.cyan, ...args, c.reset);
    },
    info: (...args: unknown[]) => {
      if (threshold <= LEVEL_ORDER.info) console.log(dimPrefix, c.green, ...args, c.reset);
    },
    warn: (...args: unknown[]) => {
      if (threshold <= LEVEL_ORDER.warn) console.warn(dimPrefix, c.yellow + c.bold, ...args, c.reset);
    },
    error: (...args: unknown[]) => {
      if (threshold <= LEVEL_ORDER.error) console.error(dimPrefix, c.red + c.bold, ...args, c.reset);
    },
    thought: (agentName: string, ...args: unknown[]) => {
      if (threshold <= LEVEL_ORDER.info) {
        // AI Thoughts are highly visible: Magenta Background, Bold text.
        const thoughtPrefix = `${c.bgMagenta}${c.white}${c.bold} 🧠 [${agentName}] THOUGHT ${c.reset}`;
        console.log(`${thoughtPrefix}\n${c.magenta}${c.italic}`, ...args, c.reset, `\n`);
      }
    }
  };
}
