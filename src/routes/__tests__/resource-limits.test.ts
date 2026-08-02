import { beforeEach, describe, expect, it, vi } from "vitest";
import { captions } from "../captions.js";
import { metadata } from "../metadata.js";
import { transcribe } from "../transcribe.js";
import * as captionsLib from "../../lib/captions.js";
import * as metadataLib from "../../lib/ytdlp-metadata.js";
import * as transcriptionWorkflow from "../../lib/transcription-workflow.js";
import { resetResourceLimitState } from "../../lib/resource-limits.js";

const VALID_KEY = "resource-limit-test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function post(
  route: typeof metadata | typeof captions | typeof transcribe,
  body: unknown,
  init: RequestInit = {}
) {
  return route.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(body),
    ...init,
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
  delete process.env.GROQ_API_KEY;
  vi.spyOn(
    transcriptionWorkflow,
    "runTranscriptionWorkflow"
  ).mockResolvedValue({
    ok: true,
    segments: [{ text: "ok", start: 0, duration: 1 }],
  });
});

describe("transcription resource limits", () => {
  it("rejects an oversized JSON body before invoking the provider", async () => {
    process.env.MAX_REQUEST_BODY_BYTES = "64";
    const provider = vi
      .spyOn(metadataLib, "fetchYtdlpMetadata")
      .mockResolvedValue({
        title: "unused",
        description: "",
        language: "en",
        duration: 1,
        subtitles: {},
        automatic_captions: {},
      });

    const response = await post(metadata, {
      youtube_url: VIDEO_URL,
      padding: "x".repeat(200),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "Request body too large",
      errorId: "REQUEST_BODY_TOO_LARGE",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed when a required limit is missing", async () => {
    delete process.env.MAX_MEDIA_DURATION_SECONDS;

    const response = await post(metadata, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "Service temporarily unavailable",
      errorId: "SERVICE_LIMITS_MISCONFIGURED",
    });
  });

  it("fails closed when a byte or concurrency limit is fractional", async () => {
    process.env.MAX_CONCURRENT_JOBS = "0.5";

    const response = await post(metadata, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorId: "SERVICE_LIMITS_MISCONFIGURED",
    });
  });

  it("rate-limits each authenticated key without leaking key material", async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = "1";
    vi.spyOn(captionsLib, "fetchCaptions").mockResolvedValue(null);

    const first = await post(captions, { youtube_url: VIDEO_URL });
    const second = await post(captions, { youtube_url: VIDEO_URL });

    expect(first.status).toBe(404);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: "Too many requests",
      errorId: "RATE_LIMITED",
    });
    expect(JSON.stringify(await second.json().catch(() => ""))).not.toContain(
      VALID_KEY
    );
  });

  it("rejects a second transcription while the job limit is occupied", async () => {
    process.env.MAX_CONCURRENT_JOBS = "1";
    process.env.RATE_LIMIT_MAX_REQUESTS = "100";
    let releaseWorkflow!: () => void;
    const workflow = new Promise<{
      ok: true;
      segments: Array<{ text: string; start: number; duration: number }>;
    }>((resolve) => {
      releaseWorkflow = () =>
        resolve({
          ok: true,
          segments: [{ text: "ok", start: 0, duration: 1 }],
        });
    });
    vi.mocked(transcriptionWorkflow.runTranscriptionWorkflow).mockReturnValue(
      workflow
    );

    const firstRequest = post(transcribe, { youtube_url: VIDEO_URL });
    await Promise.resolve();
    const secondResponse = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(secondResponse.status).toBe(429);
    expect(await secondResponse.json()).toMatchObject({
      error: "Transcription busy",
      errorId: "TRANSCRIPTION_BUSY",
    });

    releaseWorkflow();
    expect((await firstRequest).status).toBe(200);
  });

  it("passes the configured duration limit into the workflow", async () => {
    process.env.MAX_MEDIA_DURATION_SECONDS = "60";
    vi.mocked(transcriptionWorkflow.runTranscriptionWorkflow).mockResolvedValue({
      ok: false,
      reason: "media-duration-exceeded",
    });

    const response = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "Video exceeds the processing limit",
      errorId: "MEDIA_DURATION_EXCEEDED",
    });
    expect(transcriptionWorkflow.runTranscriptionWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ mediaMaxDurationSeconds: 60 }),
      })
    );
  });

  it("passes the configured byte limit without exposing internal details", async () => {
    vi.mocked(transcriptionWorkflow.runTranscriptionWorkflow).mockResolvedValue({
      ok: false,
      reason: "media-size-exceeded",
    });

    const response = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: "Video exceeds the processing limit",
      errorId: "MEDIA_SIZE_EXCEEDED",
    });
    expect(JSON.stringify(payload)).not.toContain("50000001");
    expect(transcriptionWorkflow.runTranscriptionWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ mediaMaxBytes: 50_000_000 }),
      })
    );
  });

  it("allows media exactly at the duration boundary", async () => {
    process.env.MAX_MEDIA_DURATION_SECONDS = "60";
    vi.mocked(transcriptionWorkflow.runTranscriptionWorkflow).mockResolvedValue({
      ok: true,
      segments: [{ text: "at the limit", start: 0, duration: 60 }],
    });

    const response = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "whisper",
      transcript: "at the limit",
    });
  });

  it("returns a stable timeout response for a stuck endpoint", async () => {
    process.env.CAPTIONS_TIMEOUT_MS = "5";
    vi.spyOn(captionsLib, "fetchCaptions").mockImplementation(
      () => new Promise(() => {})
    );

    const response = await post(captions, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: "Transcription service timed out",
      errorId: "ENDPOINT_TIMEOUT",
    });
  });
});
