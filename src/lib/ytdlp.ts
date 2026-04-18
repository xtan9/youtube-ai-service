import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Datacenter IPs frequently hit YouTube's "Sign in to confirm you're not a
// bot" wall when yt-dlp uses the default `web` player client. Cycling
// through alternate clients (mweb / web_safari / android_vr) unblocks most
// requests when combined with a residential-IP egress path (Tailscale exit
// node → home device, wired in docker-compose.yml).
const YOUTUBE_PLAYER_CLIENTS = "web_safari,mweb,android_vr";

// Pair the client list with a browser UA so the request profile matches.
const SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// Proof-of-Origin Token provider. `pot-provider` is the sibling container
// (see docker-compose.yml) that shares our network namespace, so it's
// reachable on localhost. YouTube enforces PO Tokens across multiple
// extraction paths — without this, requests fail regardless of IP
// reputation or cookie state. Override via env for local dev or if the
// sidecar's bind address changes.
export const POT_PROVIDER_URL =
  process.env.POT_PROVIDER_URL ?? "http://127.0.0.1:4416";

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
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`,
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
