import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";

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
    "--output_format",
    "txt",
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
  }
  return args;
}

// whisper-ctranslate2 is the faster-whisper-backed CLI installed by the
// Dockerfile. The pip package `faster-whisper` has no binary — that
// mismatch produced a latent ENOENT at every transcribe until the
// yt-dlp path was fixed enough to actually reach this step.
export const WHISPER_CLI = "whisper-ctranslate2";

/**
 * Transcribe an audio file using the faster-whisper-backed CLI.
 * When `lang` is provided, whisper's auto-detect is bypassed and the
 * transcription is forced into the named language — used when the
 * orchestrator has a high-confidence signal (yt-dlp metadata) and wants
 * to avoid whisper misfiring on short/noisy audio.
 */
export async function transcribeAudio(
  audioPath: string,
  lang?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildWhisperArgs(audioPath, lang);

    execFile(
      WHISPER_CLI,
      args,
      { timeout: 600_000 },
      async (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`${WHISPER_CLI} failed: ${stderr || error.message}`));
          return;
        }

        const txtPath = join(
          tmpdir(),
          basename(audioPath).replace(/\.[^.]+$/, ".txt")
        );

        try {
          const transcript = await readFile(txtPath, "utf-8");
          await unlink(txtPath).catch((unlinkErr) => {
            // Cleanup failure is non-fatal — the transcript is in-memory —
            // but a repeated EACCES/EBUSY is a leak signal worth surfacing.
            console.warn(
              `[whisper] failed to unlink ${txtPath}: ${unlinkErr}`
            );
          });
          resolve(transcript.trim());
        } catch (readErr) {
          reject(new Error(`Failed to read transcript file: ${readErr}`));
        }
      }
    );
  });
}
