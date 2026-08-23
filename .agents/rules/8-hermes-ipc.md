# 8. BULLETPROOF ORCHESTRATION & IPC INVARIANTS

## Inter-Agent Communication (IPC)
- **Zero Message Drops**: All cross-language communication (e.g., TypeScript to Python) MUST use a durable queue (like `better-sqlite3` IPC queue or Redis). Volatile transports like WebSockets can be used for UI broadcasting but NEVER as the primary data exchange for worker agents where dropped messages lead to lost state.
- **ACK/NACK Logic**: Python consumers reading from the IPC queue MUST only ACK messages after all processing (telemetry parsing, anomaly detection, LLM generation) is completely successful.

## Graceful Draining (Watchdog)
- **No Blunt Exits**: Do not use `process.exit(1)` to handle high memory or stalling if active browser sessions exist.
- **DRAIN State**: The system must enter a `DRAIN` state, reject new tasks, and wait for a configured timeout (e.g. 60 seconds) for existing tasks to close naturally.
- **Zombie Sweeping**: Before finally exiting for a PM2 restart, the process cleaner must be invoked to forcefully sweep any orphaned headless browser PIDs.

## Dead-Letter Queues (DLQ) & Transaction Rollbacks
- **State Limbo Prevention**: Any credential or task pulled for processing MUST be marked with `status = 'processing'` and a timestamp. 
- **Recovery Sweeps**: On every queue fetch, the system must scan for tasks stuck in `processing` beyond a timeout (e.g., 15 minutes) and roll them back to an untested state.
- **DLQ Routing**: Track the number of times a task crashes during processing (`crash_count`). If `crash_count >= 3`, mark it as `DLQ` and remove it from the active rotation to prevent infinite crash loops.
