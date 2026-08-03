import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMetadataRoute } from "../metadata.js";
import type { VideoInformationWorkflow } from "../../lib/video-information-workflow.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { parseYouTubeVideoReference } from "../../lib/youtube-url.js";
import { languageTag } from "../../test-support/language-metadata.js";

const VALID_KEY = "test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIDEO_REFERENCE = parseYouTubeVideoReference(VIDEO_URL);
if (!VIDEO_REFERENCE) throw new Error("test fixture must be a YouTube URL");
const metadataConfig = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });
const videoInformationWorkflow = vi.fn<VideoInformationWorkflow>();
const metadata = createMetadataRoute(
  metadataConfig,
  createResourceAdmission(metadataConfig.admission),
  videoInformationWorkflow,
);

function post(body: unknown) {
  return metadata.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  videoInformationWorkflow.mockReset().mockResolvedValue({
    ok: true,
    videoInformation: {
      title: "Example",
      description: "A description",
      durationSeconds: 42,
      languageHint: languageTag("en"),
      availableCaptionLanguages: [],
    },
  });
});

describe("POST /metadata", () => {
  it("rejects non-YouTube URLs with 400", async () => {
    const res = await post({ youtube_url: "https://example.com/video" });
    expect(res.status).toBe(400);
  });

  it("returns the stable metadata wire contract from curated Video Information", async () => {
    videoInformationWorkflow.mockResolvedValue({
      ok: true,
      videoInformation: {
        title: "Comment apprendre",
        description: "Une vidéo en français",
        languageHint: languageTag("fr-FR"),
        durationSeconds: 893,
        availableCaptionLanguages: [
          languageTag("fr").primaryLanguageCode,
          languageTag("en").primaryLanguageCode,
        ],
      },
    });

    const res = await post({ youtube_url: VIDEO_URL });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      language: "fr",
      title: "Comment apprendre",
      description: "Une vidéo en français",
      duration: 893,
      availableCaptions: ["fr", "en"],
    });
  });

  it("passes the request work signal and correlation to the workflow", async () => {
    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(200);
    expect(videoInformationWorkflow).toHaveBeenCalledWith({
      videoReference: VIDEO_REFERENCE,
      signal: expect.any(AbortSignal),
      correlation: {
        requestId: expect.any(String),
        videoId: "dQw4w9WgXcQ",
      },
    });
  });

  it("forwards duration=null without coercing it to zero", async () => {
    videoInformationWorkflow.mockResolvedValue({
      ok: true,
      videoInformation: {
        title: "Live",
        description: "",
        languageHint: languageTag("en"),
        durationSeconds: null,
        availableCaptionLanguages: [],
      },
    });

    const res = await post({ youtube_url: VIDEO_URL });

    expect(res.status).toBe(200);
    expect((await res.json()).duration).toBeNull();
  });

  it("maps workflow unavailability to a generic 500 response", async () => {
    videoInformationWorkflow.mockResolvedValue({
      ok: false,
      reason: "temporarily-unavailable",
    });

    const res = await post({ youtube_url: VIDEO_URL });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
      requestId: expect.any(String),
    });
  });

  it("maps unexpected workflow defects generically without provider details", async () => {
    videoInformationWorkflow.mockRejectedValue(
      new Error("yt-dlp metadata failed: /opt/tmp/internal/path/leaked"),
    );

    const res = await post({ youtube_url: VIDEO_URL });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("/opt/tmp");
  });
});

describe("POST /metadata auth enforcement", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await metadata.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 on a wrong bearer token", async () => {
    const res = await metadata.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });
    expect(res.status).toBe(403);
  });
});
