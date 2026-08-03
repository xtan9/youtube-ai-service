import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMetadataRoute } from "../metadata.js";
import type {
  VideoInformationWorkflow,
  VideoInformationWorkflowInput,
} from "../../lib/video-information-workflow.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { languageTag } from "../../test-support/language-metadata.js";

const VALID_KEY = "test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const config = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });

const workflow = vi.fn<VideoInformationWorkflow>();
const metadata = createMetadataRoute(
  config,
  createResourceAdmission(config.admission),
  workflow,
);

function post(body: unknown, init: RequestInit = {}) {
  return metadata.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      "X-Request-ID": "route-request-id",
    },
    body: JSON.stringify(body),
    ...init,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  workflow.mockResolvedValue({
    ok: true,
    videoInformation: {
      title: "Example",
      description: "Bounded description",
      durationSeconds: null,
      languageHint: languageTag("fr"),
      availableCaptionLanguages: [
        languageTag("en").primaryLanguageCode,
        languageTag("fr").primaryLanguageCode,
      ],
    },
  });
});

describe("metadata route workflow seam", () => {
  it("maps curated Video Information to the stable metadata response", async () => {
    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      language: "fr",
      title: "Example",
      description: "Bounded description",
      duration: null,
      availableCaptions: ["en", "fr"],
    });
    expect(workflow).toHaveBeenCalledWith({
      youtubeUrl: VIDEO_URL,
      signal: expect.any(AbortSignal),
      correlation: {
        requestId: "route-request-id",
        videoId: "dQw4w9WgXcQ",
      },
    } satisfies VideoInformationWorkflowInput);
  });

  it("maps an unavailable workflow outcome to the existing generic failure", async () => {
    workflow.mockResolvedValue({
      ok: false,
      reason: "temporarily-unavailable",
    });

    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
      requestId: "route-request-id",
    });
  });

  it("propagates request cancellation unchanged through the workflow seam", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const cancellation = new DOMException("request stopped", "AbortError");
    let markWorkflowStarted!: () => void;
    const workflowStarted = new Promise<void>((resolve) => {
      markWorkflowStarted = resolve;
    });
    workflow.mockImplementation(async ({ signal }) => {
      markWorkflowStarted();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      throw new Error("unreachable");
    });

    const responsePromise = post(
      { youtube_url: VIDEO_URL },
      { signal: controller.signal },
    );
    await workflowStarted;
    controller.abort(cancellation);

    const response = await responsePromise;
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Error-ID")).toBeNull();
    expect(await response.text()).toBe("Internal Server Error");
    expect(errorSpy).toHaveBeenCalledWith(cancellation);
  });

  it("maps unexpected workflow defects generically without provider details", async () => {
    const defect = new Error("private workflow defect");
    workflow.mockRejectedValue(defect);

    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("private workflow defect");
  });
});
