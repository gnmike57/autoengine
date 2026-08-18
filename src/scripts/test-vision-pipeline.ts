import fs from 'node:fs';
import path from 'node:path';
import { classifyWithAI } from '../services/video-verifier.js';
import { extractKeyFrames } from '../services/video-extraction.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('test-vision-pipeline');

async function main() {
  log.info('--- Starting Vision Pipeline Test ---');

  // Check if we have a test video
  const testVideoPath = path.resolve('test-recording.webm');
  if (!fs.existsSync(testVideoPath)) {
    log.error(`Test video not found at ${testVideoPath}`);
    log.info('Please place a test .webm file named "test-recording.webm" in the root directory to run this test.');
    process.exit(1);
  }

  log.info(`Found test video: ${testVideoPath}`);

  // 1. Test Frame Extraction
  log.info('Extracting frames...');
  const startExtract = Date.now();
  const frames = await extractKeyFrames(testVideoPath);
  const extractDuration = Date.now() - startExtract;

  if (frames.length === 0) {
    log.error('Failed to extract any frames from the video.');
    process.exit(1);
  }

  log.info(`Successfully extracted ${frames.length} frames in ${extractDuration}ms.`);

  // Save frames to disk just to verify them visually if needed
  const debugDir = path.resolve('.vision-debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);

  frames.forEach((buffer: Buffer, idx: number) => {
    fs.writeFileSync(path.join(debugDir, `frame-${idx}.jpg`), buffer);
  });
  log.info(`Saved debug frames to ${debugDir}`);

  // 2. Test Gemini Analysis
  log.info('Sending frames to AI Vision Model...');
  const startAi = Date.now();
  try {
    const result = await classifyWithAI(
      frames,
      "success",
      "joe"
    );

    const aiDuration = Date.now() - startAi;
    log.info(`\n✅ AI Analysis Complete in ${aiDuration}ms`);
    console.log(JSON.stringify(result, null, 2));

  } catch (err: unknown) {
    log.error(`AI Analysis Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  log.info('--- Vision Pipeline Test Finished ---');
}

main().catch((err) => {
  log.error(`Unhandled error: ${String(err)}`);
  process.exit(1);
});
