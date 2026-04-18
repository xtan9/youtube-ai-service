import { describe, it, expect, vi, beforeEach } from "vitest";
import { captions } from "../captions.js";
import * as captionsLib from "../../lib/captions.js";

function post(body: unknown) {
  return captions.request("/captions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /captions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await post({ not_the_right_field: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-URL values with 400 (zod .url() guard)", async () => {
    const res = await post({ youtube_url: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("returns 404 with a stable error code when no captions are available", async () => {
    // The frontend's fallback logic depends on a distinct 404 status so it
    // can route to /transcribe without surfacing an error to the user.
    // A flakier 500 here would double-up alerts and mask real failures.
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

  it("returns 500 (not 404) when the library throws unexpectedly", async () => {
    // The route differentiates these because 500 triggers alerts upstream
    // while 404 is the normal "no captions" fallback path.
    vi.spyOn(captionsLib, "fetchCaptions").mockRejectedValue(
      new Error("network-fubar")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
  });
});
