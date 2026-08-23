import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { createLogger } from "../core/logger.js";

const log = createLogger("HermesIPC");

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "ipc.sqlite");

export interface IpcMessage {
  id?: number;
  topic: string;
  payload: string; // JSON string
  created_at?: string;
  status?: string; // 'pending', 'processing', 'completed', 'failed'
}

class IpcQueueManager {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_topic ON queue(topic);
    `);
  }

  /**
   * Push a message onto the IPC queue.
   */
  public push(topic: string, data: any): void {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO queue (topic, payload) VALUES (?, ?)`
      );
      stmt.run(topic, JSON.stringify(data));
    } catch (e) {
      log.error(`Failed to push message to IPC queue: ${e}`);
    }
  }

  /**
   * For the TypeScript side to clean up old completed messages if needed.
   * Python handles the ACKs usually.
   */
  public cleanup(olderThanDays: number = 3): void {
    try {
      const stmt = this.db.prepare(
        `DELETE FROM queue WHERE status IN ('completed', 'failed') AND created_at < datetime('now', '-' || ? || ' days')`
      );
      stmt.run(olderThanDays);
    } catch (e) {
      log.error(`Failed to cleanup IPC queue: ${e}`);
    }
  }
}

export const IpcQueue = new IpcQueueManager();
