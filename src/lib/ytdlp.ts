import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildYtdlpCommonArgs } from "./ytdlp-common.js";

export { POT_PROVIDER_URL } from "./ytdlp-common.js";

export class AudioMediaLimitError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly maxBytes: number
  ) {
    super(`downloaded media is ${sizeBytes} bytes, limit is ${maxBytes}`);
    this.name = "AudioMediaLimitError";
  }
}

export function buildYtdlpArgs(url: string, outputPath: string): string[] {
  return [
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    ...buildYtdlpCommonArgs(),
    "-o",
    outputPath,
    url,
  ];
}

/**
 * Download audio from a YouTube URL using yt-dlp.
 * Returns the path to the downloaded MP3 file.
 */
export async function downloadAudio(
  youtubeUrl: string,
  maxBytes?: number
): Promise<string> {
  const outputPath = join(tmpdir(), `ytai-${randomUUID()}.mp3`);

  const stderr = await new Promise<string>((resolve, reject) => {
    const args = buildYtdlpArgs(youtubeUrl, outputPath);
    execFile("yt-dlp", args, { timeout: 300_000 }, (error, _stdout, err) => {
      if (error) {
        reject(new Error(`yt-dlp failed: ${err || error.message}`));
        return;
      }
      resolve(err);
    });
  });

  // yt-dlp can exit 0 with a missing or empty file when player-client
  // cascades partially succeed (metadata extracted, stream URL returns
  // 0 bytes). Without this check Whisper gets a dead file and throws an
  // opaque decoder error far from the real cause.
  let size: number;
  try {
    size = (await stat(outputPath)).size;
  } catch (statErr) {
    // Preserve the original stat failure as `cause` so EACCES/ENAMETOOLONG
    // (rare but real on full disks / hostile tmp setups) don't get
    // misattributed to "no file produced".
    throw new Error(
      `yt-dlp exited 0 but stat of ${outputPath} failed (stderr: ${stderr.slice(0, 500)})`,
      { cause: statErr }
    );
  }
  if (size === 0) {
    await unlink(outputPath).catch(() => {});
    throw new Error(
      `yt-dlp exited 0 but produced a 0-byte file (stderr: ${stderr.slice(0, 500)})`
    );
  }

  if (maxBytes !== undefined && size > maxBytes) {
    await unlink(outputPath).catch(() => {});
    throw new AudioMediaLimitError(size, maxBytes);
  }

  return outputPath;
}

/**
 * Clean up a temporary audio file.
 */
export async function cleanupAudio(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }
}
