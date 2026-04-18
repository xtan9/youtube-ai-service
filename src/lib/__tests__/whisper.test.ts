import { describe, it, expect } from "vitest";
import { buildWhisperArgs, WHISPER_CLI } from "../whisper.js";

describe("buildWhisperArgs", () => {
  it("builds correct whisper-ctranslate2 arguments", () => {
    const args = buildWhisperArgs("/tmp/audio.mp3");
    expect(args).toContain("/tmp/audio.mp3");
    expect(args).toContain("--model");
    expect(args).toContain("tiny");
    expect(args).toContain("--output_format");
    expect(args).toContain("txt");
  });

  it("targets the whisper-ctranslate2 CLI, not faster-whisper (which ships no binary)", () => {
    // Regression guard: a naive `pip install faster-whisper` succeeds but
    // leaves no CLI, so execFile('faster-whisper', ...) would ENOENT at
    // runtime. Pin the binary name so that silent mismatch can't come back.
    expect(WHISPER_CLI).toBe("whisper-ctranslate2");
  });
});
