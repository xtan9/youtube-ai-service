import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export function buildYtdlpArgs(url: string, outputPath: string): string[] {
  return [
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--no-playlist",
    "-o",
    outputPath,
    url,
  ];
}

/**
 * Download audio from a YouTube URL using yt-dlp.
 * Returns the path to the downloaded MP3 file.
 */
export async function downloadAudio(youtubeUrl: string): Promise<string> {
  const outputPath = join(tmpdir(), `ytai-${randomUUID()}.mp3`);

  return new Promise((resolve, reject) => {
    const args = buildYtdlpArgs(youtubeUrl, outputPath);

    execFile("yt-dlp", args, { timeout: 300_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
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
