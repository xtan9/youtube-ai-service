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
  audioPath: string
): Promise<number | null> {
  const stdout = await new Promise<string | null>((resolve) => {
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
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1 * 1024 * 1024 },
      (error, out) => {
        if (error) {
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
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("format" in parsed) ||
    typeof (parsed as { format: unknown }).format !== "object" ||
    (parsed as { format: unknown }).format === null
  ) {
    return null;
  }
  const format = (parsed as { format: Record<string, unknown> }).format;
  const raw = format.duration;
  if (typeof raw !== "string" && typeof raw !== "number") return null;

  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return seconds;
}
