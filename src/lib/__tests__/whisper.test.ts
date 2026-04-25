import { describe, it, expect } from "vitest";
import { buildWhisperArgs, parseWhisperJson, WHISPER_CLI } from "../whisper.js";

describe("buildWhisperArgs", () => {
  it("builds correct whisper-ctranslate2 arguments", () => {
    const args = buildWhisperArgs("/tmp/audio.mp3");
    expect(args).toContain("/tmp/audio.mp3");
    expect(args).toContain("--model");
    expect(args).toContain("tiny");
    expect(args).toContain("--output_format");
    expect(args).toContain("json");
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
    // json output preserves per-segment timing the frontend uses to
    // render clickable timestamps. A regression to txt would silently
    // strip timing data — this guard catches that drift.
    expect(flagPairs["--output_format"]).toBe("json");
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

describe("parseWhisperJson", () => {
  it("maps whisper segments to {text,start,duration} and computes duration from end-start", () => {
    const json = JSON.stringify({
      segments: [
        { id: 0, start: 0.0, end: 2.5, text: "Hello world" },
        { id: 1, start: 2.5, end: 5.0, text: "How are you" },
      ],
    });
    expect(parseWhisperJson(json)).toEqual([
      { text: "Hello world", start: 0.0, duration: 2.5 },
      { text: "How are you", start: 2.5, duration: 2.5 },
    ]);
  });

  it("trims whitespace and drops segments with empty text", () => {
    // whisper-ctranslate2 sometimes prefixes a leading space and emits a
    // trailing empty segment for end-of-audio silence. The frontend would
    // render that as a phantom 00:00 paragraph if it slipped through.
    const json = JSON.stringify({
      segments: [
        { start: 0, end: 1, text: " hello " },
        { start: 1, end: 2, text: "" },
        { start: 2, end: 3, text: "   " },
      ],
    });
    expect(parseWhisperJson(json)).toEqual([
      { text: "hello", start: 0, duration: 1 },
    ]);
  });

  it("throws on malformed JSON (a non-fatal fall-through would silently bill GPU)", () => {
    expect(() => parseWhisperJson("not json")).toThrow(/JSON parse failed/);
  });

  it("throws when the segments array is missing (catches CLI version drift)", () => {
    // A faster-whisper-ctranslate2 upgrade that changed the JSON shape
    // would break this contract — we want a loud failure, not a silent
    // empty transcript.
    expect(() => parseWhisperJson(JSON.stringify({ language: "en" }))).toThrow(
      /missing `segments` array/
    );
  });

  it("throws when a segment is missing required fields", () => {
    expect(() =>
      parseWhisperJson(
        JSON.stringify({ segments: [{ start: 0, text: "hi" }] })
      )
    ).toThrow(/missing start\/end\/text/);
  });
});
