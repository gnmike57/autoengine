/**
 * Shared type utilities — single source of truth for cross-cutting types.
 *
 * These utilities exist to eliminate `catch (e: unknown)` patterns across
 * the codebase. Every error-handling site must import from here instead
 * of using `any`.
 */

// ── Error Narrowing ─────────────────────────────────────────────────────────

/** Narrows unknown catch clause values to extract .message safely. */
export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** For catch blocks that need the full Error object. */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(String(e));
}

/** Type guard: check if an unknown value has a .message property. */
export function hasMessage(e: unknown): e is { message: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    typeof (e as Record<string, unknown>).message === 'string'
  );
}

// ── Generic Record Utilities ────────────────────────────────────────────────

/** Safely access a string property from an unknown object. */
export function safeStringProp(obj: unknown, key: string): string | undefined {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    return typeof val === 'string' ? val : undefined;
  }
  return undefined;
}

/** Safely access a number property from an unknown object. */
export function safeNumberProp(obj: unknown, key: string): number | undefined {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    return typeof val === 'number' ? val : undefined;
  }
  return undefined;
}

// ── Callback / Handler Types ────────────────────────────────────────────────

/** Generic async disposable — anything with a .close() method. */
export interface AsyncCloseable {
  close(): Promise<void>;
}

/** A process-like object that has a PID. */
export interface ProcessLike {
  pid: number | undefined;
}
