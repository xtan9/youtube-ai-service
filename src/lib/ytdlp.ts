import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildYtdlpCommonArgs,
  YOUTUBE_TRANSCRIPTION_AUDIO_FORMAT,
} from "./ytdlp-common.js";
import { isNodeErrorWithCode } from "./node-errors.js";
import type { MediaAcquisitionConfig } from "./runtime-config.js";
import type { YouTubeVideoReference } from "./youtube-url.js";

export class AudioMediaLimitError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`downloaded media is ${sizeBytes} bytes, limit is ${maxBytes}`);
    this.name = "AudioMediaLimitError";
  }
}

export class AudioDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioDownloadError";
  }
}

export function createAudioPath(): string {
  return join(tmpdir(), `ytai-${randomUUID()}.webm`);
}

export function buildYtdlpArgs(
  videoReference: YouTubeVideoReference,
  outputPath: string,
  config: MediaAcquisitionConfig,
): string[] {
  return [
    "-f",
    YOUTUBE_TRANSCRIPTION_AUDIO_FORMAT,
    ...buildYtdlpCommonArgs(config),
    "-o",
    outputPath,
    videoReference.url,
  ];
}

/**
 * Download audio from a YouTube URL using yt-dlp.
 * Writes the downloaded MP3 to the workflow-owned path.
 */
export function createAudioDownloader(config: MediaAcquisitionConfig) {
  return (
    videoReference: YouTubeVideoReference,
    outputPath: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ) =>
    downloadAudioWithConfig(
      config,
      videoReference,
      outputPath,
      maxBytes,
      signal,
    );
}

async function downloadAudioWithConfig(
  config: MediaAcquisitionConfig,
  videoReference: YouTubeVideoReference,
  outputPath: string,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<void> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const args = buildYtdlpArgs(videoReference, outputPath, config);
    execFile(
      "yt-dlp",
      args,
      { timeout: 300_000, signal },
      (error, _stdout, err) => {
        if (error) {
          reject(
            new AudioDownloadError(`yt-dlp failed: ${err || error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve(err);
      },
    );
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
    throw new AudioDownloadError(
      `yt-dlp exited 0 but stat of ${outputPath} failed (stderr: ${stderr.slice(0, 500)})`,
      { cause: statErr },
    );
  }
  if (size === 0) {
    throw new AudioDownloadError(
      `yt-dlp exited 0 but produced a 0-byte file (stderr: ${stderr.slice(0, 500)})`,
    );
  }

  if (maxBytes !== undefined && size > maxBytes) {
    throw new AudioMediaLimitError(size, maxBytes);
  }
}

/**
 * Clean up a temporary audio file.
 */
export async function cleanupAudio(filePath: string): Promise<void> {
  let firstFailure: unknown;
  // yt-dlp writes `<output>.part` until a native download completes. The
  // request signal can abort mid-transfer, so clean both names; otherwise a
  // timed-out long video slowly fills the container's /tmp volume.
  for (const candidate of [filePath, `${filePath}.part`]) {
    try {
      await unlink(candidate);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT") && firstFailure === undefined) {
        firstFailure = error;
      }
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
