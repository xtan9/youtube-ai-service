import { execFile } from "child_process";

const FFPROBE_TIMEOUT_MS = 10_000;

/**
 * Probe the audio file's duration in seconds via `ffprobe -show_format`.
 * Returns `null` on any failure (non-zero exit, malformed JSON, missing
 * field, non-numeric value).
 *
 * Returning null instead of throwing is deliberate — the caller uses it
 * as a "too long, no fallback" signal so a transient ffprobe blip
 * fails closed (no local-Whisper attempt for an unknown-length clip)
 * rather than promoting to a 500.
 */
export async function probeAudioDurationSeconds(
  audioPath: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const stdout = await new Promise<string | null>((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        audioPath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1 * 1024 * 1024, signal },
      (error, out) => {
        if (error) {
          try {
            signal?.throwIfAborted();
          } catch (abortReason) {
            reject(abortReason);
            return;
          }
          // Distinct from "audio is malformed" — this is ffprobe
          // itself failing (missing binary, OOM, timeout). Operators
          // need to distinguish these from "video legitimately
          // unbounded" when GROQ_FAILED_NO_FALLBACK fires with
          // audioSeconds: null.
          console.error(
            "[audio-duration] FFPROBE_EXEC_FAILED",
            {
              errorId: "FFPROBE_EXEC_FAILED",
              audioPath,
              errorName: error instanceof Error ? error.name : "unknown",
              message: error instanceof Error ? error.message.slice(0, 200) : String(error),
            }
          );
          resolve(null);
          return;
        }
        resolve(out);
      }
    );
  });

  if (stdout === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    console.error("[audio-duration] FFPROBE_JSON_PARSE_FAILED", {
      errorId: "FFPROBE_JSON_PARSE_FAILED",
      audioPath,
      message: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("format" in parsed) ||
    typeof (parsed as { format: unknown }).format !== "object" ||
    (parsed as { format: unknown }).format === null
  ) {
    console.error("[audio-duration] FFPROBE_SCHEMA_INVALID", {
      errorId: "FFPROBE_SCHEMA_INVALID",
      audioPath,
      reason: "missing or non-object 'format' field",
    });
    return null;
  }
  const format = (parsed as { format: Record<string, unknown> }).format;
  const raw = format.duration;
  if (typeof raw !== "string" && typeof raw !== "number") {
    console.error("[audio-duration] FFPROBE_DURATION_INVALID", {
      errorId: "FFPROBE_DURATION_INVALID",
      audioPath,
      rawType: typeof raw,
    });
    return null;
  }

  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.error("[audio-duration] FFPROBE_DURATION_INVALID", {
      errorId: "FFPROBE_DURATION_INVALID",
      audioPath,
      rawValue: typeof raw === "string" ? raw.slice(0, 50) : raw,
      parsedSeconds: seconds,
    });
    return null;
  }

  return seconds;
}
