import { describe, it, expect } from "vitest";
import { buildYtdlpArgs, POT_PROVIDER_URL } from "../ytdlp.js";

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

  it("never tries the default `web` client first (it's the one hit by the datacenter-IP bot-wall)", () => {
    const args = buildYtdlpArgs("https://youtu.be/x", "/tmp/x.mp3");
    const extractorArgsIdx = args.indexOf("--extractor-args");
    expect(extractorArgsIdx).toBeGreaterThan(-1);
    const value = args[extractorArgsIdx + 1];
    expect(value).toMatch(/^youtube:player_client=/);

    const clients = value
      .replace(/^youtube:player_client=/, "")
      .split(",")
      .map((c) => c.trim());
    expect(clients.length).toBeGreaterThan(0);
    // Plain "web" in the first slot would silently re-introduce the
    // blocked client. Variants like web_safari are fine.
    expect(clients[0]).not.toBe("web");
  });

  it("sets a browser User-Agent matching the player_client profile", () => {
    const args = buildYtdlpArgs("https://youtu.be/x", "/tmp/x.mp3");
    const uaIdx = args.indexOf("--user-agent");
    expect(uaIdx).toBeGreaterThan(-1);
    expect(args[uaIdx + 1]).toMatch(/Mozilla\//);
  });

  it("configures the PO Token provider so yt-dlp can satisfy YouTube's attestation requirement", () => {
    // Missing this arg means yt-dlp falls back to no-PO-Token mode, which
    // YouTube rejects for player responses regardless of IP or cookies.
    const args = buildYtdlpArgs("https://youtu.be/x", "/tmp/x.mp3");
    const extractorArgValues = args
      .map((a, i) => (a === "--extractor-args" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);

    // Both levers must be present. Check them independently — pinning the
    // exact count would break legitimately when a future plugin adds its
    // own --extractor-args, but losing either of these two specific pairs
    // silently breaks extraction.
    expect(
      extractorArgValues.some((v) => v.startsWith("youtube:player_client="))
    ).toBe(true);

    // Exact equality against the exported constant so a URL typo, scheme
    // change, or hostname drift (e.g. switching to service DNS, which
    // wouldn't resolve in the shared namespace) fails the test instead of
    // passing a regex that only checks shape.
    expect(extractorArgValues).toContain(
      `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`
    );
  });
});
