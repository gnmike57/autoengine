---
name: launch-batch-cdp
description: Automates launching a full credential validation batch via Chrome CDP (Camoufox Headed, Concurrency 4, Optimal Settings)
---

# Launch Batch via CDP

When the user asks to launch a batch (especially via the Chrome debug port or requesting Camoufox at 4 concurrency with optimal settings), you should use the provided Playwright script to orchestrate the dashboard UI via CDP.

## Instructions
1. Ensure the server and dashboard are running (the CDP port `9224` must be active).
2. Execute the trigger script using:
   `npx tsx .agents/skills/launch-batch-cdp/scripts/trigger-batch.ts`
3. This script will automatically connect to the Chrome debug port, sync the dashboard UI settings (Stealth Headed, Concurrency 4, Auto Best Native Per Backend), and start the batch.
