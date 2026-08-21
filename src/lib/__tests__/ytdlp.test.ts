import { beforeEach, describe, it, expect, vi } from "vitest";
import { buildYtdlpArgs, createAudioDownloader } from "../ytdlp.js";
import { parseYouTubeVideoReference } from "../youtube-url.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "child_process";

const mockedExecFile = vi.mocked(execFile);

const mediaConfig = {
  potProviderUrl: "http://custom-pot-provider.internal:4416",
};
const VIDEO_REFERENCE = parseYouTubeVideoReference(
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
);
if (!VIDEO_REFERENCE) throw new Error("test fixture must be a YouTube URL");

describe("buildYtdlpArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds correct yt-dlp arguments", () => {
    const args = buildYtdlpArgs(
      VIDEO_REFERENCE,
      "/tmp/audio.mp3",
      mediaConfig
    );
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("mp3");
    expect(args).toContain("-o");
    expect(args).toContain("/tmp/audio.mp3");
    expect(args).toContain(VIDEO_REFERENCE.url);
  });

  it("never tries the default `web` client first (it's the one hit by the datacenter-IP bot-wall)", () => {
    const args = buildYtdlpArgs(
      VIDEO_REFERENCE,
      "/tmp/x.mp3",
      mediaConfig
    );
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

  it("uses one full-download-capable client so the selected media URL matches its request profile", () => {
    const args = buildYtdlpArgs(
      VIDEO_REFERENCE,
      "/tmp/x.mp3",
      mediaConfig
    );
    const extractorArgsIdx = args.indexOf("--extractor-args");
    const value = args[extractorArgsIdx + 1];
    expect(value).toBe("youtube:player_client=web_embedded");
  });

  it("sets a browser User-Agent matching the player_client profile", () => {
    const args = buildYtdlpArgs(
      VIDEO_REFERENCE,
      "/tmp/x.mp3",
      mediaConfig
    );
    const uaIdx = args.indexOf("--user-agent");
    expect(uaIdx).toBeGreaterThan(-1);
    expect(args[uaIdx + 1]).toMatch(/Mozilla\//);
  });

  it("enables the image-provided Deno runtime for YouTube JS challenges", () => {
    const args = buildYtdlpArgs(
      VIDEO_REFERENCE,
      "/tmp/x.mp3",
      mediaConfig
    );
    const runtimeIdx = args.indexOf("--js-runtimes");
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(args[runtimeIdx + 1]).toBe("deno");
  });

  it("configures the PO Token provider so yt-dlp can satisfy YouTube's attestation requirement", () => {
    // Missing this arg means yt-dlp falls back to no-PO-Token mode, which
    // YouTube rejects for player responses regardless of IP or cookies.
    const args = buildYtdlpArgs(
      VIDEO_REFERENCE,
      "/tmp/x.mp3",
      mediaConfig
    );
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
      `youtubepot-bgutilhttp:base_url=${mediaConfig.potProviderUrl}`
    );
  });

  it("passes the request work signal to yt-dlp", async () => {
    const signal = new AbortController().signal;
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads do not narrow cleanly in mocks
      (_command, _args, _options, callback) => {
        callback?.(new Error("stop before stat"), "", "aborted");
      },
    );

    await expect(
      createAudioDownloader(mediaConfig)(
        VIDEO_REFERENCE,
        "/tmp/x.mp3",
        1_000,
        signal,
      ),
    ).rejects.toThrow();
    expect(mockedExecFile.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ signal }),
    );
  });
});
