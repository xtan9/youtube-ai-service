import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export class AudioCompressError extends Error {
  constructor(public readonly stderr: string) {
    super(`Audio compression failed: ${stderr.slice(0, 200)}`);
    this.name = "AudioCompressError";
  }
}

const FFMPEG_TIMEOUT_MS = 120_000;

// 16 kHz mono 32 kbps mp3. Whisper's training corpus is 16 kHz mono so the
// downsample is loss-free for transcription accuracy; 32 kbps mp3 is well
// above the speech-intelligibility floor while comfortably fitting Groq's
// 25 MB free-tier upload limit (≈ 6.7 MB / 28 min, ≈ 24 MB / 100 min).
export async function compressForGroq(srcPath: string): Promise<string> {
  const dstPath = join(tmpdir(), `groq-${randomUUID()}.mp3`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i",
        srcPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-b:a",
        "32k",
        "-f",
        "mp3",
        dstPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new AudioCompressError(stderr || error.message));
          return;
        }
        resolve();
      }
    );
  });
  return dstPath;
}

export async function cleanupCompressed(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
