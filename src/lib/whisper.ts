import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";
import type { TranscriptSegment } from "./captions.js";
import { getLanguageAnchorPrompt } from "./language-prompt.js";
import { isNodeErrorWithCode } from "./node-errors.js";

export function buildWhisperArgs(audioPath: string, lang?: string): string[] {
  const args = [
    audioPath,
    "--model",
    "tiny",
    "--device",
    "cpu",
    "--compute_type",
    "int8",
    "--beam_size",
    "1",
    "--vad_filter",
    "True",
    // JSON output preserves per-segment timing the frontend uses to render
    // clickable timestamps. Plain-text output dropped the timing data on
    // the floor before the frontend ever saw it.
    "--output_format",
    "json",
    "--output_dir",
    tmpdir(),
  ];
  // Pinning --language protects against whisper's auto-detect misfiring on
  // short or noisy clips (the bug that produced Arabic transcripts for
  // French audio before this flag was threaded through). Callers should
  // only pass lang when they have a high-confidence source — uploader
  // metadata or yt-dlp's extracted `language`. A wrong hint would force
  // whisper to mis-transcribe cleanly rather than guess, so "no hint" is
  // still the safer default when confidence is low.
  if (lang) {
    args.push("--language", lang);
    // Disable previous-chunk conditioning when a language is pinned.
    // Default is True, which carries forward whisper's last-window output
    // as context for the next window. Once whisper hallucinates a token
    // in the wrong language during a non-speech segment (silence between
    // sentences, background music, B-roll), that hallucination
    // propagates through subsequent chunks until strong native audio
    // resets it — captured on video hrREdNm7vB4 where ~46% of a Chinese
    // audio's segments came back as nonsense English with `--language
    // zh` pinned. Disabling the conditioning keeps each window
    // independent so a single bad chunk can't cascade.
    args.push("--condition_on_previous_text", "False");
    // Native-language anchor sentence biases whisper's output
    // distribution toward the target language for low-confidence
    // segments where `--language` alone isn't enough. Only set when we
    // have an anchor for this code; otherwise fall through to flag-only
    // pinning (the prior behavior — strictly additive guard).
    const anchor = getLanguageAnchorPrompt(lang);
    if (anchor) {
      args.push("--initial_prompt", anchor);
    }
  }
  return args;
}

// whisper-ctranslate2 is the faster-whisper-backed CLI installed by the
// Dockerfile. The pip package `faster-whisper` has no binary — that
// mismatch produced a latent ENOENT at every transcribe until the
// yt-dlp path was fixed enough to actually reach this step.
export const WHISPER_CLI = "whisper-ctranslate2";

export class LocalTranscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalTranscriptionError";
  }
}

interface WhisperJsonSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperJsonOutput {
  segments: WhisperJsonSegment[];
}

/**
 * Parse the JSON file written by `whisper-ctranslate2 --output_format json`
 * into our segment shape. Drops empty segments (whisper sometimes emits a
 * trailing `""` for end-of-audio silence) and trims surrounding whitespace
 * the model occasionally leaves on segment text.
 *
 * Throws on schema mismatch — a silent fall-through to "no segments" would
 * hide a faster-whisper-ctranslate2 upgrade that broke the JSON contract,
 * billing GPU for transcripts the frontend then renders as a single 00:00
 * legacy paragraph.
 */
export function parseWhisperJson(json: string): TranscriptSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `whisper JSON parse failed: ${err instanceof Error ? err.message : err}`
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as WhisperJsonOutput).segments)
  ) {
    throw new Error("whisper JSON missing `segments` array");
  }
  const raw = (parsed as WhisperJsonOutput).segments;
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    if (
      typeof s.start !== "number" ||
      typeof s.end !== "number" ||
      typeof s.text !== "string"
    ) {
      throw new Error("whisper JSON segment missing start/end/text");
    }
    const text = s.text.trim();
    if (!text) continue;
    out.push({ text, start: s.start, duration: s.end - s.start });
  }
  return out;
}

/**
 * Transcribe an audio file using the faster-whisper-backed CLI.
 * When `lang` is provided, whisper's auto-detect is bypassed and the
 * transcription is forced into the named language — used when the
 * orchestrator has a high-confidence signal (yt-dlp metadata) and wants
 * to avoid whisper misfiring on short/noisy audio.
 *
 * Returns timestamped segments — the frontend uses these to render
 * clickable timestamps that seek the embedded YouTube player.
 */
export async function transcribeAudio(
  audioPath: string,
  lang?: string,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const jsonPath = join(
    tmpdir(),
    basename(audioPath).replace(/\.[^.]+$/, ".json"),
  );
  return new Promise((resolve, reject) => {
    const args = buildWhisperArgs(audioPath, lang);

    execFile(
      WHISPER_CLI,
      args,
      { timeout: 600_000, signal },
      async (error, _stdout, stderr) => {
        if (error) {
          await cleanupWhisperOutput(jsonPath);
          reject(
            new LocalTranscriptionError(
              `${WHISPER_CLI} failed: ${stderr || error.message}`,
              { cause: error }
            )
          );
          return;
        }

        try {
          const raw = await readFile(jsonPath, "utf-8");
          const segments = parseWhisperJson(raw);
          await cleanupWhisperOutput(jsonPath);
          resolve(segments);
        } catch (readErr) {
          await cleanupWhisperOutput(jsonPath);
          reject(
            new LocalTranscriptionError(
              `Failed to read transcript file: ${readErr}`,
              { cause: readErr }
            )
          );
        }
      }
    );
  });
}

async function cleanupWhisperOutput(jsonPath: string): Promise<void> {
  try {
    await unlink(jsonPath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    console.warn(`[whisper] failed to unlink ${jsonPath}: ${error}`);
  }
}
