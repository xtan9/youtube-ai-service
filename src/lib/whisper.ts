import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";

export function buildWhisperArgs(audioPath: string): string[] {
  return [
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
}

/**
 * Transcribe an audio file using faster-whisper CLI.
 * Returns the transcript text.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildWhisperArgs(audioPath);

    execFile(
      "faster-whisper",
      args,
      { timeout: 600_000 },
      async (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(`faster-whisper failed: ${stderr || error.message}`)
          );
          return;
        }

        // faster-whisper outputs a .txt file in the output directory
        const txtPath = join(
          tmpdir(),
          basename(audioPath).replace(/\.[^.]+$/, ".txt")
        );

        try {
          const transcript = await readFile(txtPath, "utf-8");
          // Clean up the output file
          await unlink(txtPath).catch(() => {});
          resolve(transcript.trim());
        } catch (readErr) {
          reject(new Error(`Failed to read transcript file: ${readErr}`));
        }
      }
    );
  });
}
