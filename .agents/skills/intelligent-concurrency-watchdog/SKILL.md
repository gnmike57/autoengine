---
name: intelligent-concurrency-watchdog
description: Intelligently ramps batch concurrency up or down by visually monitoring the running headed browser grid.
---

# Intelligent Concurrency Watchdog

This skill guides the agent to act as an active supervisor for a running automation batch, using visual feedback to tune concurrency.

## Workflow

1. **Start the Batch**: Launch the batch using `cli-start-batch.ts` with the starting concurrency (e.g., 3).
2. **Visual Polling Loop**: 
   - Wait 1-2 minutes for browsers to spawn and tile.
   - Run `screencapture -x ./scratch/grid-status.png` (macOS) to take a full desktop screenshot.
   - Use the `view_file` tool on `./scratch/grid-status.png` to analyze the state of the desktop grid.
3. **Evaluation Criteria**:
   - **Scale Up**: If the grid looks stable, windows are neatly tiled without severe overlapping, and pages appear to be loading or acting normally, increment concurrency by 1 (up to the maximum, usually 8).
   - **Maintain**: If the screen looks adequately packed or some windows are still starting up.
   - **Scale Down**: If windows are heavily overlapping, frozen, showing signs of severe CPU lag (e.g., blank white pages hanging for too long), or if errors are visible, decrement concurrency by 1 or 2 to let the system recover.
4. **Adjustment**: Run `npx tsx src/scripts/cli-set-concurrency.ts --concurrency=<N>` to apply the new limit.
5. **Repeat**: Continue the loop until the batch is complete.
