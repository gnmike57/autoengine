/**
 * Environment-variable parsing helpers.
 *
 * Replaces the `parseInt(process.env.X || "default")` boilerplate that was
 * scattered across cloak-backend.ts and manager-config.ts. The previous
 * pattern silently turned typos into NaN; this version logs a warning and
 * falls back to the default so configuration mistakes are visible.
 */
import { createLogger } from "./logger.js";

const log = createLogger("env");

/** Parse an integer env var, falling back to `def` and warning on bad input. */
export function getEnvInt(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  const trimmed = raw.trim();
  const n = parseInt(trimmed, 10);
  const stripped = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  if (!Number.isFinite(n) || (`${n}` !== stripped && stripped !== "-0")) {
    log.warn(`${key}="${raw}" is not a valid integer — using default ${def}`);
    return def;
  }
  return n;
}

/** Parse a boolean env var. Truthy: "1", "true", "yes" (case-insensitive). */
export function getEnvBool(key: string, def: boolean): boolean {
  const raw = (process.env[key] ?? "").trim().toLowerCase();
  if (raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  log.warn(`${key}="${raw}" is not a valid boolean — using default ${def}`);
  return def;
}

/** Read an env var as a trimmed string, returning `def` if empty/unset. */
export function getEnvString(key: string, def: string = ""): string {
  const raw = (process.env[key] ?? "").trim();
  return raw || def;
}
