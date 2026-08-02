import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribe } from "../transcribe.js";
import { resetResourceLimitState } from "../../lib/resource-limits.js";
import * as transcriptionWorkflow from "../../lib/transcription-workflow.js";

const VALID_KEY = "test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function post(body: unknown, headers: Record<string, string> = {}) {
  return transcribe.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function postRaw(body: string) {
  return transcribe.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetResourceLimitState();
  process.env.VPS_API_KEY = VALID_KEY;
  process.env.MAX_REQUEST_BODY_BYTES = "65536";
  process.env.MAX_MEDIA_SIZE_BYTES = "50000000";
  process.env.MAX_MEDIA_DURATION_SECONDS = "1800";
  process.env.RATE_LIMIT_WINDOW_MS = "60000";
  process.env.RATE_LIMIT_MAX_REQUESTS = "1000";
  process.env.MAX_CONCURRENT_JOBS = "8";
  process.env.METADATA_TIMEOUT_MS = "30000";
  process.env.CAPTIONS_TIMEOUT_MS = "30000";
  process.env.TRANSCRIBE_TIMEOUT_MS = "300000";
  vi.spyOn(
    transcriptionWorkflow,
    "runTranscriptionWorkflow"
  ).mockResolvedValue({
    ok: true,
    segments: [{ text: "hello", start: 0, duration: 1 }],
  });
});

describe("POST /transcribe HTTP boundary", () => {
  it("rejects malformed JSON", async () => {
    const response = await postRaw("{");

    expect(response.status).toBe(400);
  });

  it("rejects an invalid request", async () => {
    const response = await post({ youtube_url: "https://example.com/video" });

    expect(response.status).toBe(400);
  });

  it.each(["--language", "; rm -rf /", " en", "a", ""])(
    "rejects invalid language value %s",
    async (lang) => {
      const response = await post({ youtube_url: VIDEO_URL, lang });

      expect(response.status).toBe(400);
    }
  );

  it("passes validated input, limits, and correlation to the workflow", async () => {
    await post(
      { youtube_url: VIDEO_URL, lang: "fr" },
      { "X-Request-ID": "workflow-request-id" }
    );

    expect(transcriptionWorkflow.runTranscriptionWorkflow).toHaveBeenCalledWith(
      {
        youtubeUrl: VIDEO_URL,
        language: "fr",
        limits: {
          mediaMaxBytes: 50_000_000,
          mediaMaxDurationSeconds: 1_800,
        },
        correlation: {
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
        },
      }
    );
  });

  it("maps a completed outcome to the compatibility response", async () => {
    vi.mocked(transcriptionWorkflow.runTranscriptionWorkflow).mockResolvedValue({
      ok: true,
      segments: [
        { text: "  hello\tworld  ", start: 0, duration: 1 },
        { text: "\nfoo  ", start: 1, duration: 1 },
      ],
    });

    const response = await post({ youtube_url: VIDEO_URL, lang: "en" });

    expect(await response.json()).toEqual({
      segments: [
        { text: "  hello\tworld  ", start: 0, duration: 1 },
        { text: "\nfoo  ", start: 1, duration: 1 },
      ],
      transcript: "hello world foo",
      language: "en",
      source: "whisper",
    });
  });

  it.each([
    [
      "media-size-exceeded",
      413,
      "Video exceeds the processing limit",
      "MEDIA_SIZE_EXCEEDED",
    ],
    [
      "media-duration-unknown",
      503,
      "Video duration could not be determined",
      "MEDIA_DURATION_UNKNOWN",
    ],
    [
      "media-duration-exceeded",
      413,
      "Video exceeds the processing limit",
      "MEDIA_DURATION_EXCEEDED",
    ],
    [
      "temporarily-unavailable",
      503,
      "Transcription temporarily unavailable",
      "TRANSCRIPTION_TEMPORARILY_UNAVAILABLE",
    ],
    [
      "empty-result",
      500,
      "Transcription produced no content",
      "TRANSCRIPTION_EMPTY_RESULT",
    ],
    [
      "transcription-failed",
      500,
      "Transcription failed",
      "TRANSCRIPTION_FAILED",
    ],
  ] as const)(
    "maps workflow outcome %s to its stable HTTP error",
    async (reason, status, error, errorId) => {
      vi.mocked(
        transcriptionWorkflow.runTranscriptionWorkflow
      ).mockResolvedValue({ ok: false, reason });

      const response = await post({ youtube_url: VIDEO_URL });

      expect({ status: response.status, body: await response.json() }).toEqual({
        status,
        body: {
          error,
          errorId,
          requestId: expect.any(String),
        },
      });
    }
  );

  it("maps unexpected workflow defects to a generic failure", async () => {
    vi.mocked(transcriptionWorkflow.runTranscriptionWorkflow).mockRejectedValue(
      new Error("whisper internal crash: /opt/models/tiny.bin missing")
    );

    const response = await post({ youtube_url: VIDEO_URL });
    const body = await response.json();

    expect({ status: response.status, body }).toEqual({
      status: 500,
      body: {
        error: "Transcription failed",
        errorId: "TRANSCRIPTION_FAILED",
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain("/opt/models");
  });

  it("requires authentication", async () => {
    const response = await transcribe.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects an invalid credential", async () => {
    const response = await transcribe.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });

    expect(response.status).toBe(403);
  });
});
