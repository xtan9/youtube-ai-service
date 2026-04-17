import { describe, it, expect } from "vitest";
import { buildYtdlpArgs } from "../ytdlp.js";

describe("buildYtdlpArgs", () => {
  it("builds correct yt-dlp arguments", () => {
    const args = buildYtdlpArgs(
      "https://www.youtube.com/watch?v=test123",
      "/tmp/audio.mp3"
    );
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("mp3");
    expect(args).toContain("-o");
    expect(args).toContain("/tmp/audio.mp3");
    expect(args).toContain("https://www.youtube.com/watch?v=test123");
  });
});
