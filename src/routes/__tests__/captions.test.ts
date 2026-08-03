import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCaptionsRoute,
} from "../captions.js";
import type { CaptionTrackAcquisition } from "../../lib/captions.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { parseYouTubeVideoReference } from "../../lib/youtube-url.js";

const VALID_KEY = "test-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIDEO_REFERENCE = parseYouTubeVideoReference(VIDEO_URL);
if (!VIDEO_REFERENCE) throw new Error("test fixture must be a YouTube URL");

const captionTrackAcquisition = vi.fn<CaptionTrackAcquisition>();
const captionsConfig = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });
const captions = createCaptionsRoute(
  captionsConfig,
  createResourceAdmission(captionsConfig.admission),
  { captionTrackAcquisition },
);

function post(body: unknown, headers: Record<string, string> = {}) {
  return captions.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /captions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    captionTrackAcquisition.mockReset();
  });

  it("rejects invalid validated-reference input with 400 before acquisition", async () => {
    const response = await post({ youtube_url: "https://example.com/video" });

    expect(response.status).toBe(400);
    expect(captionTrackAcquisition).not.toHaveBeenCalled();
  });

  it("injects one frozen acquisition request with canonical language, correlation, and signal", async () => {
    captionTrackAcquisition.mockResolvedValue({
      kind: "absent",
      reason: "missing",
    });

    const response = await post(
      { youtube_url: VIDEO_URL, lang: "zh-hant-tw" },
      { "X-Request-ID": "route-request-id" },
    );

    expect(response.status).toBe(404);
    expect(captionTrackAcquisition).toHaveBeenCalledOnce();
    const request = captionTrackAcquisition.mock.calls[0]?.[0];
    expect(request).toEqual({
      videoReference: VIDEO_REFERENCE,
      requestedLanguage: {
        tag: "zh-Hant-TW",
        primaryLanguageCode: "zh",
      },
      requestId: "route-request-id",
      signal: expect.any(AbortSignal),
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request?.videoReference)).toBe(true);
  });

  it("keeps requested-language omission explicit at the seam", async () => {
    captionTrackAcquisition.mockResolvedValue({
      kind: "absent",
      reason: "missing",
    });

    await post({ youtube_url: VIDEO_URL });

    expect(captionTrackAcquisition).toHaveBeenCalledWith({
      videoReference: VIDEO_REFERENCE,
      requestedLanguage: undefined,
      requestId: expect.any(String),
      signal: expect.any(AbortSignal),
    });
  });

  it("maps an acquired outcome to the current 200 response and transcript compatibility field", async () => {
    captionTrackAcquisition.mockResolvedValue({
      kind: "acquired",
      segments: [
        { text: "  hello\tworld  ", start: 0, duration: 1 },
        { text: "\nfoo  ", start: 1, duration: 1 },
      ],
      source: "auto_captions",
      promptLocale: "zh",
      title: "test video",
      channelName: "test channel",
    });

    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      segments: [
        { text: "  hello\tworld  ", start: 0, duration: 1 },
        { text: "\nfoo  ", start: 1, duration: 1 },
      ],
      transcript: "hello world foo",
      source: "auto_captions",
      language: "zh",
      title: "test video",
      channelName: "test channel",
    });
  });

  it("maps every Caption Track Absent reason to the existing bounded 404", async () => {
    for (const reason of [
      "disabled",
      "missing",
      "language-mismatch",
      "empty-provider-result",
      "filtered-empty",
    ] as const) {
      captionTrackAcquisition.mockResolvedValue({ kind: "absent", reason });

      const response = await post({ youtube_url: VIDEO_URL });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: "no_captions",
        errorId: "CAPTIONS_NOT_FOUND",
        requestId: expect.any(String),
      });
    }
  });

  it("maps Video Unavailable to a bounded terminal 422 contract", async () => {
    captionTrackAcquisition.mockResolvedValue({
      kind: "video-unavailable",
      reason: "provider-video-unavailable",
    });

    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "Video unavailable",
      errorId: "VIDEO_UNAVAILABLE",
    });
  });

  it("maps unexpected acquisition failures to generic 500 without logging a second provider event", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    captionTrackAcquisition.mockRejectedValue(
      new Error("provider internals must not reach HTTP"),
    );

    const response = await post({ youtube_url: VIDEO_URL });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Internal error",
      errorId: "CAPTIONS_FAILED",
      requestId: expect.any(String),
    });
    expect(errorSpy).not.toHaveBeenCalledWith(
      "[captions.failed]",
      expect.anything(),
    );
  });

  it.each([
    ["--model", "CLI flag"],
    ["; rm -rf /", "shell metacharacters"],
    ["en_US", "underscore"],
    ["a", "too short"],
    ["", "empty"],
    [" en", "leading whitespace"],
    ["auto", "sentinel"],
    ["abc", "unsupported primary"],
    ["en-u-ca-gregory", "extension"],
  ])("rejects %s (%s) before acquisition", async (lang) => {
    const response = await post({ youtube_url: VIDEO_URL, lang });

    expect(response.status).toBe(400);
    expect(captionTrackAcquisition).not.toHaveBeenCalled();
  });

  it("preserves authentication enforcement", async () => {
    const response = await captions.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });

    expect(response.status).toBe(401);
  });
});
