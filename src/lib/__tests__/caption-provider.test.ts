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
  return {
    videoId: "dQw4w9WgXcQ",
    ...(language === undefined ? {} : { language }),
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
    vi.clearAllMocks();
  });

  it("forwards an explicit language and request work signal", async () => {
    mockedFetchTranscript.mockResolvedValue(providerResult() as never);
    const signal = new AbortController().signal;
    const provider = createYoutubeTranscriptCaptionTrackProvider();

    await expect(provider(request("zh", signal))).resolves.toEqual({
      kind: "success",
      segments: [{ text: "hello", start: 2, duration: 1.5 }],
      languageTag: "en",
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

  it.each([
    ["disabled", new YoutubeTranscriptDisabledError("dQw4w9WgXcQ"), { kind: "absent", reason: "disabled" }],
    ["missing", new YoutubeTranscriptNotAvailableError("dQw4w9WgXcQ"), { kind: "absent", reason: "missing" }],
    [
      "language mismatch",
      new YoutubeTranscriptNotAvailableLanguageError(
        "zh",
        ["zh-Hans", "en"],
        "dQw4w9WgXcQ",
      ),
      {
        kind: "absent",
        reason: "language-mismatch",
        availableLanguages: ["zh-Hans", "en"],
      },
    ],
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
