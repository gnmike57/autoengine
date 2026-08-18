import "dotenv/config";
import fs from 'node:fs';
import path from 'node:path';
import { classifyWithAI } from '../services/video-verifier.js';
import { GcsUploader } from '../services/gcs-uploader.js';
import { initDB } from '../core/database.js';

async function main() {
  console.log("=== Cloud Storage Pipeline & Vision AI Fallback Test ===");
  initDB();

  console.log("\n[1] Testing Vision AI Fallback (OpenRouter/Vertex)...");

  // Create a dummy red frame buffer to simulate video frames
  const dummyBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  console.log("Sending dummy frames to classifyWithAI()...");
  const result = await classifyWithAI([dummyBuffer], "tempdisabled", "test_site");
  console.log("AI Result:", result);

  console.log("\n[2] Testing Cloud Storage Pipeline (GCS + DB Hook)...");

  if (!process.env.GCP_PROJECT_ID) {
    console.log("⚠️ GCP_PROJECT_ID not set. Skipping live GCS upload test.");
  } else {
    try {
      const gcs = new GcsUploader({ bucket: "test", accessKeyId: "test", secretAccessKey: "test" });
      const testFilePath = path.join(process.cwd(), "test-artifact.txt");
      fs.writeFileSync(testFilePath, "This is a test artifact for Automati1-111 Cloud Pipeline.");

      console.log("Uploading test artifact to GCS...");
      try {
        const uploadRes = await gcs.upload(testFilePath, { target: "screenshot" });
        console.log("Upload Result:", uploadRes);
      } finally {
        if (fs.existsSync(testFilePath)) {
          fs.unlinkSync(testFilePath);
        }
      }
    } catch (e: any) {
      console.error("GCS Upload failed:", e.message);
    }
  }

  console.log("\nTest complete.");
  process.exit(0);
}

main().catch(console.error);
