import { describe, it, expect, vi, beforeEach } from "vitest";
import { captions } from "../captions.js";
import * as captionsLib from "../../lib/captions.js";

// All route tests run with a valid VPS_API_KEY in env — the auth path is
// also exercised via a dedicated block below.
const VALID_KEY = "test-key";

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
    process.env.VPS_API_KEY = VALID_KEY;
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await post({ not_the_right_field: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-URL values with 400 (zod .url() guard)", async () => {
    const res = await post({ youtube_url: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400 (not 500)", async () => {
    // Hono's default behavior is to throw on c.req.json() failure, which
    // becomes a 500. The endpoint overrides that so a malformed request
    // body is classified as client error rather than service error.
    const res = await captions.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 with a stable error code when no captions are available", async () => {
    // The frontend's fallback routing depends on 404 being distinct from
    // 500 — on 404 it proceeds to /transcribe silently; on 500 it
    // surfaces an error. If these ever get merged, expect either
    // unnecessary alert storms or silently-swallowed bugs.
    vi.spyOn(captionsLib, "fetchCaptions").mockResolvedValue(null);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_captions" });
  });

  it("returns 200 with the full caption result on success", async () => {
    const mockResult = {
      transcript: "hello world",
      source: "auto_captions" as const,
      language: "en" as const,
      title: "test video",
      channelName: "test channel",
    };
    vi.spyOn(captionsLib, "fetchCaptions").mockResolvedValue(mockResult);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockResult);
  });

  it("returns 500 with a generic message when fetchCaptions throws", async () => {
    // Captions lib throws only on unexpected errors (library schema
    // drift, network, parse failure). We return a generic string to the
    // client so raw internals aren't echoed into the browser; the real
    // error stays in logs.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(captionsLib, "fetchCaptions").mockRejectedValue(
      new Error("internal-library-stack-trace-would-leak-here")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal error" });
    expect(body.error).not.toContain("internal-library-stack-trace");
  });

  it("handles synchronous throws from fetchCaptions (await coerces to rejection)", async () => {
    // Defense against a future refactor that drops `async` from
    // fetchCaptions — the route still awaits it so a sync throw still
    // routes through the catch.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(captionsLib, "fetchCaptions").mockImplementation(() => {
      throw new Error("sync-throw");
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
  });

  it("forwards `lang` to fetchCaptions when provided", async () => {
    // Validates the critical handoff: without this, lang is accepted by
    // the zod schema but silently dropped before reaching the library,
    // leaving the `tracks[0]` bug unfixed.
    const spy = vi
      .spyOn(captionsLib, "fetchCaptions")
      .mockResolvedValue(null);
    await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      lang: "fr",
    });
    expect(spy).toHaveBeenCalledWith(expect.any(String), "fr");
  });

  it("omits `lang` when the caller didn't send one (back-compat)", async () => {
    const spy = vi
      .spyOn(captionsLib, "fetchCaptions")
      .mockResolvedValue(null);
    await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    // Second arg is undefined — preserves pre-PR behavior where no lang
    // filter was applied.
    expect(spy).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});

describe("POST /captions — auth enforcement", () => {
  // Auth middleware is attached inside the sub-router, not at the app
  // level. Verify it actually fires on THIS path so a future refactor
  // that moves middleware can't silently expose the endpoint.
  beforeEach(() => {
    process.env.VPS_API_KEY = VALID_KEY;
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
