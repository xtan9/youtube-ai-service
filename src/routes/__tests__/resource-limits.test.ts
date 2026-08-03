import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCaptionsRoute,
  type CaptionsRouteDependencies,
} from "../captions.js";
import { createMetadataRoute } from "../metadata.js";
import { createTranscribeRoute } from "../transcribe.js";
import type { TranscriptionWorkflow } from "../../lib/transcription-workflow.js";
import type { VideoInformationWorkflow } from "../../lib/video-information-workflow.js";
import type { AdmissionConfig } from "../../lib/runtime-config.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { ManualClock } from "../../test-support/manual-clock.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { languageTag } from "../../test-support/language-metadata.js";

const VALID_KEY = "resource-limit-test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const workflowMock = vi.fn<TranscriptionWorkflow>();
const metadataWorkflow = vi.fn<VideoInformationWorkflow>();
const captionsDependencies: CaptionsRouteDependencies = {
  captionTrackAcquisition: vi.fn(),
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
  const resourceAdmission = createResourceAdmission(config.admission);
  return {
    captions: createCaptionsRoute(
      config,
      resourceAdmission,
      captionsDependencies,
    ),
    metadata: createMetadataRoute(
      config,
      resourceAdmission,
      metadataWorkflow,
    ),
    transcribe: createTranscribeRoute(config, resourceAdmission, workflowMock),
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
  workflowMock.mockReset().mockResolvedValue({
    ok: true,
    segments: [{ text: "ok", start: 0, duration: 1 }],
  });
  metadataWorkflow.mockReset().mockResolvedValue({
    ok: true,
    videoInformation: {
      title: "Example",
      description: "",
      durationSeconds: 1,
      languageHint: languageTag("en"),
      availableCaptionLanguages: [],
    },
  });
  vi.mocked(captionsDependencies.captionTrackAcquisition).mockReset();
});

describe("transcription resource limits", () => {
  it("rejects an oversized JSON body before invoking the provider", async () => {
    const { metadata } = createRoutes({ requestBodyMaxBytes: 64 });
    const provider = metadataWorkflow;

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
    vi
      .spyOn(captionsDependencies, "captionTrackAcquisition")
      .mockResolvedValue({ kind: "absent", reason: "missing" });

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

  it("returns a stable timeout response for a stuck endpoint", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = createTestRuntimeConfig({
      apiKeys: [VALID_KEY],
      admission: {
        endpointTimeoutMs: { captions: 5 },
        rateLimitMaxRequests: 100,
      },
    });
    const clock = new ManualClock();
    let receivedSignal: AbortSignal | undefined;
    let markWorkStarted!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      markWorkStarted = resolve;
    });
    const captions = createCaptionsRoute(
      config,
      createResourceAdmission(config.admission, clock),
      {
        captionTrackAcquisition: (request) => {
          receivedSignal = request.signal;
          markWorkStarted();
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              {
                once: true,
              },
            );
          });
        },
      },
    );

    const responsePromise = post(captions, { youtube_url: VIDEO_URL });
    await workStarted;
    clock.advanceBy(5);
    const response = await responsePromise;

    expect(receivedSignal?.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: "Transcription service timed out",
      errorId: "ENDPOINT_TIMEOUT",
    });
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("captions.failed"),
      expect.anything(),
    );
  });
});
