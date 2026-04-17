import { describe, it, expect } from "vitest";
import { buildWhisperArgs } from "../whisper.js";

describe("buildWhisperArgs", () => {
  it("builds correct faster-whisper arguments", () => {
    const args = buildWhisperArgs("/tmp/audio.mp3");
    expect(args).toContain("/tmp/audio.mp3");
    expect(args).toContain("--model");
    expect(args).toContain("tiny");
    expect(args).toContain("--output_format");
    expect(args).toContain("txt");
  });
});
