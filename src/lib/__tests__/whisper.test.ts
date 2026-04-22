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

  // The constant itself is pinned in a brittle way — renaming the export
  // satisfies a `toBe("whisper-ctranslate2")` check, defeating the guard.
  // Instead assert the argv *contract* the CLI requires: audio path in
  // position 0, flags use whisper-ctranslate2-specific spellings
  // (underscores not dashes, capitalized boolean). The post-deploy smoke
  // test verifies the binary is on PATH; this test locks in the flag
  // signature so a future refactor can't drift argv incompatibly.
  it("emits the exact argv contract whisper-ctranslate2 requires", () => {
    const args = buildWhisperArgs("/tmp/audio.mp3");

    expect(args[0]).toBe("/tmp/audio.mp3");
    expect(WHISPER_CLI).toBe("whisper-ctranslate2");

    // Flag names use the whisper-ctranslate2 convention (underscores,
    // capitalized bool). A drift to --vad-filter / true would pass an
    // older regex-style assertion but silently fail against the real CLI.
    const flagPairs: Record<string, string> = {};
    for (let i = 1; i < args.length; i += 2) {
      flagPairs[args[i]] = args[i + 1];
    }
    expect(flagPairs["--compute_type"]).toBe("int8");
    expect(flagPairs["--vad_filter"]).toBe("True");
    expect(flagPairs["--output_format"]).toBe("txt");
    expect(flagPairs["--beam_size"]).toBe("1");
  });

  it("omits --language when no lang provided (preserves whisper auto-detect default)", () => {
    // Back-compat: callers that don't pass lang must see exactly the same
    // argv as before, so whisper's built-in language detection continues
    // to run. A stray --language flag would silently override that.
    const args = buildWhisperArgs("/tmp/audio.mp3");
    expect(args).not.toContain("--language");
  });

  it("emits --language <code> when a lang is provided", () => {
    // whisper-ctranslate2 accepts ISO 639-1 codes directly. The flag form
    // is `--language fr` (space-separated, not `=fr`).
    const args = buildWhisperArgs("/tmp/audio.mp3", "fr");
    const langIdx = args.indexOf("--language");
    expect(langIdx).toBeGreaterThan(-1);
    expect(args[langIdx + 1]).toBe("fr");
  });

  it("emits --language for zh path (ensures CJK languages survive normalization)", () => {
    const args = buildWhisperArgs("/tmp/audio.mp3", "zh");
    const langIdx = args.indexOf("--language");
    expect(args[langIdx + 1]).toBe("zh");
  });
});
