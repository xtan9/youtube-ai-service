import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCaptionTrackAcquisition,
  type CaptionTrackAcquisitionRequest,
  type CaptionTrackProviderCandidate,
  type CaptionTrackProvider,
  type CaptionTrackProviderResult,
} from "../captions.js";
import { parseLanguageTag } from "../language-tag.js";
import { parseYouTubeVideoReference } from "../youtube-url.js";

const VIDEO_REFERENCE = (() => {
  const reference = parseYouTubeVideoReference(
    "https://youtu.be/dQw4w9WgXcQ",
  );
  if (!reference) throw new Error("test fixture must be a YouTube URL");
  return reference;
})();

const languageTag = (input: string) => {
  const result = parseLanguageTag(input);
  if (!result.ok) throw new Error(`Expected a Language Tag: ${input}`);
  return result.languageTag;
};

const identifiedTrackLanguage = (input: string) => ({
  kind: "identified" as const,
  languageTag: languageTag(input),
});

type ProviderSuccess = Extract<
  CaptionTrackProviderResult,
  { readonly kind: "success" }
>;

const success = (
  overrides: Partial<ProviderSuccess> = {},
): ProviderSuccess => ({
  kind: "success",
  segments: [{ text: "hello", start: 0, duration: 1 }],
  trackLanguage: identifiedTrackLanguage("en"),
  title: "Example",
  channelName: "Channel",
  ...overrides,
});

const candidate = (language: string): CaptionTrackProviderCandidate => ({
  languageTag: languageTag(language),
});

const languageMismatch = (
  availableTracks: readonly CaptionTrackProviderCandidate[],
  availableCount = availableTracks.length,
): CaptionTrackProviderResult => ({
  kind: "absent",
  reason: "language-mismatch",
  availableTracks,
  availableCount,
});

function makeRequest(
  language: string | undefined = undefined,
  signal = new AbortController().signal,
): CaptionTrackAcquisitionRequest {
  return Object.freeze({
    videoReference: VIDEO_REFERENCE,
    requestedLanguage:
      language === undefined ? undefined : languageTag(language),
    requestId: "request-123",
    signal,
  });
}

describe("Caption Track acquisition", () => {
  const provider = vi.fn<CaptionTrackProvider>();

  beforeEach(() => {
    vi.restoreAllMocks();
    provider.mockReset();
  });

  it("acquires timed text, metadata, source, and Prompt Locale through one request", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    provider.mockResolvedValue(
      success({
        segments: [
          { text: "Hello &amp; world", start: 1, duration: 2 },
          { text: "next", start: 3, duration: 1.5 },
        ],
        trackLanguage: identifiedTrackLanguage("zh-Hans"),
        title: null,
        channelName: null,
      }),
    );
    const request = makeRequest("zh");

    await expect(createCaptionTrackAcquisition(provider)(request)).resolves.toEqual(
      {
        kind: "acquired",
        segments: [
          { text: "Hello & world", start: 1, duration: 2 },
          { text: "next", start: 3, duration: 1.5 },
        ],
        source: "auto_captions",
        promptLocale: "zh",
        title: null,
        channelName: null,
      },
    );
    expect(provider).toHaveBeenCalledWith({
      kind: "initial",
      videoId: VIDEO_REFERENCE.videoId,
      requestedLanguage: languageTag("zh"),
      signal: request.signal,
    });
    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.acquired]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        outcome: "acquired",
        source: "auto_captions",
        language: "zh",
        segmentCount: 2,
      }),
    );
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("omits the provider language filter when no language was requested", async () => {
    provider.mockResolvedValue(success());
    const request = makeRequest();

    await createCaptionTrackAcquisition(provider)(request);

    expect(provider).toHaveBeenCalledWith({
      kind: "initial",
      videoId: VIDEO_REFERENCE.videoId,
      signal: request.signal,
    });
    expect(provider.mock.calls[0]?.[0]).not.toHaveProperty(
      "requestedLanguage",
    );
  });

  it.each([
    ["disabled", { kind: "absent", reason: "disabled" }],
    ["missing", { kind: "absent", reason: "missing" }],
  ] as const)("classifies provider %s as Caption Track Absent", async (_name, result) => {
    provider.mockResolvedValue(result);

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("zh")),
    ).resolves.toMatchObject({ kind: "absent", reason: result.reason });
  });

  it("diagnoses Caption Track Absent with safe stable fields", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    provider.mockResolvedValue({ kind: "absent", reason: "disabled" });

    await createCaptionTrackAcquisition(provider)(makeRequest());

    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.absent]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        outcome: "absent",
        classification: "disabled",
      }),
    );
  });

  it("classifies an empty provider result as absent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockResolvedValue(success({ segments: [] }));

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest()),
    ).resolves.toEqual({ kind: "absent", reason: "empty-provider-result" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions.empty_provider_result]",
      expect.objectContaining({
        errorId: "CAPTION_EMPTY_PROVIDER_RESULT",
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        segmentCount: 0,
      }),
    );
  });

  it("classifies a track filtered to empty after entity decoding and whitespace checks", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockResolvedValue(
      success({
        segments: [
          { text: "   ", start: 0, duration: 1 },
          { text: "&amp;#160;", start: 1, duration: 1 },
        ],
      }),
    );

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest()),
    ).resolves.toEqual({ kind: "absent", reason: "filtered-empty" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions.filtered_empty]",
      expect.objectContaining({
        errorId: "CAPTION_SEGMENTS_FILTERED_EMPTY",
        segmentCount: 2,
      }),
    );
  });

  it.each([
    "provider-video-unavailable",
    "invalid-video-reference",
  ] as const)("keeps %s distinct from Caption Track Absent", async (reason) => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    provider.mockResolvedValue({ kind: "unavailable", reason });

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest()),
    ).resolves.toEqual({ kind: "video-unavailable", reason });
    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.video_unavailable]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        outcome: "video-unavailable",
        classification: reason,
      }),
    );
  });

  it("retries a bare primary language with the first same-primary provider candidate", async () => {
    const first = candidate("zh-Hant-TW");
    const second = candidate("zh-Hans");
    provider
      .mockResolvedValueOnce(languageMismatch([first, second], 3))
      .mockResolvedValueOnce(
        success({ trackLanguage: identifiedTrackLanguage("zh-Hant-TW") }),
      );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("zh")),
    ).resolves.toMatchObject({ kind: "acquired", promptLocale: "zh" });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenNthCalledWith(2, {
      kind: "retry",
      videoId: VIDEO_REFERENCE.videoId,
      candidate: first,
      signal: expect.any(AbortSignal),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions.CAPTION_LANG_RETRY_PRIMARY_SUBTAG]",
      expect.objectContaining({
        requested: "zh",
        matched: "zh-Hant-TW",
        availableCount: 3,
      }),
    );
  });

  it("prefers canonical exact identity over an earlier same-primary candidate", async () => {
    const sibling = candidate("fr-FR");
    const exact = candidate("fr-CA");
    provider
      .mockResolvedValueOnce(languageMismatch([sibling, exact]))
      .mockResolvedValueOnce(
        success({ trackLanguage: identifiedTrackLanguage("fr-CA") }),
      );

    await createCaptionTrackAcquisition(provider)(makeRequest("fr-CA"));

    expect(provider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "retry", candidate: exact }),
    );
  });

  it("does not downgrade a specific request to a sibling or bare candidate", async () => {
    const sibling = candidate("fr-FR");
    const bare = candidate("fr");
    provider.mockResolvedValue(languageMismatch([sibling, bare]));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("fr-CA")),
    ).resolves.toEqual({ kind: "absent", reason: "language-mismatch" });
    expect(provider).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.language_mismatch]",
      expect.objectContaining({
        lang: "fr-CA",
        availableCount: 2,
      }),
    );
  });

  it("bounds language selection to one retry", async () => {
    const secondCandidate = candidate("zh-Hant");
    const first = candidate("zh-Hans");
    provider
      .mockResolvedValueOnce(languageMismatch([first]))
      .mockResolvedValueOnce(languageMismatch([secondCandidate]));

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("zh")),
    ).resolves.toEqual({ kind: "absent", reason: "language-mismatch" });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "retry", candidate: first }),
    );
  });

  it("propagates an unexpected provider defect from strict retry", async () => {
    const defect = new TypeError("retry network failed");
    provider
      .mockResolvedValueOnce(languageMismatch([candidate("zh-Hans")]))
      .mockRejectedValueOnce(defect);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("zh")),
    ).rejects.toBe(defect);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("propagates unexpected provider defects and logs only safe classifications", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const defect = new TypeError(
      "provider body https://provider.example/private?token=secret",
    );
    provider.mockRejectedValue(defect);

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest()),
    ).rejects.toBe(defect);
    expect(errorSpy).toHaveBeenCalledWith(
      "[captions.CAPTION_UNEXPECTED_FAILURE]",
      expect.objectContaining({
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        errorClass: "TypeError",
        outcome: "unexpected",
      }),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("provider body");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("provider.example");
  });

  it("propagates an abort reason before provider classification", async () => {
    const controller = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    provider.mockImplementation(async () => {
      controller.abort(reason);
      return { kind: "absent", reason: "missing" };
    });

    await expect(
      createCaptionTrackAcquisition(provider)(
        makeRequest(undefined, controller.signal),
      ),
    ).rejects.toBe(reason);
    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.cancelled]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        outcome: "cancelled",
        classification: "deadline",
      }),
    );
  });

  it("propagates an abort reason observed during strict retry", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    provider
      .mockResolvedValueOnce(languageMismatch([candidate("zh-Hans")]))
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw new Error("provider failure after abort");
      });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      createCaptionTrackAcquisition(provider)(
        makeRequest("zh", controller.signal),
      ),
    ).rejects.toBe(reason);
    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.cancelled]",
      expect.objectContaining({ classification: "caller-aborted" }),
    );
  });

  it("chooses English Prompt Locale and diagnoses unsupported returned language", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockResolvedValue(
      success({
        trackLanguage: identifiedTrackLanguage("fr"),
        segments: [
          {
            text: "A&amp;B &amp;#39; &#xD800; &#999999999999;",
            start: 0,
            duration: 1,
          },
        ],
      }),
    );

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("en")),
    ).resolves.toMatchObject({
      kind: "acquired",
      promptLocale: "en",
      segments: [
        {
          text: "A&B ' &#xD800; &#999999999999;",
          start: 0,
          duration: 1,
        },
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions.unknown_locale]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        lang: "fr",
      }),
    );
  });

  it("preserves warned English Prompt Locale fallback for an unidentified track", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockResolvedValue(
      success({
        trackLanguage: { kind: "unidentified", reason: "sentinel" },
      }),
    );

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest()),
    ).resolves.toMatchObject({ kind: "acquired", promptLocale: "en" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions.unknown_locale]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        reason: "sentinel",
      }),
    );
  });
});
