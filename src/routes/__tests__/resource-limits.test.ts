import { beforeEach, describe, expect, it, vi } from "vitest";
import { captions } from "../captions.js";
import { metadata } from "../metadata.js";
import { transcribe } from "../transcribe.js";
import * as captionsLib from "../../lib/captions.js";
import * as metadataLib from "../../lib/ytdlp-metadata.js";
import * as ytdlpLib from "../../lib/ytdlp.js";
import * as audioDurationLib from "../../lib/audio-duration.js";
import * as whisperLib from "../../lib/whisper.js";
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
    let releaseDownload!: (path: string) => void;
    const download = new Promise<string>((resolve) => {
      releaseDownload = resolve;
    });
    vi.spyOn(ytdlpLib, "downloadAudio").mockReturnValue(download);
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(1);
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue([
      { text: "ok", start: 0, duration: 1 },
    ]);

    const firstRequest = post(transcribe, { youtube_url: VIDEO_URL });
    await Promise.resolve();
    const secondResponse = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(secondResponse.status).toBe(429);
    expect(await secondResponse.json()).toMatchObject({
      error: "Transcription busy",
      errorId: "TRANSCRIPTION_BUSY",
    });

    releaseDownload("/tmp/resource-limit.mp3");
    expect((await firstRequest).status).toBe(200);
  });

  it("rejects media at the duration limit and never starts a provider", async () => {
    process.env.MAX_MEDIA_DURATION_SECONDS = "60";
    vi.spyOn(ytdlpLib, "downloadAudio").mockResolvedValue("/tmp/too-long.mp3");
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(60.1);
    const provider = vi.spyOn(whisperLib, "transcribeAudio");

    const response = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "Video exceeds the processing limit",
      errorId: "MEDIA_DURATION_EXCEEDED",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects media at the byte limit without exposing provider details", async () => {
    const provider = vi
      .spyOn(ytdlpLib, "downloadAudio")
      .mockRejectedValue(
        new ytdlpLib.AudioMediaLimitError(50_000_001, 50_000_000)
      );

    const response = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: "Video exceeds the processing limit",
      errorId: "MEDIA_SIZE_EXCEEDED",
    });
    expect(JSON.stringify(payload)).not.toContain("50000001");
    expect(provider).toHaveBeenCalledWith(VIDEO_URL, 50_000_000);
  });

  it("allows media exactly at the duration boundary", async () => {
    process.env.MAX_MEDIA_DURATION_SECONDS = "60";
    vi.spyOn(ytdlpLib, "downloadAudio").mockResolvedValue("/tmp/exact.mp3");
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(
      60
    );
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue([
      { text: "at the limit", start: 0, duration: 60 },
    ]);

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
