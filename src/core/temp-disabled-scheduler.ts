/**
 * TempDisabledScheduler
 *
 * Solves the two critical gaps in the existing TEMP_DISABLED handling:
 *
 *   Gap 1 — In-memory only: The engine's `setTimeout(1hr)` is lost on process
 *            restart. This module persists every cooldown to the `scheduled_retests`
 *            DB table so retests survive crashes and restarts.
 *
 *   Gap 2 — Not per-site: `tempDisabledUntil` was a single timestamp on the row,
 *            blocking ALL sites for the credential even if only one site is
 *            temp-disabled. This module tracks cooldowns per (email, site) pair.
 *
 * Usage:
 *   const scheduler = new TempDisabledScheduler(engine);
 *   scheduler.start();                          // begin polling loop
 *
 *   // Called by engine when a tempdisabled outcome fires:
 *   scheduler.schedule(email, siteName);
 *
 *   scheduler.stop();                           // clean shutdown
 */

import { createLogger } from "./logger.js";
import {
  scheduleRetest,
  getDueRetests,
  markRetestComplete,
  type ScheduledRetest,
} from "./database.js";
import type { AutomationEngine } from "./engine.js";

const log = createLogger("temp-disabled-scheduler");

/** How long a temp-disabled cooldown lasts (1 hour). */
const COOLDOWN_MS = 60 * 60 * 1000;

/** How often to poll the DB for due retests (every 60 seconds). */
const POLL_INTERVAL_MS = 60_000;

/**
 * Reason tag written to the `scheduled_retests.reason` column so the DB
 * record is self-describing and queryable.
 */
function buildReason(siteName: string): string {
  return `tempdisabled:${siteName}`;
}

/**
 * Parse the site name back out of a reason tag.
 * Returns undefined if the reason is not a tempdisabled tag.
 */
function parseSiteFromReason(reason: string | null): string | undefined {
  if (!reason) return undefined;
  const match = reason.match(/^tempdisabled:(.+)$/);
  return match?.[1];
}

export class TempDisabledScheduler {
  private engine: AutomationEngine;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(engine: AutomationEngine) {
    this.engine = engine;
  }

  /**
   * Schedule a per-site cooldown retest for an email address.
   *
   * Called by the engine immediately when a `tempdisabled` outcome is
   * classified. Writes a DB record so the retest survives process restarts.
   *
   * If a pending (not yet completed) retest already exists for this
   * (email, site) pair, this call is a no-op — we never double-schedule.
   */
  schedule(email: string, siteName: string): void {
    const scheduledAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
    const reason = buildReason(siteName);

    // Check for an existing pending retest for this (email, site) to avoid
    // duplicate entries accumulating in the table.
    const existing = getDueRetests().filter(
      (r) => r.email.toLowerCase() === email.toLowerCase() &&
             parseSiteFromReason(r.reason) === siteName
    );
    if (existing.length > 0) {
      log.debug(`[${email}@${siteName}] Retest already scheduled — skipping duplicate`);
      return;
    }

    try {
      scheduleRetest(email, scheduledAt, reason);
      log.info(`[${email}@${siteName}] Cooldown scheduled — retest at ${scheduledAt}`);
    } catch (e: unknown) {
      log.warn(`[${email}@${siteName}] Failed to persist cooldown: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Start the polling loop. Checks the DB every 60 seconds for due retests
   * and injects them back into the engine queue (site-specific).
   */
  start(): void {
    if (this.pollTimer) return; // already running
    this.stopped = false;
    log.info("TempDisabledScheduler started — polling every 60s for due retests");
    this.pollTimer = setInterval(() => {
      if (!this.stopped) void this.processDueRetests();
    }, POLL_INTERVAL_MS);
    // Unref so the timer doesn't prevent process exit when the engine stops.
    this.pollTimer.unref?.();

    // Run an immediate pass on startup to pick up any retests that became
    // due while the process was down.
    void this.processDueRetests();
  }

  /** Stop the polling loop cleanly. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("TempDisabledScheduler stopped");
  }

  /**
   * Process all retests that are currently due.
   *
   * For each due retest:
   *   1. Find the matching engine row.
   *   2. Reset ONLY the affected site's outcome back to "queued".
   *   3. If the row's overall status was "tempdisabled" and no other site
   *      is still in cooldown, reset the row status to "queued" too.
   *   4. Mark the DB record as completed.
   *   5. Move the row to the front of the engine queue (highest priority).
   */
  private async processDueRetests(): Promise<void> {
    let due: ScheduledRetest[];
    try {
      due = getDueRetests();
    } catch (e: unknown) {
      log.warn(`Failed to query due retests: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (due.length === 0) return;

    log.info(`Processing ${due.length} due temp-disabled retest(s)`);

    const rows = (this.engine as any).rows as Array<{
      email: string;
      status: string;
      sites: Record<string, { outcome: string; attempts?: number; error?: string }>;
      tempDisabledUntil?: string;
    }>;

    for (const retest of due) {
      const siteName = parseSiteFromReason(retest.reason);
      if (!siteName) {
        // Legacy record without a site tag — mark complete and skip
        try { markRetestComplete(retest.id); } catch { /* ignore */ }
        continue;
      }

      const rowIdx = rows.findIndex(
        (r) => r.email.toLowerCase() === retest.email.toLowerCase()
      );

      if (rowIdx === -1) {
        log.warn(`[${retest.email}@${siteName}] Row not found in engine — marking retest complete`);
        try { markRetestComplete(retest.id); } catch { /* ignore */ }
        continue;
      }

      const row = rows[rowIdx]!;
      const siteStatus = row.sites[siteName];

      if (!siteStatus) {
        log.warn(`[${retest.email}@${siteName}] Site not found on row — marking retest complete`);
        try { markRetestComplete(retest.id); } catch { /* ignore */ }
        continue;
      }

      // Reset the specific site back to queued
      siteStatus.outcome = "queued";
      siteStatus.attempts = 0;
      delete siteStatus.error;

      // Clear the row-level tempDisabledUntil if no other site is still cooling
      const anyStillCooling = Object.values(row.sites).some(
        (s) => s.outcome === "tempdisabled"
      );
      if (!anyStillCooling) {
        delete row.tempDisabledUntil;
        if (row.status === "tempdisabled") {
          row.status = "queued";
        }
      }

      // Move to front of queue so it runs next (highest priority)
      rows.splice(rowIdx, 1);
      rows.unshift(row);

      // Emit a row-update event so the dashboard reflects the change
      try {
        (this.engine as any).emit("row-update", structuredClone(row));
      } catch { /* ignore if engine is stopped */ }

      log.info(`⏰ [${retest.email}@${siteName}] Cooldown expired — moved to front of queue`);

      // Mark the DB record as completed
      try {
        markRetestComplete(retest.id);
      } catch (e: unknown) {
        log.warn(`[${retest.email}@${siteName}] Failed to mark retest complete: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
