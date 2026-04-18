import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Datacenter IPs frequently hit YouTube's "Sign in to confirm you're not a
// bot" wall when yt-dlp uses the default `web` player client. Cycling
// through alternate clients (mweb / web_safari / android_vr) unblocks most
// requests at zero extra cost. If YouTube escalates and these also fail,
// the next lever is a cookies.txt from a logged-in throwaway account.
const YOUTUBE_PLAYER_CLIENTS = "web_safari,mweb,android_vr";

// Pair the client list with a browser UA so the request profile matches.
const SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export function buildYtdlpArgs(url: string, outputPath: string): string[] {
  return [
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--no-playlist",
    "--extractor-args",
    `youtube:player_client=${YOUTUBE_PLAYER_CLIENTS}`,
    "--user-agent",
    SAFARI_USER_AGENT,
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
