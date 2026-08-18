import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("video-extraction");
const FRAME_POSITIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const MAX_FRAMES = 8;
const FFMPEG_FRAME_TIMEOUT_MS = 15000;
export async function extractKeyFrames(videoPath: string, positions: number[] = FRAME_POSITIONS): Promise<Buffer[]> {
    const isRemote = videoPath.startsWith("http://") || videoPath.startsWith("https://");
    if (!isRemote && !fs.existsSync(videoPath)) {
    log.warn(`Video not found: ${videoPath}`);
    return [];
    }

    const ffmpegPath = await getFfmpegPath();
    if (!ffmpegPath) {
    log.warn("ffmpeg not available for frame extraction");
    return [];
    }

    const vvFramesBase = path.join(process.cwd(), ".vv-frames");
    await fs.promises.mkdir(vvFramesBase, { recursive: true });
    const tmpDir = await fs.promises.mkdtemp(path.join(vvFramesBase, "job-"));
    const frames: Buffer[] = [];

    try {
    const { spawn } = await import("child_process");

    // Attempt adaptive scene detection extraction first
    await new Promise<void>((resolve, reject) => {
      const outPattern = path.join(tmpDir, "adaptive-%03d.jpg");
      // eslint-disable-next-line prefer-const
      let proc: import("child_process").ChildProcess;

      const timeout = setTimeout(() => {
        if (proc) proc.kill("SIGKILL");
        reject(new Error("ffmpeg adaptive frame extraction timed out"));
      }, FFMPEG_FRAME_TIMEOUT_MS);

      proc = spawn(ffmpegPath, [
        "-i", videoPath,
        "-vf", "select='gt(scene,0.3)'",
        "-vsync", "vfr",
        "-frames:v", String(MAX_FRAMES),
        "-q:v", "2",
        "-y",
        outPattern,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      proc.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const dirFiles = await fs.promises.readdir(tmpDir);
    const extractedFiles = dirFiles.filter(f => f.startsWith("adaptive-")).sort();

    if (extractedFiles.length > 0) {
      // Scene detection worked
      for (const file of extractedFiles) {
        frames.push(await fs.promises.readFile(path.join(tmpDir, file)));
      }
    } else {
      // Fallback to old time-based extraction if scene detection found 0 frames
      log.warn(`Scene detection yielded 0 frames, falling back to time-based extraction`);
      let duration = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        duration = await getVideoDuration(ffmpegPath, videoPath);
        if (duration > 0) break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }

      if (duration > 0) {
        const extractionPromises = positions.slice(0, MAX_FRAMES).map(async (pos, i) => {
          const timestamp = duration * pos;
          const outPath = path.join(tmpDir, `frame-${i}.jpg`);

          await new Promise<void>((resolve, reject) => {
            // eslint-disable-next-line prefer-const
            let proc: import("child_process").ChildProcess;
            const timeout = setTimeout(() => {
              if (proc) proc.kill("SIGKILL");
              reject(new Error("ffmpeg frame extraction timed out"));
            }, FFMPEG_FRAME_TIMEOUT_MS);

            proc = spawn(ffmpegPath, [
              "-ss", String(timestamp),
              "-i", videoPath,
              "-frames:v", "1",
              "-q:v", "2",         // high quality JPEG
              "-y",                // overwrite
              outPath,
            ], { stdio: ["ignore", "pipe", "pipe"] });

            proc.on("close", (code) => {
              clearTimeout(timeout);
              if (code === 0 && fs.existsSync(outPath)) resolve();
              else reject(new Error(`ffmpeg frame extraction failed (exit ${code})`));
            });
            proc.on("error", (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });

          if (fs.existsSync(outPath)) {
            return fs.promises.readFile(outPath);
          }
          return null;
        });

        const results = await Promise.all(extractionPromises);
        for (const res of results) {
          if (res) frames.push(res);
        }
      }
    }
    } catch (err) {
    log.warn(`Frame extraction error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
    // Cleanup temp directory
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }

    return frames;
}

export async function getVideoDuration(ffmpegPath: string, videoPath: string): Promise<number> {
    const ffprobePath = ffmpegPath.replace(/ffmpeg$/, "ffprobe");
    const { spawn } = await import("child_process");

    return new Promise<number>((resolve) => {
    // Try ffprobe first, fall back to ffmpeg -i
    const bin = fs.existsSync(ffprobePath) ? ffprobePath : ffmpegPath;
    const args = bin.endsWith("ffprobe")
      ? ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]
      : ["-i", videoPath];

    let output = "";
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(0);
    }, 12000);

    proc.on("close", () => {
      clearTimeout(timeout);
      // Try parsing ffprobe output (plain number)
      const plain = parseFloat(output.trim());
      if (Number.isFinite(plain) && plain > 0) { resolve(plain); return; }
      // Try parsing ffmpeg -i output (Duration: HH:MM:SS.ss)
      const m = output.match(/Duration:\s+(\d+):(\d+):(\d+)\.(\d+)/);
      if (m) {
        // @ts-expect-error noUncheckedIndexedAccess
        const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100;
        resolve(secs);
        return;
      }
      resolve(0);
    });
    proc.on("error", () => { clearTimeout(timeout); resolve(0); });
    });
}

export async function getFfmpegPath(): Promise<string | null> {
    try {
    const ffmpegStatic = await import("ffmpeg-static");
    const p = (ffmpegStatic.default || ffmpegStatic) as unknown as string;
    if (p && fs.existsSync(p)) return p;
    } catch { /* fall through */ }

    // Check system PATH
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const { stdout } = await execAsync(cmd, { encoding: "utf-8" });
    const result = stdout.trim();
    if (result && fs.existsSync(result)) return result;
    } catch { /* not on PATH */ }

    return null;
}
