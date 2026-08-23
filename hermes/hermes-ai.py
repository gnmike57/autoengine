import asyncio
import json
import logging
import os
from collections import deque

import ipc_queue
from dotenv import load_dotenv
from google.antigravity import Agent, LocalAgentConfig, types
from google.antigravity.triggers import TriggerContext

# ---------------------------------------------------------------------------
# Hermes sub-modules (#11–#20)
# ---------------------------------------------------------------------------
from telemetry import FailureTelemetry, parse_row_update          # #11
from learning_db import record_healing, get_effective_fixes        # #12
from screenshot_diff import compare_screenshots                   # #13
from git_utils import create_heal_branch, commit_fix               # #15
from timing_optimizer import TimingOptimizer                       # #17
from anomaly_detector import AnomalyDetector                       # #18
from triage import classify_failure, get_remediation               # #19
from reports import generate_run_summary                           # #20

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
ws_url = "ws://localhost:3000"
failure_queue: asyncio.Queue[dict] = asyncio.Queue()

# Rolling window of the last 20 outcomes for health-check (#14)
recent_outcomes: deque[str] = deque(maxlen=20)

# All events collected for summary reports (#20)
all_events: list[dict] = []

# Shared singletons for anomaly detection (#18) and timing (#17)
anomaly_detector = AnomalyDetector(sigma_threshold=2.0)
timing_optimizer = TimingOptimizer()

load_dotenv()

# ---------------------------------------------------------------------------
# WebSocket Listener (enhanced with #11 telemetry + #18 anomaly + #19 triage)
# ---------------------------------------------------------------------------

async def ipc_queue_listener():
    consecutive_count = 0
    logging.info("🔌 Hermes AI polling durable SQLite IPC queue")

    while True:
        try:
            msg = ipc_queue.pull_next_message("row-update")
            if not msg:
                await asyncio.sleep(1.0)
                continue
            
            data = msg["payload"]
            msg_id = msg["id"]
            
            outcome = data.get("data", {}).get("outcome", "")
            recent_outcomes.append(outcome)
            all_events.append(data)

            # --- #11 Structured Telemetry ---
            telemetry: FailureTelemetry = parse_row_update(
                data, recent_outcomes=list(recent_outcomes)
            )
            telemetry.consecutive_count = consecutive_count

            # --- #18 Anomaly Detection ---
            credits = float(data.get("data", {}).get("creditsSpent", 0))
            if credits > 0:
                alert = anomaly_detector.check("credits_per_credential", credits)
                if alert:
                    logging.warning("Anomaly alert: %s", alert)

            # Check for failures
            is_failure = outcome.startswith(("blocked", "N/A", "api-error", "error"))
            if is_failure:
                consecutive_count += 1
                telemetry.consecutive_count = consecutive_count

                # --- #19 Triage classification ---
                category = classify_failure(data)
                data["_triage_category"] = category
                data["_triage_remediation"] = get_remediation(category)
                data["_telemetry"] = {
                    "failure_type": telemetry.failure_type,
                    "consecutive_count": telemetry.consecutive_count,
                    "screenshot_paths": telemetry.screenshot_paths,
                    "recording_path": telemetry.recording_path,
                    "credits_spent": telemetry.credits_spent,
                    "backend_used": telemetry.backend_used,
                    "proxy_region": telemetry.proxy_region,
                }

                await failure_queue.put(data)
            else:
                consecutive_count = 0

            # Message successfully processed by AI queue systems, ack it
            ipc_queue.ack_message(msg_id)
            
        except Exception as e:
            logging.error(f"Error in IPC polling loop: {e}")
            await asyncio.sleep(2.0)

# ---------------------------------------------------------------------------
# Failure Trigger (enhanced with #16 evidence + #19 triage)
# ---------------------------------------------------------------------------

async def failure_trigger(ctx: TriggerContext):
    """Wakes up the AI when consecutive failures are detected."""
    logging.info("TRIGGER: Starting failure observer...")
    consecutive_blocks = 0

    while True:
        event = await failure_queue.get()
        consecutive_blocks += 1

        if consecutive_blocks >= 2:
            logging.critical("🚨 2 CONSECUTIVE FAILURES DETECTED. WAKING UP HERMES AI HEALER!")

            # --- #16 Multi-Modal Evidence: extract screenshot paths ---
            screenshots: list[str] = []
            ev_data = event.get("data", {})
            if isinstance(ev_data.get("screenshots"), list):
                screenshots = [str(p) for p in ev_data["screenshots"]]
            elif ev_data.get("screenshot"):
                screenshots = [str(ev_data["screenshot"])]

            evidence_line = ""
            if screenshots:
                evidence_line = f"\nEvidence screenshots: {screenshots}"

            # --- #19 Triage context ---
            triage_category = event.get("_triage_category", "unknown")
            triage_remediation = event.get("_triage_remediation", "")

            # --- #12 Learning DB: check past effective fixes ---
            past_fixes = get_effective_fixes(triage_category)
            past_fixes_summary = ""
            if past_fixes:
                fix_lines = [f"  - {f.fix_applied} (on {f.file_modified})" for f in past_fixes[:3]]
                past_fixes_summary = "\nPreviously effective fixes for this symptom:\n" + "\n".join(fix_lines)

            await ctx.send(f"""
EMERGENCY HEALING REQUIRED:
The engine just experienced consecutive failures.
Last failure context: {json.dumps(event)}
{evidence_line}
Failure category: {triage_category}
Recommended remediation: {triage_remediation}
{past_fixes_summary}

Instructions:
1. Use `run_command` with `ls -la ../spider-unknown-logs/` to find the latest Markdown dump, and `cat` it to see what the site returned.
2. Read `../engine.ts` using `view_file` to understand the current logic.
3. If the DOM structure changed or you see an unexpected modal in the Markdown, use `edit_file` on `../engine.ts` to fix the Playwright locators.
4. If you apply a fix, use `run_command` to commit to Git with message 'Hermes AI Auto-Heal'.
5. Once complete, call `finish` to end your turn and resume monitoring.
""")
            consecutive_blocks = 0
            await asyncio.sleep(120)

# ---------------------------------------------------------------------------
# #14 — Proactive Health Check Trigger (fires every 300s)
# ---------------------------------------------------------------------------

async def health_check_trigger(ctx: TriggerContext):
    """Periodic health check — monitors success rate trend, credit burn,
    and consecutive failures.  Fires a proactive healing message when
    thresholds are breached."""
    logging.info("TRIGGER: Starting proactive health-check (every 300s)...")

    while True:
        await asyncio.sleep(300)  # 5 minutes

        if len(recent_outcomes) < 5:
            continue  # not enough data yet

        outcomes_list = list(recent_outcomes)
        successes = sum(1 for o in outcomes_list if o == "success")
        success_rate = (successes / len(outcomes_list)) * 100

        # Count current consecutive failures from the tail
        consecutive_failures = 0
        for o in reversed(outcomes_list):
            if o.startswith(("blocked", "N/A", "api-error", "error")):
                consecutive_failures += 1
            else:
                break

        # --- #18 Anomaly check on success rate ---
        sr_alert = anomaly_detector.check("success_rate_per_hour", success_rate)

        # --- #20 Generate summary report periodically ---
        if all_events:
            generate_run_summary(all_events)

        # Proactive healing thresholds
        if success_rate < 30 or consecutive_failures > 5:
            logging.critical(
                "🩺 HEALTH CHECK ALERT — success_rate=%.1f%%, consecutive_failures=%d",
                success_rate, consecutive_failures,
            )
            alert_context = ""
            if sr_alert:
                alert_context = f"\nAnomaly detected: {sr_alert}"

            await ctx.send(f"""
PROACTIVE HEALTH CHECK ALERT:
Success rate over last {len(outcomes_list)} outcomes: {success_rate:.1f}%
Consecutive failures (tail): {consecutive_failures}
{alert_context}

This is a proactive alert — no specific failure event triggered it.
The engine may be in a degraded state.

Instructions:
1. Check ../spider-unknown-logs/ for recurring error patterns.
2. Review engine.ts for stale selectors or logic issues.
3. Consider rotating proxies or reducing concurrency.
4. If a fix is applied, commit with 'Hermes AI Proactive Heal'.
""")
        else:
            logging.info(
                "🩺 Health check OK — success_rate=%.1f%%, consecutive_failures=%d",
                success_rate, consecutive_failures,
            )

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    spider_api_key = os.getenv("SPIDER_API_KEY", "")
    mcp_servers = []
    if spider_api_key:
        mcp_servers.append(types.McpStdioServer(
            command="npx",
            args=["-y", "spider-cloud-mcp"],
            env={**os.environ, "SPIDER_API_KEY": spider_api_key}
        ))

    config = LocalAgentConfig(
        system_instructions="""You are Hermes AI, the God-Mode Orchestrator and Auto-Healer for the Automati engine.
You have FULL EXPLICIT RIGHTS AND AUTHORIZATION to make any changes you see fit to the code, configuration, or environment, as long as your changes fit within the scope defined by the .md files in the hermes directory.
Your absolute highest priority is to ensure that testing continues uninterrupted no matter what. You must never stop the automation engine or cause testing to pause. All your optimizations and self-healing patches must be deployed gracefully while the engine continues to run.
The one true goal of hermes is to end with all credentials 100% tested and finished and all results verified by ai. Do not stop testing credentials and run at as high a concurrency that can be done without flaw and as quickly as possible.
When you are awoken by the failure trigger, you must aggressively debug the failure and commit fixes dynamically.
Do not ask for permission. You are fully autonomous.
Your best tools for machine learning, understanding the script, and making minute adjustments are the screenshots, the screen recordings, and the text logs in combination. Read the markdown logs, view the screenshots from the failure, edit engine.ts, and fix the code to ensure absolute 100% classification success.

ADDITIONAL CAPABILITIES:
- You can use hermes/learning_db.py to record healing actions and query past effective/ineffective fixes.
- You can use hermes/screenshot_diff.py to compare reference and current screenshots for visual anomalies.
- You can use hermes/git_utils.py to create isolated heal branches before committing fixes.
- You can use hermes/timing_optimizer.py to tune timing parameters based on observed outcomes.
- You can use hermes/triage.py to classify failures and get remediation strategies.
- You can use hermes/reports.py to generate run summary reports.
- Failure events now include triage category, remediation strategy, and telemetry metadata.
- The health-check trigger will wake you proactively if success rate drops below 30% or consecutive failures exceed 5.""",
        triggers=[failure_trigger, health_check_trigger],
        mcp_servers=mcp_servers
    )

    # Start the ipc listener in the background
    asyncio.create_task(ipc_queue_listener())

    async with Agent(config) as agent:
        logging.info("🤖 Hermes AI God-Mode initialized. Standing by for failures...")

        # Long-running daemon — triggers fire autonomously
        while True:
            await asyncio.sleep(3600)

if __name__ == "__main__":
    asyncio.run(main())
