import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildYtdlpMetadataArgs,
  fetchYtdlpMetadata,
} from "../ytdlp-metadata.js";
import { POT_PROVIDER_URL } from "../ytdlp-common.js";

// ESM module spying requires vi.mock at module scope — vi.spyOn on an
// imported namespace fails with "Module namespace is not configurable".
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
const mockedExecFile = vi.mocked(execFile);

describe("buildYtdlpMetadataArgs", () => {
  it("includes --dump-json and --skip-download (the whole point — no audio transfer)", () => {
    const args = buildYtdlpMetadataArgs("https://youtu.be/abc");
    expect(args).toContain("--dump-json");
    expect(args).toContain("--skip-download");
  });

  it("reuses the same player_client profile as the audio download path", () => {
    // If these drift, the metadata path would hit YouTube's bot wall while
    // the download path works — producing a false "no language signal"
    // every time. Lock them to the same profile.
    const args = buildYtdlpMetadataArgs("https://youtu.be/abc");
    const extractorArgValues = args
      .map((a, i) => (a === "--extractor-args" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);

    expect(
      extractorArgValues.some((v) => v.startsWith("youtube:player_client="))
    ).toBe(true);
    expect(extractorArgValues).toContain(
      `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`
    );
  });

  it("sets a browser User-Agent matching the audio-path profile", () => {
    const args = buildYtdlpMetadataArgs("https://youtu.be/abc");
    const uaIdx = args.indexOf("--user-agent");
    expect(uaIdx).toBeGreaterThan(-1);
    expect(args[uaIdx + 1]).toMatch(/Mozilla\//);
  });

  it("puts the URL last (yt-dlp positional arg convention)", () => {
    const args = buildYtdlpMetadataArgs("https://youtu.be/abc");
    expect(args[args.length - 1]).toBe("https://youtu.be/abc");
  });
});

describe("fetchYtdlpMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockExecSuccess = (stdout: string) => {
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads don't narrow cleanly in mock
      (_cmd, _args, _opts, cb) => {
        cb?.(null, stdout, "");
      }
    );
  };

  const mockExecFailure = (error: Error, stderr = "") => {
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads don't narrow cleanly in mock
      (_cmd, _args, _opts, cb) => {
        cb?.(error, "", stderr);
      }
    );
  };

  it("returns parsed metadata on success", async () => {
    mockExecSuccess(
      JSON.stringify({
        title: "Test Video",
        description: "A test video",
        language: "fr",
        duration: 213,
        subtitles: { fr: [{ url: "x", ext: "vtt" }] },
        automatic_captions: { en: [{ url: "y", ext: "vtt" }] },
      })
    );
    const result = await fetchYtdlpMetadata("https://youtu.be/abc");
    expect(result.title).toBe("Test Video");
    expect(result.description).toBe("A test video");
    expect(result.language).toBe("fr");
    expect(result.duration).toBe(213);
    expect(result.subtitles).toEqual({ fr: [{ url: "x", ext: "vtt" }] });
    expect(result.automatic_captions).toEqual({
      en: [{ url: "y", ext: "vtt" }],
    });
  });

  it("normalizes missing fields to safe defaults", async () => {
    // yt-dlp omits `language`, `description`, `subtitles`,
    // `automatic_captions` for videos where those are empty — not returning
    // null. Our downstream consumers expect the fields to exist, so
    // normalize here rather than scattering optional-chaining everywhere.
    mockExecSuccess(JSON.stringify({ title: "Only Title" }));
    const result = await fetchYtdlpMetadata("https://youtu.be/abc");
    expect(result.title).toBe("Only Title");
    expect(result.description).toBe("");
    expect(result.language).toBeNull();
    expect(result.duration).toBeNull();
    expect(result.subtitles).toEqual({});
    expect(result.automatic_captions).toEqual({});
  });

  it.each([
    ["null", null],
    ["undefined (omitted)", undefined],
    ["string", "10:30"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["negative", -5],
  ])(
    "collapses non-finite / non-numeric / negative duration (%s) to null",
    async (_label, value) => {
      // yt-dlp returns `null` on live streams and may emit non-numeric
      // sentinels on schema regressions. Treating any of these as 0
      // would silently pass any "video too long?" gate downstream and
      // reintroduce the silent-hang bug — null forces the caller into
      // "unknown, fall through" branch.
      const payload: Record<string, unknown> = { id: "abc" };
      if (value !== undefined) payload.duration = value;
      mockExecSuccess(JSON.stringify(payload));
      const result = await fetchYtdlpMetadata("https://youtu.be/abc");
      expect(result.duration).toBeNull();
    }
  );

  it("preserves duration=0 (a valid edge — zero-second clips exist)", async () => {
    mockExecSuccess(JSON.stringify({ id: "abc", duration: 0 }));
    const result = await fetchYtdlpMetadata("https://youtu.be/abc");
    expect(result.duration).toBe(0);
  });

  it("throws when yt-dlp exits non-zero", async () => {
    // Propagating the error lets the route return 500 instead of silently
    // falling back to whisper without language hint. If this swallowed the
    // error, a persistent yt-dlp issue would be invisible except as a
    // rising cost-per-request.
    mockExecFailure(new Error("yt-dlp exit 1"), "ERROR: unavailable");
    await expect(
      fetchYtdlpMetadata("https://youtu.be/abc")
    ).rejects.toThrow(/yt-dlp/);
  });

  it("throws when stdout isn't valid JSON", async () => {
    // Silent JSON-parse fallback would produce a metadata object with all
    // defaults, matching the "no signal" case — hiding a real extraction
    // failure. Throw so the route can log + return 500.
    mockExecSuccess("not json at all");
    await expect(
      fetchYtdlpMetadata("https://youtu.be/abc")
    ).rejects.toThrow();
  });

  it("throws when stdout parses but has no anchor fields (schema regression guard)", async () => {
    // A `{}` response looks like a successful empty video — no id, no
    // title, no URL. Collapsing it to all-defaults would let the route
    // return 200 and the orchestrator would pin an arbitrary language
    // to whisper. Catch the regression here at the boundary.
    mockExecSuccess(JSON.stringify({}));
    await expect(
      fetchYtdlpMetadata("https://youtu.be/abc")
    ).rejects.toThrow(/anchor/);
  });

  it("throws when stdout is a JSON array instead of object", async () => {
    mockExecSuccess(JSON.stringify([]));
    await expect(
      fetchYtdlpMetadata("https://youtu.be/abc")
    ).rejects.toThrow(/non-object/);
  });

  it("accepts a payload with `id` only (yt-dlp minimum)", async () => {
    // Some uploads have no description, no uploader, no language — but
    // every real video has an `id`. Don't over-tighten the guard.
    mockExecSuccess(JSON.stringify({ id: "abc123" }));
    const result = await fetchYtdlpMetadata("https://youtu.be/abc");
    expect(result.title).toBe("");
    expect(result.language).toBeNull();
  });

  it("truncates very long descriptions to 2000 chars", async () => {
    // yt-dlp's `description` is unbounded user content. Long descriptions
    // bloat JSON responses and log lines; 2000 chars is more than enough
    // for language detection and human-readable logging.
    const longDescription = "x".repeat(5000);
    mockExecSuccess(
      JSON.stringify({ title: "t", description: longDescription })
    );
    const result = await fetchYtdlpMetadata("https://youtu.be/abc");
    expect(result.description.length).toBe(2000);
  });
});
