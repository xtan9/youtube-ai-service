import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedFetchTranscript = vi.hoisted(() => vi.fn());

vi.mock("youtube-transcript-plus", async () => {
  const actual =
    await vi.importActual<typeof import("youtube-transcript-plus")>(
      "youtube-transcript-plus",
    );
  return { ...actual, fetchTranscript: mockedFetchTranscript };
});

import { createApp } from "../app.js";
import { createTestRuntimeConfig } from "../test-support/runtime-config.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function captions(app: ReturnType<typeof createApp>) {
  const response = await app.request("/captions", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ youtube_url: VIDEO_URL }),
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

describe("production Caption Track composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchTranscript.mockResolvedValue({
      segments: [{ text: "hello", lang: "en", offset: 0, duration: 1 }],
      videoDetails: { title: "Example", author: "Channel" },
    });
  });

  it("passes the request-built canonical Video ID to Caption Track acquisition", async () => {
    const app = createApp(createTestRuntimeConfig());

    const result = await captions(app);

    expect(result).toEqual({
      status: 200,
      body: {
        segments: [{ text: "hello", start: 0, duration: 1 }],
        transcript: "hello",
        source: "auto_captions",
        language: "en",
        title: "Example",
        channelName: "Channel",
      },
    });
    expect(mockedFetchTranscript).toHaveBeenCalledWith(
      "dQw4w9WgXcQ",
      expect.objectContaining({
        videoDetails: true,
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
