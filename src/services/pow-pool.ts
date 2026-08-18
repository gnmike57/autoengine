import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
// Determine the correct path to the worker script
let workerPath = path.resolve(import.meta.dirname, 'pow-worker.js');
if (import.meta.filename && import.meta.filename.endsWith('.ts')) {
  workerPath = path.resolve(import.meta.dirname, 'pow-worker.ts');
}

export class NativePoWPool {
  private workers: Set<Worker> = new Set();
  private availableWorkers: Worker[] = [];
  private taskQueue: Array<{
    jwt: string;
    difficulty: number;
    resolve: (nonce: string | null) => void;
    reject: (err: Error) => void;
  }> = [];
  private currentTasks = new Map<Worker, {
    resolve: (nonce: string | null) => void;
    reject: (err: Error) => void;
  }>();

  private maxWorkers: number;

  constructor(maxWorkers: number = 2) {
    this.maxWorkers = maxWorkers;
  }

  public async solve(jwt: string, difficulty: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ jwt, difficulty, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue() {
    if (this.taskQueue.length === 0) return;

    if (this.availableWorkers.length > 0) {
      const worker = this.availableWorkers.pop()!;
      this.assignTask(worker);
    } else if (this.workers.size < this.maxWorkers) {
      const worker = new Worker(workerPath, {
        // If we are running via tsx/ts-node, we need to pass the loader to the worker
        execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx'] : undefined,
      });

      this.workers.add(worker);

      worker.on('message', (msg) => {
        const task = this.currentTasks.get(worker);
        if (task) {
          this.currentTasks.delete(worker);
          if (msg.error) {
            task.reject(new Error(msg.error));
          } else {
            task.resolve(msg.nonce);
          }
          this.availableWorkers.push(worker);
          this.processQueue();
        }
      });

      worker.on('error', (err) => {
        this.workers.delete(worker);
        this.availableWorkers = this.availableWorkers.filter(w => w !== worker);
        const task = this.currentTasks.get(worker);
        if (task) {
          this.currentTasks.delete(worker);
          task.reject(err instanceof Error ? err : new Error(String(err)));
          this.processQueue();
        }
      });

      worker.on('exit', (code) => {
        this.workers.delete(worker);
        this.availableWorkers = this.availableWorkers.filter(w => w !== worker);
        const task = this.currentTasks.get(worker);
        if (task) {
          this.currentTasks.delete(worker);
          if (code !== 0) {
            task.reject(new Error(`Worker stopped with exit code ${code}`));
          }
          this.processQueue();
        }
      });

      this.assignTask(worker);
    }
  }

  private assignTask(worker: Worker) {
    const task = this.taskQueue.shift();
    if (!task) {
      this.availableWorkers.push(worker);
      return;
    }

    const { jwt, difficulty, resolve, reject } = task;
    this.currentTasks.set(worker, { resolve, reject });
    worker.postMessage({ jwt, difficulty });
  }

  public close() {
    for (const worker of this.workers) {
      worker.terminate().catch(() => {});
    }
    this.workers.clear();
    this.availableWorkers = [];
    this.currentTasks.clear();

    for (const task of this.taskQueue) {
      task.reject(new Error("PoW Pool closed"));
    }
    this.taskQueue = [];
  }
}
