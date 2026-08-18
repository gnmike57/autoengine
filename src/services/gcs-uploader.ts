/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * gcs-uploader.ts — Google Cloud Storage screenshot upload service.
 *
 * Architecture:
 *   1. Screenshots are written locally first (screenshot-service.ts)
 *   2. After local write + dashboard emit, this service uploads to GCS async
 *   3. The GCS public URL is emitted back so the dashboard can use it
 *
 * Config via environment variables:
 *   GCS_BUCKET        — bucket name (required)
 *   GCS_ACCESS_KEY    — HMAC Interoperability access key
 *   GCS_SECRET_KEY    — HMAC Interoperability secret key
 *   GCS_PATH_PREFIX   — prefix for all uploads (default: "screenshots/")
 *   GCS_ENABLED       — set to "false" to disable (default: "true" if bucket is set)
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

/** AWS SDK error shape — not exported from @aws-sdk/client-s3 */
interface AwsSdkError extends Error {
  $metadata?: { httpStatusCode?: number };
  code?: string;
  name: string;
}

export interface GcsUploaderOpts {
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  projectId?: string;
  pathPrefix?: string;
  maxConcurrent?: number;
  retries?: number;
  logger?: (level: string, msg: string) => void;
}

export interface GcsUploadResult {
  localPath: string;
  gcsPath: string;
  publicUrl: string;
  sizeBytes: number;
  email?: string;
  label?: string;
  target?: string;
}

export class GcsUploader extends EventEmitter {
  private s3: S3Client;
  private bucket: string;
  private pathPrefix: string;
  private maxConcurrent: number;
  private retries: number;
  private log: (level: string, msg: string) => void;
  private inFlight = 0;
  private queue: Array<{
    localPath: string;
    remoteName: string;
    contentType: string;
    meta?: Record<string, string>;
    resolve: (r: GcsUploadResult) => void;
    reject: (e: Error) => void;
  }> = [];
  private _ready = false;
  private _disabled = false;

  private _offlineUntil = 0;
  private static readonly DEFAULT_OFFLINE_COOLDOWN_MS = 5 * 60_000;
  private _offlineCooldownMs = GcsUploader.DEFAULT_OFFLINE_COOLDOWN_MS;

  private static readonly NETWORK_ERROR_CODES = new Set<string>([
    "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  ]);

  private _isNetworkError(e: any): boolean {
    if (!e) return false;
    if (typeof e.code === "string" && GcsUploader.NETWORK_ERROR_CODES.has(e.code)) return true;
    const msg: string = e.message || "";
    return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|getaddrinfo|ENETUNREACH|EHOSTUNREACH/i.test(msg);
  }

  get isOffline(): boolean {
    if (this._offlineUntil === 0) return false;
    if (Date.now() >= this._offlineUntil) {
      this._offlineUntil = 0;
      this.log("INFO", "GCS network cooldown elapsed — re-probing on next upload");
      return false;
    }
    return true;
  }

  private _shouldDefer(): boolean {
    if (!this.isOffline) return false;
    if (this._offlineUntil === 0 || this._offlineUntil - Date.now() < this._offlineCooldownMs) {
      this._offlineUntil = this._offlineUntil || Date.now() + this._offlineCooldownMs;
      this.log("WARN", `GCS offline (cooldown ${Math.round(this._offlineCooldownMs / 1000)}s) — uploads deferred`);
    }
    return true;
  }

  private _markOffline(e: any): void {
    const wasOffline = this._offlineUntil > Date.now();
    this._offlineUntil = Date.now() + this._offlineCooldownMs;
    this.log("WARN", `GCS network unreachable (${e?.code || "?"}): ${e?.message || "unknown"}. Entering offline mode for ${Math.round(this._offlineCooldownMs / 1000)}s.`);
    if (!wasOffline) {
      this.emit("offline", { error: e?.message || "unknown", code: e?.code, cooldownMs: this._offlineCooldownMs });
    }
  }

  setOfflineCooldown(ms: number): void {
    this._offlineCooldownMs = Math.max(1000, ms);
  }

  constructor(opts: GcsUploaderOpts) {
    super();
    this.pathPrefix = opts.pathPrefix ?? "screenshots/";
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.retries = opts.retries ?? 3;
    this.bucket = opts.bucket;
    this.log = opts.logger ?? ((level, msg) => console.log(`[GCS ${level}] ${msg}`));

    try {
      if (!opts.accessKeyId || !opts.secretAccessKey) {
        throw new Error("Missing GCS accessKeyId or secretAccessKey for interoperability API");
      }

      this.s3 = new S3Client({
        endpoint: "https://storage.googleapis.com",
        region: "auto",
        credentials: {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        },
        // GCS S3-interop does NOT support chunked transfer encoding.
        // AWS SDK v3 defaults to chunked for streams, which causes
        // "Invalid argument" 400 errors. We handle this by always
        // sending Buffer bodies with explicit ContentLength instead.
      });
      this._ready = true;
      this.log("INFO", `GCS S3-uploader ready → gs://${opts.bucket}/${this.pathPrefix}`);
    } catch (e: unknown) {
      this.log("ERR", `GCS uploader init failed: ${e instanceof Error ? e.message : String(e)}`);
      this._disabled = true;
      this.s3 = null as any;
    }
  }

  get isReady(): boolean { return this._ready && !this._disabled; }

  async upload(localPath: string, meta?: {
    email?: string; label?: string; target?: string;
  }): Promise<GcsUploadResult | null> {
    if (!this.isReady) return null;
    if (this._shouldDefer()) return null;
    if (!fs.existsSync(localPath)) {
      this.log("WARN", `File not found for upload: ${localPath}`);
      return null;
    }

    const filename = path.basename(localPath);
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === ".png" ? "image/png" :
                        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
                        ext === ".webm" ? "video/webm" :
                        ext === ".mp4" ? "video/mp4" :
                        "application/octet-stream";
    const remoteName = `${this.pathPrefix}${filename}`;

    return new Promise((resolve, reject) => {
      this.queue.push({ localPath, remoteName, contentType, meta: meta, resolve, reject });
      this._drain();
    });
  }

  async uploadBuffer(buf: Buffer, filename: string, meta?: {
    email?: string; label?: string; target?: string;
  }): Promise<GcsUploadResult | null> {
    if (!this.isReady) return null;
    if (this._shouldDefer()) return null;

    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === ".png" ? "image/png" :
                        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
                        ext === ".webm" ? "video/webm" :
                        ext === ".mp4" ? "video/mp4" :
                        "application/octet-stream";
    const remoteName = `${this.pathPrefix}${filename}`;

    try {
      await this._retryUploadBuffer(remoteName, buf, contentType, meta);

      const publicUrl = `https://storage.googleapis.com/${this.bucket}/${remoteName}`;
      const result: GcsUploadResult = {
        localPath: "",
        gcsPath: `gs://${this.bucket}/${remoteName}`,
        publicUrl,
        sizeBytes: buf.length,
        email: meta?.email,
        label: meta?.label,
        target: meta?.target,
      };
      this.emit("uploaded", result);
      return result;
    } catch (e: unknown) {
      this.log("ERR", `GCS buffer upload failed for ${filename}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async deleteByFilename(filename: string): Promise<boolean> {
    if (!this.isReady) return false;
    const remoteName = `${this.pathPrefix}${filename}`;
    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: remoteName,
      }));
      this.log("INFO", `Deleted from GCS: ${remoteName}`);
      return true;
    } catch (_e: unknown) {
      const e = _e as AwsSdkError;
      if (e.$metadata?.httpStatusCode !== 404) {
        this.log("WARN", `GCS delete failed for ${remoteName}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return false;
    }
  }

  private _drain(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.inFlight++;
      this._doUpload(item.localPath, item.remoteName, item.contentType, item.meta)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.inFlight--;
          this._drain();
        });
    }
  }

  private async _doUpload(
    localPath: string,
    remoteName: string,
    contentType: string,
    meta?: Record<string, string>,
  ): Promise<GcsUploadResult> {
    const stats = fs.statSync(localPath);

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        // GCS S3-interop requires Content-Length (rejects chunked encoding).
        // Read entire file into a Buffer instead of streaming.
        const fileBuffer = fs.readFileSync(localPath);

        await this.s3.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: remoteName,
          Body: fileBuffer,
          ContentType: contentType,
          ContentLength: fileBuffer.length,
          Metadata: meta || {},
          CacheControl: "public, max-age=31536000",
        }));

        const publicUrl = `https://storage.googleapis.com/${this.bucket}/${remoteName}`;
        const result: GcsUploadResult = {
          localPath,
          gcsPath: `gs://${this.bucket}/${remoteName}`,
          publicUrl,
          sizeBytes: stats.size,
          email: meta?.email,
          label: meta?.label,
          target: meta?.target,
        };

        this.log("INFO", `Uploaded ${path.basename(localPath)} → ${publicUrl} (${(stats.size / 1024).toFixed(1)}KB)`);
        this.emit("uploaded", result);

        try {
          fs.unlinkSync(localPath);
          this.log("INFO", `Deleted local copy to save space: ${path.basename(localPath)}`);
        } catch (delErr: unknown) {
          this.log("WARN", `Failed to delete local copy ${path.basename(localPath)}: ${delErr instanceof Error ? delErr.message : String(delErr)}`);
        }

        return result;
      } catch (_e: unknown) {
        const e = _e as AwsSdkError;
        if (e.$metadata?.httpStatusCode === 403 || e.$metadata?.httpStatusCode === 401) {
          this._disabled = true;
          this.log("ERR", `GCS disabled due to auth/billing error: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        if (this._isNetworkError(e)) {
          this._markOffline(e);
          this.emit("upload-failed", { localPath, remoteName, error: (e instanceof Error ? e.message : String(e)), network: true });
          throw e;
        }
        if (attempt < this.retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          this.log("WARN", `Upload attempt ${attempt}/${this.retries} failed: ${e instanceof Error ? e.message : String(e)} — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          this.log("ERR", `Upload failed after ${this.retries} attempts: ${localPath} → ${e instanceof Error ? e.message : String(e)}`);
          this.emit("upload-failed", { localPath, remoteName, error: (e instanceof Error ? e.message : String(e)) });
          throw e;
        }
      }
    }
    throw new Error("Unreachable");
  }

  private async _retryUploadBuffer(remoteName: string, buf: Buffer, contentType: string, meta?: Record<string, string>): Promise<void> {
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        await this.s3.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: remoteName,
          Body: buf,
          ContentType: contentType,
          ContentLength: buf.length,
          Metadata: meta || {},
          CacheControl: "public, max-age=31536000",
        }));
        return;
      } catch (_e: unknown) {
        const e = _e as AwsSdkError;
        if (e.$metadata?.httpStatusCode === 403 || e.$metadata?.httpStatusCode === 401) {
          this._disabled = true;
          this.log("ERR", `GCS disabled due to auth/billing error: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        if (this._isNetworkError(e)) {
          this._markOffline(e);
          throw e;
        }
        if (attempt < this.retries) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        } else {
          throw e;
        }
      }
    }
  }

  async uploadFileIfExists(localPath: string, remotePrefix: string = ""): Promise<boolean> {
    if (!this.isReady || !fs.existsSync(localPath)) return false;
    if (this._shouldDefer()) return false;
    const filename = path.basename(localPath);
    const remoteName = `${remotePrefix}${filename}`;

    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: remoteName }));
      // If it exists, we let it be, unless it's a CSV or DB
      if (filename === "results.csv" || filename.endsWith(".db")) {
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: remoteName }));
      } else {
        return true; // Already exists
      }
    } catch (e: unknown) {
      if ((e instanceof Error ? e.name : undefined) !== 'NotFound') {
        // Ignored
      }
    }

    try {
      const contentType = filename.endsWith(".csv") ? "text/csv" : filename.endsWith(".db") ? "application/vnd.sqlite3" : "application/octet-stream";
      // GCS S3-interop: use Buffer, not stream
      const fileBuffer = fs.readFileSync(localPath);
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: remoteName,
        Body: fileBuffer,
        ContentType: contentType,
        ContentLength: fileBuffer.length,
      }));
      this.log("INFO", `Synced file to cloud: gs://${this.bucket}/${remoteName}`);
      return true;
    } catch (e: unknown) {
      this.log("WARN", `Failed to sync ${localPath}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async backfillFromDisk(dir: string, extensions: string[] = [".jpg", ".jpeg", ".png"]): Promise<number> {
    if (!this.isReady) return 0;
    if (!fs.existsSync(dir)) return 0;

    const files = fs.readdirSync(dir).filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext)));
    this.log("INFO", `Backfill: checking ${files.length} local files in ${path.basename(dir)}...`);

    let uploaded = 0;
    let skipped = 0;

    for (const file of files) {
      const remoteName = `${this.pathPrefix}${file}`;
      try {
        await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: remoteName }));
        // Exists
        skipped++;
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* intentional */ }
        continue;
      } catch (e: unknown) {
        if ((e as Error).name !== 'NotFound') {
           continue; // Skip if other error
        }
      }

      try {
        await this.upload(path.join(dir, file));
        uploaded++;
      } catch {
        // Logged
      }
    }

    this.log("INFO", `Backfill complete for ${path.basename(dir)}: ${uploaded} uploaded, ${skipped} already in GCS`);
    return uploaded;
  }

  async ensureBucket(_location = "US"): Promise<void> {
    if (!this._ready) return;
    // Validate bucket accessibility using HeadBucket (correct S3 API).
    // The old HeadObject probe was giving false positives — a 404 for
    // "bucket not found" was being misread as "key not found, bucket OK".
    try {
      const { HeadBucketCommand } = await import("@aws-sdk/client-s3");
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.log("INFO", `Bucket gs://${this.bucket} verified accessible via HMAC`);
    } catch (_e: unknown) {
      const e = _e as AwsSdkError;
      const httpCode = e.$metadata?.httpStatusCode;
      if (httpCode === 404) {
        this.log("ERR", `Bucket gs://${this.bucket} does NOT exist (404). Disabling GCS uploads.`);
        this._disabled = true;
      } else if (httpCode === 403 || httpCode === 401) {
        this.log("ERR", `HMAC credentials rejected by GCS (${httpCode}). Disabling GCS uploads.`);
        this._disabled = true;
      } else if ((e instanceof Error ? e.message : String(e))?.includes("Invalid argument")) {
        this.log("ERR", `GCS HMAC keys are invalid or expired: ${e instanceof Error ? e.message : String(e)}. Disabling GCS uploads.`);
        this._disabled = true;
      } else {
        this.log("WARN", `Could not verify bucket gs://${this.bucket}: ${e instanceof Error ? e.message : String(e)} (HTTP ${httpCode}). Will retry on next upload.`);
      }
    }
  }

  async shutdown(): Promise<void> {
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < 10000) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (this.inFlight > 0) {
      this.log("WARN", `Shutdown with ${this.inFlight} uploads still in-flight`);
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createGcsUploaderFromEnv(
  logger?: (level: string, msg: string) => void,
): GcsUploader | null {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) {
    (logger ?? console.log)("INFO", "GCS_BUCKET not set — cloud screenshot upload disabled");
    return null;
  }

  const enabled = (process.env.GCS_ENABLED ?? "true").toLowerCase();
  if (enabled === "false" || enabled === "0") {
    (logger ?? console.log)("INFO", "GCS_ENABLED=false — cloud screenshot upload disabled");
    return null;
  }

  const accessKeyId = process.env.GCS_ACCESS_KEY;
  const secretAccessKey = process.env.GCS_SECRET_KEY;

  if (!accessKeyId || !secretAccessKey) {
    (logger ?? console.log)("WARN", "GCS_ACCESS_KEY or GCS_SECRET_KEY not set — using local-only mode");
    return null;
  }

  return new GcsUploader({
    bucket,
    accessKeyId,
    secretAccessKey,
    projectId: process.env.GCS_PROJECT_ID,
    pathPrefix: process.env.GCS_PATH_PREFIX ?? "screenshots/",
    logger,
  });
}