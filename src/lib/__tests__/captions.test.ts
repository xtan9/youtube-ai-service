import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractVideoId,
  fetchCaptions,
  isExpectedNoCaptions,
  pickLocale,
} from "../captions.js";
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  type TranscriptSegment,
} from "youtube-transcript-plus";

// ESM module spying requires vi.mock at module scope — vi.spyOn on an
// imported namespace fails with "Module namespace is not configurable".
vi.mock("youtube-transcript-plus", async () => {
  const actual =
    await vi.importActual<typeof import("youtube-transcript-plus")>(
      "youtube-transcript-plus"
    );
  return { ...actual, fetchTranscript: vi.fn() };
});

const mockedFetchTranscript = vi.mocked(fetchTranscript);

describe("extractVideoId", () => {
  // Spec is "URL forms the endpoint accepts" — adding to this table is
  // the contract extension point. Removals are breaking changes.
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=2",
      "dQw4w9WgXcQ",
    ],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("extracts from %s", (url, expected) => {
    expect(extractVideoId(url)).toBe(expected);
  });

  it.each([
    "https://example.com/not-youtube",
    "https://www.youtube.com/",
    "not-a-url-at-all",
    "",
  ])("returns null for %s", (url) => {
    expect(extractVideoId(url)).toBeNull();
  });

  it("rejects bare video IDs that lack URL structure", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBeNull();
  });

  it("rejects URLs whose ID segment is too short to be a valid YouTube ID", () => {
    // IDs under 11 chars can't match the {11} quantifier, so they're
    // rejected outright. Overlong IDs (12+) have defensible
    // "take-the-prefix" behavior — we don't test for that since the
    // YouTube API would 404 on an invalid prefix anyway.
    expect(extractVideoId("https://youtu.be/dQw4w9WgXc")).toBeNull();
  });
});

describe("isExpectedNoCaptions", () => {
  it("classifies library-defined no-captions errors as expected", () => {
    expect(
      isExpectedNoCaptions(new YoutubeTranscriptDisabledError("x"))
    ).toBe(true);
    expect(
      isExpectedNoCaptions(new YoutubeTranscriptNotAvailableError("x"))
    ).toBe(true);
  });

  it("treats arbitrary errors as unexpected (alertable)", () => {
    // The distinction matters: expected errors → 404 → Whisper fallback,
    // unexpected errors → 500 → alert. A misclassification here
    // silently bills GPU for every library regression.
    expect(isExpectedNoCaptions(new Error("network timeout"))).toBe(false);
    expect(isExpectedNoCaptions(new TypeError("x"))).toBe(false);
    expect(isExpectedNoCaptions("string-error")).toBe(false);
    expect(isExpectedNoCaptions(null)).toBe(false);
  });
});

describe("pickLocale", () => {
  const seg = (lang: string | undefined): TranscriptSegment =>
    ({ text: "hi", lang } as unknown as TranscriptSegment);

  it.each([
    ["zh", "zh"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh"],
    ["zh-Hans", "zh"],
    ["ZH-cn", "zh"], // case-insensitive
    ["en", "en"],
    ["en-US", "en"],
    ["en-gb", "en"],
  ])("maps lang=%s → %s", (lang, expected) => {
    expect(pickLocale([seg(lang)])).toBe(expected);
  });

  it.each([
    ["fr", "en"], // unknown language — fall back to en prompt template
    ["ja", "en"],
    ["", "en"],
  ])("falls back to en for unsupported lang=%s", (lang, expected) => {
    expect(pickLocale([seg(lang)])).toBe(expected);
  });

  it("falls back to en when segments[0] has no lang at all", () => {
    expect(pickLocale([seg(undefined)])).toBe("en");
  });

  it("falls back to en when segments array is empty", () => {
    expect(pickLocale([])).toBe("en");
  });
});

describe("fetchCaptions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // The library types fetchTranscript as returning TranscriptSegment[],
  // but with `videoDetails: true` it actually returns a richer object that
  // production code casts. Match that runtime shape but cast to the
  // declared type so the mock satisfies TS.
  //
  // Each fixture segment ships with `offset` and `duration` because those
  // flow into the response now — text-only fixtures would land in the
  // assertion as start/duration=undefined and silently pass a NaN check.
  const ok = (segments: Partial<TranscriptSegment>[]) =>
    ({
      segments: segments.map((s, i) => ({
        offset: i,
        duration: 1,
        ...s,
      })),
      videoDetails: { title: "t", author: "a" },
    } as unknown as TranscriptSegment[]);

  it("returns null when the URL has no extractable video ID", async () => {
    // Short-circuits before hitting the library — protects against
    // spamming YouTube with bare-ID or invalid-URL requests.
    expect(await fetchCaptions("not-a-url")).toBeNull();
    expect(mockedFetchTranscript).not.toHaveBeenCalled();
  });

  it("returns null on expected no-captions errors (quiet, logs nothing)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedFetchTranscript.mockRejectedValue(
      new YoutubeTranscriptDisabledError("x")
    );
    const result = await fetchCaptions("https://youtu.be/dQw4w9WgXcQ");
    expect(result).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("throws (not returns null) on unexpected library errors", async () => {
    // The whole point of this PR: unexpected errors must NOT return null,
    // because the route reads null as "404 no captions → fall back to
    // Whisper", which would silently bill GPU on every library/network
    // regression. Throw so the route can return 500 and fire an alert.
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockedFetchTranscript.mockRejectedValue(
      new TypeError("schema drift")
    );
    await expect(
      fetchCaptions("https://youtu.be/dQw4w9WgXcQ")
    ).rejects.toThrow("schema drift");
  });

  it("logs unexpected errors with the stable CAPTION_UNEXPECTED_FAILURE id before throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedFetchTranscript.mockRejectedValue(
      new TypeError("schema drift")
    );
    await expect(
      fetchCaptions("https://youtu.be/dQw4w9WgXcQ")
    ).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "[captions] CAPTION_UNEXPECTED_FAILURE",
      expect.objectContaining({
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        videoId: "dQw4w9WgXcQ",
      })
    );
  });

  it("returns null AND logs CAPTION_EMPTY_SEGMENTS when the library reports zero segments", async () => {
    // The log is the tripwire for YouTube schema drift: if a rate of
    // these spikes, we start paying for Whisper on videos that still
    // have captions. Pin the errorId so a future refactor can't drop it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedFetchTranscript.mockResolvedValue(ok([]));
    expect(await fetchCaptions("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty segments"),
      expect.objectContaining({
        errorId: "CAPTION_EMPTY_SEGMENTS",
        videoId: "dQw4w9WgXcQ",
      })
    );
  });

  it("returns null AND logs CAPTION_EMPTY_TRANSCRIPT when segments join to whitespace", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedFetchTranscript.mockResolvedValue(
      ok([{ text: "   ", lang: "en" }, { text: "\n", lang: "en" }])
    );
    expect(await fetchCaptions("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("whitespace-only"),
      expect.objectContaining({
        errorId: "CAPTION_EMPTY_TRANSCRIPT",
        videoId: "dQw4w9WgXcQ",
      })
    );
  });

  it("preserves segment text verbatim and pairs each with its timing data", async () => {
    // Segments are now the source of truth. The frontend renders them
    // chunked into paragraphs at display time, so the lib must hand them
    // through unmodified — a refactor that re-introduced whitespace
    // collapse here would silently corrupt the text the LLM sees.
    mockedFetchTranscript.mockResolvedValue(
      ok([
        { text: "  hello\tworld  ", lang: "en", offset: 0, duration: 2 },
        { text: "foo", lang: "en", offset: 2, duration: 1.5 },
      ])
    );
    const result = await fetchCaptions("https://youtu.be/dQw4w9WgXcQ");
    expect(result?.segments).toEqual([
      { text: "  hello\tworld  ", start: 0, duration: 2 },
      { text: "foo", start: 2, duration: 1.5 },
    ]);
  });

  it("returns null metadata fields when videoDetails is undefined (not empty string)", async () => {
    // Forces consumers to handle the "no metadata" case explicitly
    // rather than seeing a plausibly-valid empty string.
    mockedFetchTranscript.mockResolvedValue({
      segments: [{ text: "hello", lang: "en" }],
      videoDetails: undefined,
    } as unknown as TranscriptSegment[]);
    const result = await fetchCaptions("https://youtu.be/dQw4w9WgXcQ");
    expect(result?.title).toBeNull();
    expect(result?.channelName).toBeNull();
  });

  it("maps the full happy path to a CaptionResult", async () => {
    mockedFetchTranscript.mockResolvedValue(
      ok([
        { text: "hello", lang: "zh-CN", offset: 0, duration: 1 },
        { text: "world", lang: "zh-CN", offset: 1, duration: 2 },
      ])
    );
    const result = await fetchCaptions("https://youtu.be/dQw4w9WgXcQ");
    expect(result).toEqual({
      segments: [
        { text: "hello", start: 0, duration: 1 },
        { text: "world", start: 1, duration: 2 },
      ],
      source: "auto_captions",
      language: "zh",
      title: "t",
      channelName: "a",
    });
  });

  it("omits `lang` in the library call when the caller didn't provide one (back-compat)", async () => {
    // Without this guard a future refactor could pass `{ lang: undefined }`,
    // which the library treats as a real filter and rejects with
    // NotAvailableLanguage — breaking the current "first track wins" flow
    // that existing callers depend on.
    mockedFetchTranscript.mockResolvedValue(ok([{ text: "hi", lang: "en" }]));
    await fetchCaptions("https://youtu.be/dQw4w9WgXcQ");
    const call = mockedFetchTranscript.mock.calls[0];
    expect(call[1]).toEqual({ videoDetails: true });
    expect(call[1]).not.toHaveProperty("lang");
  });

  it("calls pickLocale with the RAW library segments, not the mapped {start,duration,text} ones", async () => {
    // Subtle invariant: `pickLocale` reads `segments[0].lang` to pick the
    // prompt template. Our mapped `TranscriptSegment` shape doesn't carry
    // a `lang` field — only the raw library segments do. A "tidy this up"
    // refactor that swapped `pickLocale(ytSegments, ...)` to
    // `pickLocale(segments, ...)` would silently route every Chinese
    // video to the English prompt. Pin the contract via a happy-path
    // assertion that depends on lang resolution working through.
    mockedFetchTranscript.mockResolvedValue(
      ok([{ text: "你好", lang: "zh-CN", offset: 0, duration: 1 }])
    );
    const result = await fetchCaptions("https://youtu.be/dQw4w9WgXcQ");
    // language === "zh" can ONLY come from the raw `lang: "zh-CN"` field —
    // mapped segments lack `lang` so pickLocale would default to "en".
    expect(result?.language).toBe("zh");
    // And the mapped segment carries no `lang` field — proves the two
    // arrays are distinct.
    expect(result?.segments[0]).not.toHaveProperty("lang");
  });

  it("forwards `lang` to the library when provided (pins caption track)", async () => {
    // The whole point of this parameter: without it, the library picks
    // `tracks[0]` which for some videos is the wrong language entirely.
    mockedFetchTranscript.mockResolvedValue(ok([{ text: "bonjour", lang: "fr" }]));
    await fetchCaptions("https://youtu.be/dQw4w9WgXcQ", "fr");
    const call = mockedFetchTranscript.mock.calls[0];
    expect(call[1]).toEqual({ videoDetails: true, lang: "fr" });
  });
});
