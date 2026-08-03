import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const downloadAudio = vi.fn();
  const transcribeViaGroq = vi.fn();

  return {
    cleanupAudio: vi.fn(),
    createAudioDownloader: vi.fn(() => downloadAudio),
    createAudioPath: vi.fn(() => "/tmp/audio.mp3"),
    downloadAudio,
    logServiceEvent: vi.fn(),
    probeAudioDurationSeconds: vi.fn(),
    transcribeAudio: vi.fn(),
    createGroqTranscriber: vi.fn(() => transcribeViaGroq),
    transcribeViaGroq,
  };
});

vi.mock("../lib/audio-duration.js", () => ({
  probeAudioDurationSeconds: mocks.probeAudioDurationSeconds,
}));

vi.mock("../lib/groq-transcribe.js", () => ({
  createGroqTranscriber: mocks.createGroqTranscriber,
  GroqTranscribeError: class GroqTranscribeError extends Error {},
}));

vi.mock("../lib/observability.js", () => ({
  logServiceEvent: mocks.logServiceEvent,
}));

vi.mock("../lib/whisper.js", () => ({
  LocalTranscriptionError: class LocalTranscriptionError extends Error {},
  transcribeAudio: mocks.transcribeAudio,
}));

vi.mock("../lib/ytdlp.js", () => ({
  AudioDownloadError: class AudioDownloadError extends Error {},
  AudioMediaLimitError: class AudioMediaLimitError extends Error {},
  cleanupAudio: mocks.cleanupAudio,
  createAudioDownloader: mocks.createAudioDownloader,
  createAudioPath: mocks.createAudioPath,
}));

import { createApp } from "../app.js";
import { createTestRuntimeConfig } from "../test-support/runtime-config.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadAudio.mockResolvedValue(undefined);
  mocks.cleanupAudio.mockResolvedValue(undefined);
  mocks.probeAudioDurationSeconds.mockResolvedValue(60);
  mocks.transcribeAudio.mockResolvedValue([
    { text: "local result", start: 0, duration: 1 },
  ]);
  mocks.transcribeViaGroq.mockResolvedValue({
    segments: [{ text: "groq result", start: 0, duration: 1 }],
    language: "en",
  });
});

async function transcribe(app: ReturnType<typeof createApp>) {
  const response = await app.request("/transcribe", {
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

describe("production transcription composition", () => {
  it("constructs a runnable local-only workflow without Groq configuration", async () => {
    const app = createApp(createTestRuntimeConfig());

    const result = await transcribe(app);

    expect(result).toEqual({
      status: 200,
      body: {
        segments: [{ text: "local result", start: 0, duration: 1 }],
        transcript: "local result",
        language: "auto",
        source: "whisper",
      },
    });
    expect(mocks.createGroqTranscriber).not.toHaveBeenCalled();
    expect(mocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(mocks.transcribeViaGroq).not.toHaveBeenCalled();
    expect(mocks.downloadAudio).toHaveBeenCalledWith(
      {
        url: VIDEO_URL,
        videoId: "dQw4w9WgXcQ",
      },
      "/tmp/audio.mp3",
      expect.any(Number),
      expect.any(AbortSignal),
    );
    expect(Object.isFrozen(mocks.downloadAudio.mock.calls[0]?.[0])).toBe(true);
  });

  it("constructs a runnable Groq-first workflow with Groq configuration", async () => {
    const app = createApp(
      createTestRuntimeConfig({
        transcription: {
          groq: {
            apiKey: "groq-test-key",
            model: "whisper-test-model",
            timeoutMs: 7_000,
          },
          localFallbackMaxSeconds: 45,
        },
      }),
    );

    const result = await transcribe(app);

    expect(result).toEqual({
      status: 200,
      body: {
        segments: [{ text: "groq result", start: 0, duration: 1 }],
        transcript: "groq result",
        language: "auto",
        source: "whisper",
      },
    });
    expect(mocks.createGroqTranscriber).toHaveBeenCalledOnce();
    expect(mocks.createGroqTranscriber).toHaveBeenCalledWith({
      apiKey: "groq-test-key",
      model: "whisper-test-model",
      timeoutMs: 7_000,
    });
    expect(mocks.transcribeViaGroq).toHaveBeenCalledOnce();
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });
});
