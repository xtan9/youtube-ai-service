import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptionsRoute } from "../captions.js";
import {
  createMetadataRoute,
  type MetadataRouteDependencies,
} from "../metadata.js";
import { createTranscribeRoute } from "../transcribe.js";
import * as captionsLib from "../../lib/captions.js";
import type { TranscriptionWorkflow } from "../../lib/transcription-workflow.js";
import { resetResourceLimitState } from "../../lib/resource-limits.js";
import type { AdmissionConfig } from "../../lib/runtime-config.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";

const VALID_KEY = "resource-limit-test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const workflowMock = vi.fn<TranscriptionWorkflow>();
const metadataDependencies: MetadataRouteDependencies = {
  fetchMetadata: vi.fn(),
};

function createRoutes(
  admission: Partial<Omit<AdmissionConfig, "endpointTimeoutMs">> & {
    endpointTimeoutMs?: Partial<AdmissionConfig["endpointTimeoutMs"]>;
  } = {}
) {
  const config = createTestRuntimeConfig({
    apiKeys: [VALID_KEY],
    admission,
  });
  return {
    captions: createCaptionsRoute(config),
    metadata: createMetadataRoute(config, metadataDependencies),
    transcribe: createTranscribeRoute(config, workflowMock),
  };
}

type RequestableRoute = ReturnType<typeof createMetadataRoute>;

function post(
  route: RequestableRoute,
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
  workflowMock.mockReset().mockResolvedValue({
    ok: true,
    segments: [{ text: "ok", start: 0, duration: 1 }],
  });
  vi.mocked(metadataDependencies.fetchMetadata).mockReset();
});

describe("transcription resource limits", () => {
  it("rejects an oversized JSON body before invoking the provider", async () => {
    const { metadata } = createRoutes({ requestBodyMaxBytes: 64 });
    const provider = vi
      .spyOn(metadataDependencies, "fetchMetadata")
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

  it("rate-limits each authenticated key without leaking key material", async () => {
    const { captions } = createRoutes({ rateLimitMaxRequests: 1 });
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
    const { transcribe } = createRoutes({
      maxConcurrentJobs: 1,
      rateLimitMaxRequests: 100,
    });
    let releaseWorkflow!: () => void;
    const workflowResult = new Promise<{
      ok: true;
      segments: Array<{ text: string; start: number; duration: number }>;
    }>((resolve) => {
      releaseWorkflow = () =>
        resolve({
          ok: true,
          segments: [{ text: "ok", start: 0, duration: 1 }],
        });
    });
    workflowMock.mockReturnValue(workflowResult);

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
    const { transcribe } = createRoutes({ mediaMaxDurationSeconds: 60 });
    workflowMock.mockResolvedValue({
      ok: false,
      reason: "media-duration-exceeded",
    });

    const response = await post(transcribe, { youtube_url: VIDEO_URL });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "Video exceeds the processing limit",
      errorId: "MEDIA_DURATION_EXCEEDED",
    });
    expect(workflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ mediaMaxDurationSeconds: 60 }),
      })
    );
  });

  it("passes the configured byte limit without exposing internal details", async () => {
    const { transcribe } = createRoutes();
    workflowMock.mockResolvedValue({
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
    expect(workflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ mediaMaxBytes: 50_000_000 }),
      })
    );
  });

  it("allows media exactly at the duration boundary", async () => {
    const { transcribe } = createRoutes({ mediaMaxDurationSeconds: 60 });
    workflowMock.mockResolvedValue({
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
    const { captions } = createRoutes({
      endpointTimeoutMs: { captions: 5 },
    });
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
