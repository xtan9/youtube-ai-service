import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCaptionsRoute,
  type CaptionsRouteDependencies,
} from "../captions.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { parseYouTubeVideoReference } from "../../lib/youtube-url.js";

// All route tests run with a valid VPS_API_KEY in env — the auth path is
// also exercised via a dedicated block below.
const VALID_KEY = "test-key";
const VIDEO_REFERENCE = parseYouTubeVideoReference(
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
);
if (!VIDEO_REFERENCE) throw new Error("test fixture must be a YouTube URL");
const captionsDependencies: CaptionsRouteDependencies = {
  fetchCaptions: vi.fn(),
};
const captionsConfig = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });
const captions = createCaptionsRoute(
  captionsConfig,
  createResourceAdmission(captionsConfig.admission),
  captionsDependencies,
);

function post(body: unknown, path = "/") {
  return captions.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /captions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(captionsDependencies.fetchCaptions).mockReset();
  });

  it("rejects non-URL values with 400 (zod .url() guard)", async () => {
    const res = await post({ youtube_url: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("returns 404 with a stable error code when no captions are available", async () => {
    // The frontend's fallback routing depends on 404 being distinct from
    // 500 — on 404 it proceeds to /transcribe silently; on 500 it
    // surfaces an error. If these ever get merged, expect either
    // unnecessary alert storms or silently-swallowed bugs.
    vi.spyOn(captionsDependencies, "fetchCaptions").mockResolvedValue(null);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "no_captions",
      errorId: "CAPTIONS_NOT_FOUND",
      requestId: expect.any(String),
    });
  });

  it("returns 200 with segments + a derived transcript string on success", async () => {
    // Wire response includes both `segments` (canonical) and `transcript`
    // (derived). The transcript field is kept for one rollout window so a
    // frontend deployment that hasn't picked up segments yet still works;
    // a follow-up cleanup PR drops it. Drift here would either break the
    // old frontend (transcript missing) or stop carrying timing to the
    // new frontend (segments missing).
    const mockResult = {
      segments: [
        { text: "hello", start: 0, duration: 1 },
        { text: "world", start: 1, duration: 1 },
      ],
      source: "auto_captions" as const,
      language: "en" as const,
      title: "test video",
      channelName: "test channel",
    };
    vi.spyOn(captionsDependencies, "fetchCaptions").mockResolvedValue(mockResult);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...mockResult,
      transcript: "hello world",
    });
  });

  it("normalizes whitespace in the derived transcript (matches pre-PR contract)", async () => {
    // The pre-PR captions path joined and then `.replace(/\s+/g, " ").trim()`-ed
    // the transcript. An old frontend that hashed / length-gated the field
    // would otherwise see a different value for the same video during the
    // rollout window. The route preserves the legacy normalization on the
    // derived string while keeping the segments themselves verbatim.
    vi.spyOn(captionsDependencies, "fetchCaptions").mockResolvedValue({
      segments: [
        { text: "  hello\tworld  ", start: 0, duration: 1 },
        { text: "\n\n  foo  ", start: 1, duration: 1 },
      ],
      source: "auto_captions" as const,
      language: "en" as const,
      title: "t",
      channelName: "c",
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const body = (await res.json()) as { transcript: string };
    expect(body.transcript).toBe("hello world foo");
  });

  it("returns 500 with a generic message when fetchCaptions throws", async () => {
    // Captions lib throws only on unexpected errors (library schema
    // drift, network, parse failure). We return a generic string to the
    // client so raw internals aren't echoed into the browser; the real
    // error stays in logs.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(captionsDependencies, "fetchCaptions").mockRejectedValue(
      new Error("internal-library-stack-trace-would-leak-here")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "Internal error",
      errorId: "CAPTIONS_FAILED",
      requestId: expect.any(String),
    });
    expect(body.error).not.toContain("internal-library-stack-trace");
  });

  it("handles synchronous throws from fetchCaptions (await coerces to rejection)", async () => {
    // Defense against a future refactor that drops `async` from
    // fetchCaptions — the route still awaits it so a sync throw still
    // routes through the catch.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(captionsDependencies, "fetchCaptions").mockImplementation(() => {
      throw new Error("sync-throw");
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
  });

  it("forwards the canonical Language Tag to fetchCaptions when provided", async () => {
    // The captions adapter needs the full canonical identity so it can
    // distinguish an exact request from a primary-only fallback request.
    const spy = vi
      .spyOn(captionsDependencies, "fetchCaptions")
      .mockResolvedValue(null);
    await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      lang: "fra-CA",
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: VIDEO_REFERENCE.url,
        videoId: VIDEO_REFERENCE.videoId,
      }),
      {
        tag: "fr-CA",
        primaryLanguageCode: "fr",
      },
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(Object.isFrozen(spy.mock.calls[0]?.[0])).toBe(true);
  });

  it("omits `lang` when the caller didn't send one (back-compat)", async () => {
    const spy = vi
      .spyOn(captionsDependencies, "fetchCaptions")
      .mockResolvedValue(null);
    await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    // Second arg is undefined — preserves pre-PR behavior where no lang
    // filter was applied. The request ID is the new third argument used for
    // correlated structured service logs.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: VIDEO_REFERENCE.url,
        videoId: VIDEO_REFERENCE.videoId,
      }),
      undefined,
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(Object.isFrozen(spy.mock.calls[0]?.[0])).toBe(true);
  });

  it.each([
    ["--model", "CLI-flag shape"],
    ["; rm -rf /", "shell-metachar shape"],
    ["en_US", "underscore instead of dash"],
    ["a", "too short"],
    ["", "empty string"],
    [" en", "leading whitespace"],
    ["auto", "automatic-language sentinel"],
    ["abc", "unsupported primary language"],
    ["en-u-ca-gregory", "extension-bearing tag"],
  ])("rejects lang=%s (%s) with 400", async (lang) => {
    // Argv-based execFile blocks shell injection, but a lang like "--model"
    // would reach whisper and produce confusing CLI errors that surface
    // as 500 in logs. Reject at the schema boundary so the failure is
    // classified as "bad client input" instead of "service broken".
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      lang,
    });
    expect(res.status).toBe(400);
    expect(captionsDependencies.fetchCaptions).not.toHaveBeenCalled();
  });

  it.each([
    ["en"],
    ["fr"],
    ["zh"],
    ["eng"], // 3-letter ISO 639-3
    ["en-US"],
    ["zh-Hans"],
    ["zh-Hant-TW"],
  ])("accepts well-formed BCP-47 / ISO 639 tag: %s", async (lang) => {
    vi.spyOn(captionsDependencies, "fetchCaptions").mockResolvedValue(null);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      lang,
    });
    expect(res.status).toBe(404); // no_captions, but schema passed
  });
});

describe("POST /captions — auth enforcement", () => {
  // Auth middleware is attached inside the sub-router, not at the app
  // level. Verify it actually fires on THIS path so a future refactor
  // that moves middleware can't silently expose the endpoint.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await captions.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 on a wrong bearer token", async () => {
    const res = await captions.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(403);
  });
});
