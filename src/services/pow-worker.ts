import { parentPort } from 'node:worker_threads';
import crypto from 'node:crypto';

export interface PoWWorkerData {
  jwt: string;
  difficulty: number;
  maxIterations?: number;
}

function hasLeadingZeros(hash: Buffer, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 8);
  const remainingBits = difficulty % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  if (remainingBits > 0 && fullBytes < hash.length) {
    const mask = 0xFF << (8 - remainingBits);
    if ((hash[fullBytes]! & mask) !== 0) {
      return false;
    }
  }

  return true;
}

function solve(data: PoWWorkerData) {
  const { jwt, difficulty, maxIterations = 100000000 } = data;
  const jwtBuf = Buffer.from(jwt);

  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const hash = crypto.createHash('sha256').update(jwtBuf).update(nonce.toString()).digest();

    if (hasLeadingZeros(hash, difficulty)) {
      return nonce.toString();
    }
  }

  return null;
}

if (parentPort) {
  parentPort.on('message', (data: PoWWorkerData) => {
    try {
      const nonce = solve(data);
      if (nonce) {
        parentPort!.postMessage({ nonce });
      } else {
        parentPort!.postMessage({ error: `No solution found` });
      }
    } catch (err: unknown) {
      parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
