import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMetadataRoute,
  type MetadataRouteDependencies,
} from "../metadata.js";
import type {
  VideoInformationWorkflow,
  VideoInformationWorkflowInput,
} from "../../lib/video-information-workflow.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";

const VALID_KEY = "test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const config = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });

const workflow = vi.fn<VideoInformationWorkflow>();
const dependencies: MetadataRouteDependencies = {
  videoInformationWorkflow: workflow,
};
const metadata = createMetadataRoute(
  config,
  createResourceAdmission(config.admission),
  dependencies,
);

function post(body: unknown) {
  return metadata.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      "X-Request-ID": "route-request-id",
    },
    body: JSON.stringify(body),
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
      languageHint: "fr",
      availableCaptionLanguages: ["en", "fr"],
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

  it("preserves cancellation and maps unexpected workflow defects generically", async () => {
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
