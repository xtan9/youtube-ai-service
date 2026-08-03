import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildYtdlpMetadataArgs,
  createYtdlpMetadataFetcher,
  YtdlpAcquisitionError,
} from "../ytdlp-metadata.js";
import { parseYouTubeVideoReference } from "../youtube-url.js";

const mediaConfig = {
  potProviderUrl: "http://custom-pot-provider.internal:4416",
};
const fetchYtdlpMetadata = createYtdlpMetadataFetcher(mediaConfig);
const VIDEO_REFERENCE = parseYouTubeVideoReference(
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
);
if (!VIDEO_REFERENCE) throw new Error("test fixture must be a YouTube URL");

// ESM module spying requires vi.mock at module scope — vi.spyOn on an
// imported namespace fails with "Module namespace is not configurable".
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
const mockedExecFile = vi.mocked(execFile);

describe("buildYtdlpMetadataArgs", () => {
  it("includes --dump-json and --skip-download (the whole point — no audio transfer)", () => {
    const args = buildYtdlpMetadataArgs(VIDEO_REFERENCE, mediaConfig);
    expect(args).toContain("--dump-json");
    expect(args).toContain("--skip-download");
  });

  it("reuses the same player_client profile as the audio download path", () => {
    // If these drift, the metadata path would hit YouTube's bot wall while
    // the download path works — producing a false "no language signal"
    // every time. Lock them to the same profile.
    const args = buildYtdlpMetadataArgs(VIDEO_REFERENCE, mediaConfig);
    const extractorArgValues = args
      .map((a, i) => (a === "--extractor-args" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);

    expect(
      extractorArgValues.some((v) => v.startsWith("youtube:player_client="))
    ).toBe(true);
    expect(extractorArgValues).toContain(
      `youtubepot-bgutilhttp:base_url=${mediaConfig.potProviderUrl}`
    );
  });

  it("sets a browser User-Agent matching the audio-path profile", () => {
    const args = buildYtdlpMetadataArgs(VIDEO_REFERENCE, mediaConfig);
    const uaIdx = args.indexOf("--user-agent");
    expect(uaIdx).toBeGreaterThan(-1);
    expect(args[uaIdx + 1]).toMatch(/Mozilla\//);
  });

  it("puts the URL last (yt-dlp positional arg convention)", () => {
    const args = buildYtdlpMetadataArgs(VIDEO_REFERENCE, mediaConfig);
    expect(args[args.length - 1]).toBe(VIDEO_REFERENCE.url);
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

  it("forwards the metadata timeout and request signal to yt-dlp", async () => {
    const signal = new AbortController().signal;
    mockExecSuccess(JSON.stringify({ id: "abc" }));

    await fetchYtdlpMetadata(VIDEO_REFERENCE, signal);

    expect(mockedExecFile).toHaveBeenCalledWith(
      "yt-dlp",
      expect.any(Array),
      expect.objectContaining({ timeout: 30_000, signal }),
      expect.any(Function),
    );
  });

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
    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);
    expect(result.title).toBe("Test Video");
    expect(result.description).toBe("A test video");
    expect(result.language).toEqual({
      tag: "fr",
      primaryLanguageCode: "fr",
    });
    expect(result.duration).toBe(213);
    expect(result.subtitles).toEqual([
      {
        languageTag: { tag: "fr", primaryLanguageCode: "fr" },
        tracks: [{ url: "x", ext: "vtt" }],
      },
    ]);
    expect(result.automatic_captions).toEqual([
      {
        languageTag: { tag: "en", primaryLanguageCode: "en" },
        tracks: [{ url: "y", ext: "vtt" }],
      },
    ]);
    expect(result.languageTagRejections).toEqual([]);
  });

  it("parses provider language values into canonical full Language Tags", async () => {
    mockExecSuccess(
      JSON.stringify({
        id: "abc",
        language: "zh-hant-tw",
        subtitles: {
          "fra-CA": [{ url: "manual", ext: "vtt" }],
        },
        automatic_captions: {
          "en-US": [{ url: "automatic", ext: "vtt" }],
        },
      }),
    );

    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);

    expect(result.language).toEqual({
      tag: "zh-Hant-TW",
      primaryLanguageCode: "zh",
    });
    expect(result.subtitles).toEqual([
      {
        languageTag: { tag: "fr-CA", primaryLanguageCode: "fr" },
        tracks: [{ url: "manual", ext: "vtt" }],
      },
    ]);
    expect(result.automatic_captions).toEqual([
      {
        languageTag: { tag: "en-US", primaryLanguageCode: "en" },
        tracks: [{ url: "automatic", ext: "vtt" }],
      },
    ]);
    expect(result.languageTagRejections).toEqual([]);
  });

  it("turns rejected provider language values into no signal with bounded classifications", async () => {
    mockExecSuccess(
      JSON.stringify({
        id: "abc",
        language: "auto",
        subtitles: {
          "??": [{ url: "malformed", ext: "vtt" }],
          abc: [{ url: "unsupported", ext: "vtt" }],
          und: [{ url: "sentinel", ext: "vtt" }],
        },
        automatic_captions: {
          "fr-FR": [{ url: "valid", ext: "vtt" }],
        },
      }),
    );

    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);

    expect(result.language).toBeNull();
    expect(result.subtitles).toEqual([]);
    expect(result.automatic_captions).toHaveLength(1);
    expect(result.languageTagRejections).toEqual([
      { source: "uploader-language", reason: "sentinel" },
      { source: "manual-caption-key", reason: "malformed" },
      { source: "manual-caption-key", reason: "unsupported-primary" },
      { source: "manual-caption-key", reason: "sentinel" },
    ]);
    expect(JSON.stringify(result.languageTagRejections)).not.toContain("??");
    expect(JSON.stringify(result.languageTagRejections)).not.toContain("abc");
  });

  it("caps provider rejection details without retaining raw provider keys", async () => {
    const subtitles = Object.fromEntries(
      Array.from({ length: 1_500 }, (_, index) => [
        `invalid-${index}`,
        [{ url: "track", ext: "vtt" }],
      ]),
    );
    mockExecSuccess(JSON.stringify({ id: "abc", subtitles }));

    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);

    expect(result.languageTagRejections).toHaveLength(1_000);
    expect(JSON.stringify(result.languageTagRejections)).not.toContain(
      "invalid-",
    );
  });

  it("normalizes missing fields to safe defaults", async () => {
    // yt-dlp omits `language`, `description`, `subtitles`,
    // `automatic_captions` for videos where those are empty — not returning
    // null. Our downstream consumers expect the fields to exist, so
    // normalize here rather than scattering optional-chaining everywhere.
    mockExecSuccess(JSON.stringify({ title: "Only Title" }));
    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);
    expect(result.title).toBe("Only Title");
    expect(result.description).toBe("");
    expect(result.language).toBeNull();
    expect(result.duration).toBeNull();
    expect(result.subtitles).toEqual([]);
    expect(result.automatic_captions).toEqual([]);
    expect(result.languageTagRejections).toEqual([]);
  });

  it.each([
    ["null", null],
    ["undefined (omitted)", undefined],
    // Numeric string is the realistic regression vector — a future
    // maintainer adding `Number(obj.duration)` "to be helpful" would
    // accept "213" as 213, silently passing the too-long gate when a
    // yt-dlp version drift starts emitting strings.
    ["numeric string", "213"],
    ["non-numeric string", "10:30"],
    // Booleans and objects are the well-meaning-coercion footguns —
    // `Number(true)` is 1, `Number({})` is NaN. The strict typeof
    // check rejects both before any arithmetic touches them.
    ["boolean true", true],
    ["boolean false", false],
    ["object", { seconds: 213 }],
    ["array", [213]],
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
      const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);
      expect(result.duration).toBeNull();
    }
  );

  it("preserves duration=0 (a valid edge — zero-second clips exist)", async () => {
    mockExecSuccess(JSON.stringify({ id: "abc", duration: 0 }));
    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);
    expect(result.duration).toBe(0);
  });

  it("throws when yt-dlp exits non-zero", async () => {
    // Propagating the error lets the route return 500 instead of silently
    // falling back to whisper without language hint. If this swallowed the
    // error, a persistent yt-dlp issue would be invisible except as a
    // rising cost-per-request.
    mockExecFailure(new Error("yt-dlp exit 1"), "ERROR: unavailable");
    const error = await fetchYtdlpMetadata(VIDEO_REFERENCE).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(YtdlpAcquisitionError);
    expect(error).toMatchObject({
      message: "yt-dlp metadata acquisition failed",
    });
    expect(String(error)).not.toContain("ERROR: unavailable");
  });

  it("throws when stdout isn't valid JSON", async () => {
    // Silent JSON-parse fallback would produce a metadata object with all
    // defaults, matching the "no signal" case — hiding a real extraction
    // failure. Throw so the route can log + return 500.
    mockExecSuccess("not json at all");
    await expect(fetchYtdlpMetadata(VIDEO_REFERENCE)).rejects.toBeInstanceOf(
      YtdlpAcquisitionError,
    );
  });

  it("throws when stdout parses but has no anchor fields (schema regression guard)", async () => {
    // A `{}` response looks like a successful empty video — no id, no
    // title, no URL. Collapsing it to all-defaults would let the route
    // return 200 and the orchestrator would pin an arbitrary language
    // to whisper. Catch the regression here at the boundary.
    mockExecSuccess(JSON.stringify({}));
    await expect(fetchYtdlpMetadata(VIDEO_REFERENCE)).rejects.toBeInstanceOf(
      YtdlpAcquisitionError,
    );
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "not an object"],
  ])("classifies %s stdout payload as acquisition failure", async (_label, payload) => {
    mockExecSuccess(JSON.stringify(payload));
    await expect(fetchYtdlpMetadata(VIDEO_REFERENCE)).rejects.toBeInstanceOf(
      YtdlpAcquisitionError,
    );
  });

  it("does not classify request cancellation as provider acquisition failure", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request stopped", "AbortError");
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads don't narrow cleanly in mock
      (_cmd, _args, _opts, cb) => {
        controller.abort(reason);
        cb?.(new Error("child process aborted"), "", "");
      },
    );

    await expect(
      fetchYtdlpMetadata(VIDEO_REFERENCE, controller.signal),
    ).rejects.toBe(reason);
  });

  it("accepts a payload with `id` only (yt-dlp minimum)", async () => {
    // Some uploads have no description, no uploader, no language — but
    // every real video has an `id`. Don't over-tighten the guard.
    mockExecSuccess(JSON.stringify({ id: "abc123" }));
    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);
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
    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);
    expect(result.description.length).toBe(2000);
  });

  it("normalizes caption dictionaries without trusting malformed provider entries", async () => {
    mockExecSuccess(
      JSON.stringify({
        id: "abc",
        subtitles: {
          en: [
            { url: "manual", ext: "vtt" },
            null,
            "not a track",
            { url: 42, ext: null },
            ["not", "a", "track"],
          ],
          ["__proto__"]: [{ url: "safe", ext: "vtt" }],
          ignored: "not a track list",
          empty: [],
        },
        automatic_captions: [],
      }),
    );

    const result = await fetchYtdlpMetadata(VIDEO_REFERENCE);

    expect(result.subtitles).toEqual([
      {
        languageTag: { tag: "en", primaryLanguageCode: "en" },
        tracks: [
          { url: "manual", ext: "vtt" },
          { url: "", ext: "" },
        ],
      },
    ]);
    expect(result.automatic_captions).toEqual([]);
    expect(result.languageTagRejections).toEqual([
      { source: "manual-caption-key", reason: "malformed" },
    ]);
  });
});
