import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { stat, unlink } from "fs/promises";
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
  } catch {
    throw new Error(
      `yt-dlp exited 0 but produced no file at ${outputPath} (stderr: ${stderr.slice(0, 500)})`
    );
  }
  if (size === 0) {
    await unlink(outputPath).catch(() => {});
    throw new Error(
      `yt-dlp exited 0 but produced a 0-byte file (stderr: ${stderr.slice(0, 500)})`
    );
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
