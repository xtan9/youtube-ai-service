import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import {
  createVideoInformationWorkflow,
  type VideoInformationWorkflow,
} from "../lib/video-information-workflow.js";
import {
  detectLanguage,
  extractAvailableCaptions,
} from "../lib/language-detect.js";
import { logServiceEvent } from "../lib/observability.js";
import type { YtdlpMetadata } from "../lib/ytdlp-metadata.js";
import { createTestRuntimeConfig } from "../test-support/runtime-config.js";

const CURRENT_KEY = "current-key";
const PREVIOUS_KEY = "previous-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const REQUEST_ID = "req-148-example";
const metadataConfig = createTestRuntimeConfig({ apiKeys: [CURRENT_KEY] });
const fetchMetadata = vi.fn<
  (url: string, signal: AbortSignal) => Promise<YtdlpMetadata>
>();
const videoInformationWorkflow: VideoInformationWorkflow =
  createVideoInformationWorkflow({
    fetchMetadata,
    detectLanguage,
    extractAvailableCaptions,
    logEvent: logServiceEvent,
  });
const appAdapters = {
  fetchCaptions: vi.fn(),
  videoInformationWorkflow,
  transcriptionWorkflow: vi.fn(),
};
const app = createApp(metadataConfig, appAdapters);

function metadataRequest(
  headers: Record<string, string> = {},
  body: unknown = { youtube_url: VIDEO_URL },
  requestApp = app,
) {
  return requestApp.request("/metadata", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CURRENT_KEY}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("transcription HTTP operational contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMetadata.mockReset().mockResolvedValue({
      title: "Example",
      description: "A description",
      language: "en",
      duration: 42,
      subtitles: {},
      automatic_captions: {},
    });
  });

  it("keeps health unauthenticated and returns only minimal status", async () => {
    const response = await app.request("/health", {
      headers: { "X-Request-ID": REQUEST_ID },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("X-Request-ID")).toBe(REQUEST_ID);
  });

  it("replaces malformed request IDs with a bounded generated ID", async () => {
    const response = await app.request("/health", {
      headers: { "X-Request-ID": "contains spaces and secrets" },
    });

    const requestId = response.headers.get("X-Request-ID");
    expect(requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);
    expect(requestId).not.toBe("contains spaces and secrets");
  });

  it.each([undefined, "Basic credentials", "Bearer", "Bearer ", "Bearer key extra"])(
    "returns a generic 401 for malformed authentication: %s",
    async (authorization) => {
      const headers: Record<string, string> = {};
      headers.Authorization = authorization ?? "";

      const response = await metadataRequest(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: "Unauthorized",
        errorId: "AUTH_INVALID_FORMAT",
      });
    expect(response.headers.get("X-Request-ID")).toBeTruthy();
    expect(response.headers.get("X-Error-ID")).toBe("AUTH_INVALID_FORMAT");
    expect(response.headers.get("X-Request-ID")).not.toContain(CURRENT_KEY);
    }
  );

  it("accepts the previous key during the documented rotation overlap", async () => {
    const rotatingConfig = createTestRuntimeConfig({
      apiKeys: [CURRENT_KEY, PREVIOUS_KEY],
    });
    const rotatingApp = createApp(rotatingConfig, appAdapters);
    fetchMetadata.mockResolvedValue({
      title: "Example",
      description: "A description",
      language: "en",
      duration: 42,
      subtitles: {},
      automatic_captions: {},
    });

    const response = await rotatingApp.request("/metadata", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PREVIOUS_KEY}`,
        "X-Request-ID": REQUEST_ID,
      },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe(REQUEST_ID);
  });

  it("returns bounded generic errors with stable IDs and the request ID", async () => {
    const response = await metadataRequest(
      { "X-Request-ID": REQUEST_ID },
      "{not valid json"
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: "Invalid JSON body",
      errorId: "INVALID_JSON",
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(body)).not.toContain("not valid json");
    expect(response.headers.get("X-Request-ID")).toBe(REQUEST_ID);
    expect(response.headers.get("X-Error-ID")).toBe("INVALID_JSON");
  });

  it("does not log full YouTube URLs or content when a provider fails", async () => {
    const errorMessage =
      `provider failed for ${VIDEO_URL}?token=secret Transcript: private text`;
    fetchMetadata.mockRejectedValue(
      new Error(errorMessage)
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await metadataRequest({ "X-Request-ID": REQUEST_ID });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
      requestId: REQUEST_ID,
    });
    const logText = JSON.stringify(errorSpy.mock.calls);
    expect(logText).not.toContain(VIDEO_URL);
    expect(logText).not.toContain("private text");
    expect(logText).not.toContain(CURRENT_KEY);
    expect(logText).toContain(REQUEST_ID);
  });
});
