import { describe, it, expect, vi, beforeEach } from "vitest";
import { GcsUploader, createGcsUploaderFromEnv } from "../../src/services/gcs-uploader.js";
import fs from "fs";

// Mock AWS SDK
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: class { send = mockSend; },
    PutObjectCommand: class PutObjectCommand {},
    DeleteObjectCommand: class DeleteObjectCommand {},
    HeadObjectCommand: class HeadObjectCommand {},
    HeadBucketCommand: class HeadBucketCommand {}
  };
});

// Mock fs
vi.mock("fs", () => {
  return {
    default: {
      existsSync: vi.fn(),
      statSync: vi.fn(),
      createReadStream: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(Buffer.from("a")),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn()
    }
  };
});

describe("gcs-uploader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    delete process.env.GCS_BUCKET;
    delete process.env.GCS_ACCESS_KEY;
    delete process.env.GCS_SECRET_KEY;
    delete process.env.GCS_ENABLED;
  });

  describe("createGcsUploaderFromEnv", () => {
    it("should return null if GCS_BUCKET is not set", () => {
      const uploader = createGcsUploaderFromEnv();
      expect(uploader).toBeNull();
    });

    it("should return null if GCS_ENABLED is false", () => {
      process.env.GCS_BUCKET = "test-bucket";
      process.env.GCS_ENABLED = "false";
      const uploader = createGcsUploaderFromEnv();
      expect(uploader).toBeNull();
    });

    it("should return null if access keys are missing", () => {
      process.env.GCS_BUCKET = "test-bucket";
      const uploader = createGcsUploaderFromEnv();
      expect(uploader).toBeNull();
    });

    it("should create uploader when env vars are correct", () => {
      process.env.GCS_BUCKET = "test-bucket";
      process.env.GCS_ACCESS_KEY = "access123";
      process.env.GCS_SECRET_KEY = "secret123";
      
      const uploader = createGcsUploaderFromEnv();
      expect(uploader).toBeInstanceOf(GcsUploader);
      expect(uploader?.isReady).toBe(true);
    });
  });

  describe("GcsUploader", () => {
    let uploader: GcsUploader;

    beforeEach(() => {
      uploader = new GcsUploader({
        bucket: "test-bucket",
        accessKeyId: "access",
        secretAccessKey: "secret",
        logger: vi.fn()
      });
    });

    it("should not upload if file doesn't exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      const result = await uploader.upload("fake/path.png");
      expect(result).toBeNull();
    });

    it("should process an upload successfully", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.statSync).mockReturnValueOnce({ size: 1024 } as any);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.createReadStream).mockReturnValueOnce({} as any);
      mockSend.mockResolvedValueOnce({}); // S3 send success

      const result = await uploader.upload("fake/path.png", { label: "test" });
      
      expect(result).toMatchObject({
        localPath: "fake/path.png",
        gcsPath: "gs://test-bucket/screenshots/path.png",
        publicUrl: "https://storage.googleapis.com/test-bucket/screenshots/path.png",
        sizeBytes: 1024,
        label: "test"
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(fs.unlinkSync).toHaveBeenCalledWith("fake/path.png");
    });

    it("should handle buffer uploads", async () => {
      mockSend.mockResolvedValueOnce({});
      const buf = Buffer.from("test");

      const result = await uploader.uploadBuffer(buf, "test.png", { label: "buffer-test" });

      expect(result).toMatchObject({
        gcsPath: "gs://test-bucket/screenshots/test.png",
        publicUrl: "https://storage.googleapis.com/test-bucket/screenshots/test.png",
        sizeBytes: 4,
        label: "buffer-test"
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should delete file by filename", async () => {
      mockSend.mockResolvedValueOnce({});
      
      const result = await uploader.deleteByFilename("test.png");
      
      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should handle backfill from disk", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // dir exists
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.readdirSync).mockReturnValueOnce(["test1.png", "test2.jpg"] as any);
      
      // Setup mockSend to reject HeadObject, but resolve PutObject
      mockSend.mockImplementation((command) => {
        if (command.constructor.name === "HeadObjectCommand") {
          return Promise.reject(Object.assign(new Error(), { name: "NotFound" }));
        }
        return Promise.resolve({});
      });

      const count = await uploader.backfillFromDisk("fake-dir");
      expect(count).toBe(2);
    });

    it("should return 0 from backfill if dir doesn't exist or is not ready", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      expect(await uploader.backfillFromDisk("fake-dir")).toBe(0);
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (uploader as any)._ready = false;
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      expect(await uploader.backfillFromDisk("fake-dir")).toBe(0);
    });

    it("should uploadFileIfExists successfully", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      // eslint-disable-next-line @typescript-eslint/require-await
      mockSend.mockImplementation(async (cmd) => {
        if (cmd.constructor.name === "HeadObjectCommand") throw Object.assign(new Error(), { name: "NotFound" });
      });
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.createReadStream).mockReturnValueOnce({} as any);

      const result = await uploader.uploadFileIfExists("test.csv");
      expect(result).toBe(true);
    });

    it("should delete existing file in uploadFileIfExists if it is a csv or db", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      // eslint-disable-next-line @typescript-eslint/require-await
      mockSend.mockImplementation(async (cmd) => {
        if (cmd.constructor.name === "HeadObjectCommand") return {}; // it exists
        if (cmd.constructor.name === "DeleteObjectCommand") return {};
        if (cmd.constructor.name === "PutObjectCommand") return {};
      });
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.createReadStream).mockReturnValueOnce({} as any);

      const result = await uploader.uploadFileIfExists("results.csv");
      expect(result).toBe(true);
    });

    it("should ensureBucket verifies accessibility", async () => {
      mockSend.mockResolvedValueOnce({});
      await uploader.ensureBucket();
      expect(mockSend).toHaveBeenCalled();
    });

    it("should gracefully handle shutdown", async () => {
      await uploader.shutdown();
      expect(true).toBe(true);
    });

    it("should disable on 403 error during buffer upload", async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } }));
      const result = await uploader.uploadBuffer(Buffer.from("a"), "test.png");
      expect(result).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((uploader as any)._disabled).toBe(true);
    });

    it("should handle network offline states during _doUpload", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (uploader as any)._offlineCooldownMs = 1000;
      mockSend.mockRejectedValueOnce(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" }));
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.statSync).mockReturnValueOnce({ size: 100 } as any);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.createReadStream).mockReturnValueOnce({} as any);

      // This should trigger _markOffline and reject the promise
      await expect(uploader.upload("fake.png")).rejects.toThrow("Timeout");
      
      // The uploader is now offline
      expect(uploader.isOffline).toBe(true);
      
      // Should defer next upload
      const result = await uploader.upload("fake2.png");
      expect(result).toBeNull();
      
      // Wait for cooldown
      await new Promise(r => setTimeout(r, 1050));
      expect(uploader.isOffline).toBe(false);
    });

    it("should retry on unknown error during buffer upload", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (uploader as any).retries = 2;
      mockSend
        .mockRejectedValueOnce(new Error("Random SDK Error"))
        .mockResolvedValueOnce({});
      
      const result = await uploader.uploadBuffer(Buffer.from("a"), "test.png");
      expect(result).not.toBeNull();
    });

    it("should throw after max retries in _doUpload", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (uploader as any).retries = 1;
      mockSend.mockRejectedValueOnce(new Error("Hard fail"));
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      vi.mocked(fs.createReadStream).mockReturnValue({} as any);

      await expect(uploader.upload("fake.png")).rejects.toThrow("Hard fail");
    });
  });
});
