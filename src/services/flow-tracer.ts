/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../core/logger.js';

const log = createLogger('flow-tracer');

export interface FlowTraceEvent {
  timestamp: string;
  type: "step_start" | "step_end" | "step_error" | "network" | "mutation" | "outcome" | "info";
  session_id: string;
  email: string;
  site: string;
  message: string;
  details?: any;
}

class FlowTracer {
  private outputDir: string;
  private enabled: boolean;
  private currentStreams: Map<string, fs.WriteStream> = new Map();

  constructor() {
    // Flow tracing is enabled globally by default to aid AI debugging
    this.enabled = true;
    this.outputDir = path.join(process.cwd(), 'hermes', 'reports', 'flow-traces');

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  private redactEmail(email: string): string {
    return `email-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 20)}`;
  }

  private getStream(email: string): fs.WriteStream {
    const safeEmail = this.redactEmail(email);

    if (!this.currentStreams.has(safeEmail)) {
      const filePath = path.join(this.outputDir, `${safeEmail}.jsonl`);
      // Append mode so we can keep a running log of the credential across runs
      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on("error", (err) => {
        log.warn(`Flow trace stream error for ${safeEmail}: ${err}`);
        this.currentStreams.delete(safeEmail);
      });
      this.currentStreams.set(safeEmail, stream);
    }

    return this.currentStreams.get(safeEmail)!;
  }

  public recordEvent(event: Omit<FlowTraceEvent, "timestamp">) {
    if (!this.enabled) return;

    try {
      const fullEvent: FlowTraceEvent = {
        timestamp: new Date().toISOString(),
        ...event,
        email: this.redactEmail(event.email),
      };

      const stream = this.getStream(event.email);
      stream.write(JSON.stringify(fullEvent) + '\n');
    } catch (e) {
      log.warn(`Failed to write flow trace event: ${String(e)}`);
    }
  }

  public flush(email: string) {
    const safeEmail = this.redactEmail(email);
    const stream = this.currentStreams.get(safeEmail);
    if (stream) {
      stream.end();
      this.currentStreams.delete(safeEmail);
    }
  }
}

export const flowTracer = new FlowTracer();