import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Three-arm discriminator so callers (and prod logs) can tell apart
// "ffmpeg isn't installed" from "ffmpeg ran but bailed on the input"
// from "we killed ffmpeg at the timeout." Ops triage is materially
// different for each.
export type AudioCompressKind =
  | "missing-binary"
  | "timeout"
  | "ffmpeg-failed";

export class AudioCompressError extends Error {
  constructor(
    public readonly kind: AudioCompressKind,
    public readonly detail: string,
    public readonly cause?: Error
  ) {
    super(`Audio compression failed (${kind}): ${detail.slice(0, 200)}`);
    this.name = "AudioCompressError";
  }
}

const FFMPEG_TIMEOUT_MS = 120_000;

// 16 kHz mono 32 kbps mp3. Whisper's training corpus is 16 kHz mono so the
// downsample is transcription-neutral — Whisper itself resamples back to
// that same rate before inference. 32 kbps mp3 sits comfortably above the
// speech-intelligibility floor while shrinking the upload roughly an order
// of magnitude vs yt-dlp's `--audio-quality 0` output (~245 kbps VBR),
// keeping the compressed file under Groq's 25 MB free-tier cap for the
// vast majority of YouTube content (≈ 240 KB/min ⇒ ~100 min headroom).
export async function compressForGroq(srcPath: string): Promise<string> {
  const dstPath = join(tmpdir(), `groq-${randomUUID()}.mp3`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-y",
          // `-loglevel error`: drop ffmpeg's per-input banner and progress
          // chatter so a 200-char detail excerpt actually contains the
          // failure reason rather than copyright text.
          "-loglevel",
          "error",
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
            const stderrStr =
              typeof stderr === "string" ? stderr : String(stderr);
            const trimmedStderr = stderrStr.trim();
            // node sets `killed: true` (and signal: SIGTERM) when the
            // execFile timeout fires. stderr at the kill instant is
            // typically truncated mid-line, so we synthesize a useful
            // detail rather than leaking partial output.
            if (
              error.killed === true ||
              error.signal === "SIGTERM"
            ) {
              reject(
                new AudioCompressError(
                  "timeout",
                  `ffmpeg killed by ${FFMPEG_TIMEOUT_MS}ms timeout`,
                  error
                )
              );
              return;
            }
            // ENOENT from execFile means the `ffmpeg` binary itself isn't
            // on PATH — that's a deploy/container regression, not bad
            // input, and ops needs to see it as such.
            if (error.code === "ENOENT") {
              reject(
                new AudioCompressError(
                  "missing-binary",
                  error.message,
                  error
                )
              );
              return;
            }
            reject(
              new AudioCompressError(
                "ffmpeg-failed",
                trimmedStderr || error.message,
                error
              )
            );
            return;
          }
          resolve();
        }
      );
    });
  } catch (err) {
    // ffmpeg may have written a partial mp3 (especially on timeout-kill
    // mid-encode) — unlink before propagating so we don't leak a temp
    // file the caller can't see.
    await unlink(dstPath).catch(() => undefined);
    throw err;
  }
  return dstPath;
}

// Logs non-ENOENT failures explicitly. ENOENT here means "already gone"
// which is fine on every cleanup path. Anything else (EACCES, EBUSY,
// EROFS, EMFILE, ENOSPC) is a leak/observability signal — silent-swallow
// would let `/tmp` fill up unnoticed, which is exactly what bit
// `ytdlp.cleanupAudio` historically.
export async function cleanupCompressed(path: string): Promise<void> {
  await unlink(path).catch((err: unknown) => {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    console.warn(
      `[audio-compress] CLEANUP_COMPRESSED_FAILED for ${path}`,
      {
        errorId: "CLEANUP_COMPRESSED_FAILED",
        path,
        error: err instanceof Error ? err.message : String(err),
      }
    );
  });
}
