import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createYoutubeTranscriptCaptionTrackProvider,
  type CaptionTrackProviderRequest,
} from "../caption-provider.js";
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResult,
} from "youtube-transcript-plus";
import { parseLanguageTag } from "../language-tag.js";

vi.mock("youtube-transcript-plus", async () => {
  const actual =
    await vi.importActual<typeof import("youtube-transcript-plus")>(
      "youtube-transcript-plus",
    );
  return { ...actual, fetchTranscript: vi.fn() };
});

const mockedFetchTranscript = vi.mocked(fetchTranscript);

function request(
  language: string | undefined = undefined,
  signal = new AbortController().signal,
): CaptionTrackProviderRequest {
  const parsedLanguage = parseLanguageTag(language);
  return {
    kind: "initial",
    videoId: "dQw4w9WgXcQ",
    ...(parsedLanguage.ok
      ? { requestedLanguage: parsedLanguage.languageTag }
      : {}),
    signal,
  };
}

function providerResult(overrides: Record<string, unknown> = {}) {
  return {
    segments: [
      { text: "hello", lang: "en", offset: 2, duration: 1.5 },
    ],
    videoDetails: { title: "Example", author: "Channel" },
    ...overrides,
  } as unknown as TranscriptResult;
}

describe("youtube-transcript-plus Caption Track adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedFetchTranscript.mockReset();
  });

  it("forwards an explicit language and request work signal", async () => {
    mockedFetchTranscript.mockResolvedValue(providerResult() as never);
    const signal = new AbortController().signal;
    const provider = createYoutubeTranscriptCaptionTrackProvider();

    await expect(provider(request("zh", signal))).resolves.toEqual({
      kind: "success",
      segments: [{ text: "hello", start: 2, duration: 1.5 }],
      trackLanguage: {
        kind: "identified",
        languageTag: {
          tag: "en",
          primaryLanguageCode: "en",
        },
      },
      title: "Example",
      channelName: "Channel",
    });
    expect(mockedFetchTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ", {
      videoDetails: true,
      lang: "zh",
      signal,
    });
  });

  it("omits the language option when it was not requested", async () => {
    mockedFetchTranscript.mockResolvedValue(providerResult() as never);
    const signal = new AbortController().signal;
    const provider = createYoutubeTranscriptCaptionTrackProvider();

    await provider(request(undefined, signal));

    expect(mockedFetchTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ", {
      videoDetails: true,
      signal,
    });
  });

  it("normalizes missing video details to nullable metadata", async () => {
    mockedFetchTranscript.mockResolvedValue(
      providerResult({ videoDetails: undefined }) as never,
    );

    await expect(
      createYoutubeTranscriptCaptionTrackProvider()(request()),
    ).resolves.toMatchObject({ title: null, channelName: null });
  });

  it("parses opaque candidates while retaining raw tokens inside the adapter", async () => {
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "zh",
          ["und", "zh-Hant-TW", "zh-Hans"],
          "dQw4w9WgXcQ",
        ),
      )
      .mockResolvedValueOnce(
        providerResult({
          segments: [
            { text: "你好", lang: "zh-Hant-TW", offset: 2, duration: 1.5 },
          ],
        }) as never,
      );
    const signal = new AbortController().signal;

    const provider = createYoutubeTranscriptCaptionTrackProvider();
    const result = await provider(request("zh", signal));

    expect(result).toMatchObject({
      kind: "absent",
      reason: "language-mismatch",
      availableCount: 3,
      availableTracks: [
        { languageTag: { tag: "zh-Hant-TW", primaryLanguageCode: "zh" } },
        { languageTag: { tag: "zh-Hans", primaryLanguageCode: "zh" } },
      ],
    });
    expect(result).not.toHaveProperty("availableLanguages");
    if (result.kind !== "absent" || result.reason !== "language-mismatch") {
      throw new Error("expected language mismatch candidates");
    }
    const selected = result.availableTracks[0];
    if (!selected) throw new Error("expected a provider candidate");
    expect(Object.keys(selected)).toEqual(["languageTag"]);
    expect(selected).not.toHaveProperty("retry");
    expect(selected).not.toHaveProperty("rawToken");
    await expect(
      provider({
        kind: "retry",
        videoId: "dQw4w9WgXcQ",
        candidate: selected,
        signal,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    expect(mockedFetchTranscript).toHaveBeenNthCalledWith(2, "dQw4w9WgXcQ", {
      videoDetails: true,
      lang: "zh-Hant-TW",
      signal,
    });
  });

  it("matches canonical exact identity while preserving the raw provider retry token", async () => {
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "fr-CA",
          ["und", "abc", "fra-CA", "fr-FR"],
          "dQw4w9WgXcQ",
        ),
      )
      .mockResolvedValueOnce(
        providerResult({
          segments: [
            { text: "bonjour", lang: "fra-CA", offset: 2, duration: 1.5 },
          ],
        }) as never,
      );

    const provider = createYoutubeTranscriptCaptionTrackProvider();
    const initialRequest = request("fr-CA");
    const result = await provider(initialRequest);
    expect(result).toMatchObject({
      kind: "absent",
      reason: "language-mismatch",
      availableTracks: [
        { languageTag: { tag: "fr-CA", primaryLanguageCode: "fr" } },
        { languageTag: { tag: "fr-FR", primaryLanguageCode: "fr" } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("fra-CA");
    if (result.kind !== "absent" || result.reason !== "language-mismatch") {
      throw new Error("expected language mismatch candidates");
    }
    const selected = result.availableTracks[0];
    if (!selected) throw new Error("expected a provider candidate");
    await expect(
      provider({
        kind: "retry",
        videoId: "dQw4w9WgXcQ",
        candidate: selected,
        signal: initialRequest.signal,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      trackLanguage: {
        kind: "identified",
        languageTag: { tag: "fr-CA", primaryLanguageCode: "fr" },
      },
    });
    expect(mockedFetchTranscript.mock.calls[1]?.[1]).toMatchObject({
      lang: "fra-CA",
    });
  });

  it("classifies an unusable returned track tag without exposing its raw spelling", async () => {
    mockedFetchTranscript.mockResolvedValue(
      providerResult({
        segments: [
          { text: "hello", lang: " und ", offset: 2, duration: 1.5 },
        ],
      }) as never,
    );

    await expect(
      createYoutubeTranscriptCaptionTrackProvider()(request()),
    ).resolves.toMatchObject({
      kind: "success",
      trackLanguage: { kind: "unidentified", reason: "malformed" },
    });
  });

  it("propagates cancellation unchanged when observed during strict retry", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    mockedFetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError(
          "zh",
          ["zh-Hans"],
          "dQw4w9WgXcQ",
        ),
      )
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw new Error("provider failure after abort");
      });

    const provider = createYoutubeTranscriptCaptionTrackProvider();
    const result = await provider(request("zh", controller.signal));
    if (result.kind !== "absent" || result.reason !== "language-mismatch") {
      throw new Error("expected language mismatch candidates");
    }
    const selected = result.availableTracks[0];
    if (!selected) throw new Error("expected a provider candidate");
    await expect(
      provider({
        kind: "retry",
        videoId: "dQw4w9WgXcQ",
        candidate: selected,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("rejects retry candidates that were not issued by the adapter instance", async () => {
    mockedFetchTranscript.mockRejectedValueOnce(
      new YoutubeTranscriptNotAvailableLanguageError(
        "zh",
        ["zh-Hans"],
        "dQw4w9WgXcQ",
      ),
    );
    const issuingProvider = createYoutubeTranscriptCaptionTrackProvider();
    const result = await issuingProvider(request("zh"));
    if (result.kind !== "absent" || result.reason !== "language-mismatch") {
      throw new Error("expected language mismatch candidates");
    }
    const selected = result.availableTracks[0];
    if (!selected) throw new Error("expected a provider candidate");

    await expect(
      createYoutubeTranscriptCaptionTrackProvider()({
        kind: "retry",
        videoId: "dQw4w9WgXcQ",
        candidate: selected,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "CaptionProviderSchemaError" });
    expect(mockedFetchTranscript).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled", new YoutubeTranscriptDisabledError("dQw4w9WgXcQ"), { kind: "absent", reason: "disabled" }],
    ["missing", new YoutubeTranscriptNotAvailableError("dQw4w9WgXcQ"), { kind: "absent", reason: "missing" }],
  ] as const)("translates expected %s provider errors", async (_name, error, expected) => {
    mockedFetchTranscript.mockRejectedValue(error);

    await expect(
      createYoutubeTranscriptCaptionTrackProvider()(request("zh")),
    ).resolves.toEqual(expected);
  });

  it.each([
    [
      new YoutubeTranscriptVideoUnavailableError("dQw4w9WgXcQ"),
      { kind: "unavailable", reason: "provider-video-unavailable" },
    ],
    [
      new YoutubeTranscriptInvalidVideoIdError(),
      { kind: "unavailable", reason: "invalid-video-reference" },
    ],
  ] as const)("translates %s as Video Unavailable", async (error, expected) => {
    mockedFetchTranscript.mockRejectedValue(error);

    await expect(
      createYoutubeTranscriptCaptionTrackProvider()(request()),
    ).resolves.toEqual(expected);
  });

  it("propagates unexpected provider and schema failures", async () => {
    const networkError = new TypeError("network failed");
    mockedFetchTranscript.mockRejectedValueOnce(networkError);
    const provider = createYoutubeTranscriptCaptionTrackProvider();
    await expect(provider(request())).rejects.toBe(networkError);

    mockedFetchTranscript.mockResolvedValueOnce(
      providerResult({ segments: [{ text: "bad", lang: "en" }] }) as never,
    );
    await expect(provider(request())).rejects.toMatchObject({
      name: "CaptionProviderSchemaError",
    });
  });

  it("propagates cancellation unchanged before translating an expected error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    mockedFetchTranscript.mockImplementation(async () => {
      controller.abort(reason);
      throw new YoutubeTranscriptNotAvailableError("dQw4w9WgXcQ");
    });

    await expect(
      createYoutubeTranscriptCaptionTrackProvider()(
        request(undefined, controller.signal),
      ),
    ).rejects.toBe(reason);
  });
});
