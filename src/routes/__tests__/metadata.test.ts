import { describe, it, expect, vi, beforeEach } from "vitest";
import { metadata } from "../metadata.js";
import * as ytdlpMetadataLib from "../../lib/ytdlp-metadata.js";

const VALID_KEY = "test-key";

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

describe("POST /metadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VPS_API_KEY = VALID_KEY;
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await post({ not_the_right_field: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-YouTube URLs with 400", async () => {
    const res = await post({ youtube_url: "https://example.com/video" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400 (not 500)", async () => {
    const res = await metadata.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with language, title, description, availableCaptions on happy path", async () => {
    vi.spyOn(ytdlpMetadataLib, "fetchYtdlpMetadata").mockResolvedValue({
      title: "Comment apprendre",
      description: "Une vidéo en français",
      language: "fr",
      subtitles: {},
      automatic_captions: { fr: [{ url: "x", ext: "vtt" }], en: [{ url: "x", ext: "vtt" }] },
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.language).toBe("fr");
    expect(body.title).toBe("Comment apprendre");
    expect(body.description).toBe("Une vidéo en français");
    expect(body.availableCaptions).toEqual(expect.arrayContaining(["fr", "en"]));
  });

  it("returns 500 with a generic message when yt-dlp throws", async () => {
    // Internal stderr (paths, binary names, extractor internals) must not
    // leak to the client — same contract as /captions and /transcribe.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ytdlpMetadataLib, "fetchYtdlpMetadata").mockRejectedValue(
      new Error("yt-dlp metadata failed: /opt/tmp/internal/path/leaked")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Metadata fetch failed" });
    expect(JSON.stringify(body)).not.toContain("/opt/tmp");
  });
});

describe("POST /metadata — auth enforcement", () => {
  beforeEach(() => {
    process.env.VPS_API_KEY = VALID_KEY;
    vi.restoreAllMocks();
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await metadata.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
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
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(403);
  });
});
