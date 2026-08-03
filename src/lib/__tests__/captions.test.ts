import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCaptionTrackAcquisition,
  type CaptionTrackAcquisitionRequest,
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

type ProviderSuccess = Extract<
  CaptionTrackProviderResult,
  { readonly kind: "success" }
>;

const success = (
  overrides: Partial<ProviderSuccess> = {},
): ProviderSuccess => ({
  kind: "success",
  segments: [{ text: "hello", start: 0, duration: 1 }],
  languageTag: "en",
  title: "Example",
  channelName: "Channel",
  ...overrides,
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
        languageTag: "zh-Hans",
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
      videoId: VIDEO_REFERENCE.videoId,
      language: "zh",
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
      videoId: VIDEO_REFERENCE.videoId,
      signal: request.signal,
    });
    expect(provider.mock.calls[0]?.[0]).not.toHaveProperty("language");
  });

  it.each([
    ["disabled", { kind: "absent", reason: "disabled" }],
    ["missing", { kind: "absent", reason: "missing" }],
    [
      "language mismatch",
      {
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["en", "fr"],
      },
    ],
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

  it("retries a bare primary language with the first matching provider track", async () => {
    provider
      .mockResolvedValueOnce({
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["und", "zh-Hant-TW", "zh-Hans"],
      })
      .mockResolvedValueOnce(
        success({ languageTag: "zh-Hant-TW" }),
      );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = makeRequest("zh");

    await expect(createCaptionTrackAcquisition(provider)(request)).resolves.toMatchObject(
      { kind: "acquired", promptLocale: "zh" },
    );
    expect(provider).toHaveBeenNthCalledWith(1, {
      videoId: VIDEO_REFERENCE.videoId,
      language: "zh",
      signal: request.signal,
    });
    expect(provider).toHaveBeenNthCalledWith(2, {
      videoId: VIDEO_REFERENCE.videoId,
      language: "zh-Hant-TW",
      signal: request.signal,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[captions.CAPTION_LANG_RETRY_PRIMARY_SUBTAG]",
      expect.objectContaining({
        errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        requested: "zh",
        matched: "zh-Hant-TW",
        availableCount: 3,
      }),
    );
  });

  it("matches a canonical exact identity while retrying with the provider raw token", async () => {
    provider
      .mockResolvedValueOnce({
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["und", "abc", "fra-CA", "fr-FR"],
      })
      .mockResolvedValueOnce(success({ languageTag: "fra-CA" }));
    const request = makeRequest("fr-CA");

    await createCaptionTrackAcquisition(provider)(request);

    expect(provider.mock.calls[1]?.[0]).toMatchObject({
      language: "fra-CA",
    });
  });

  it("does not downgrade a specific language tag or retry without a matching track", async () => {
    provider.mockResolvedValue({
      kind: "absent",
      reason: "language-mismatch",
      availableLanguages: ["fr-FR", "fr"],
    });

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("fr-CA")),
    ).resolves.toEqual({ kind: "absent", reason: "language-mismatch" });
    expect(provider).toHaveBeenCalledOnce();
  });

  it("does not retry a second language mismatch", async () => {
    provider
      .mockResolvedValueOnce({
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["zh-Hans"],
      })
      .mockResolvedValueOnce({
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["zh-Hant"],
      });

    await expect(
      createCaptionTrackAcquisition(provider)(makeRequest("zh")),
    ).resolves.toEqual({ kind: "absent", reason: "language-mismatch" });
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

  it("propagates an abort reason observed after the retry begins", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    provider
      .mockResolvedValueOnce({
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["zh-Hans"],
      })
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw new Error("provider failure after abort");
      });

    await expect(
      createCaptionTrackAcquisition(provider)(
        makeRequest("zh", controller.signal),
      ),
    ).rejects.toBe(reason);
    expect(infoSpy).toHaveBeenCalledWith(
      "[captions.cancelled]",
      expect.objectContaining({
        requestId: "request-123",
        videoId: "dQw4w9WgXcQ",
        outcome: "cancelled",
        classification: "caller-aborted",
      }),
    );
  });

  it("chooses English Prompt Locale and diagnoses unsupported returned language", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockResolvedValue(
      success({
        languageTag: "fr",
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
});
