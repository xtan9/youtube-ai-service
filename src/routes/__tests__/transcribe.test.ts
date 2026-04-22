import { describe, it, expect, vi, beforeEach } from "vitest";
import { transcribe } from "../transcribe.js";
import * as ytdlpLib from "../../lib/ytdlp.js";
import * as whisperLib from "../../lib/whisper.js";

const VALID_KEY = "test-key";

function post(body: unknown) {
  return transcribe.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /transcribe", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VPS_API_KEY = VALID_KEY;
    vi.spyOn(ytdlpLib, "downloadAudio").mockResolvedValue("/tmp/fake.mp3");
    vi.spyOn(ytdlpLib, "cleanupAudio").mockResolvedValue(undefined);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await post({ not_the_right_field: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-YouTube URLs with 400", async () => {
    const res = await post({ youtube_url: "https://example.com/video" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with language='auto' when no lang provided (back-compat)", async () => {
    // Pre-PR clients send `{youtube_url}` only and expect `language: "auto"`
    // in the response. Preserve that exact shape.
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue("hello world");
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transcript: "hello world",
      language: "auto",
      source: "whisper",
    });
  });

  it("forwards `lang` to transcribeAudio and echoes it in the response", async () => {
    // Validates the handoff: a lang accepted by the zod schema must
    // actually reach whisper. Without this check, the flag could be
    // silently dropped and whisper would keep auto-detecting.
    const spy = vi
      .spyOn(whisperLib, "transcribeAudio")
      .mockResolvedValue("bonjour");
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      lang: "fr",
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith("/tmp/fake.mp3", "fr");
    const body = await res.json();
    expect(body.language).toBe("fr");
  });

  it("returns 500 when yt-dlp download fails (no language echoed, no transcript leak)", async () => {
    // Real yt-dlp stderr includes tmp paths and extractor internals; make
    // sure none of it escapes into the response body.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ytdlpLib, "downloadAudio").mockRejectedValue(
      new Error("yt-dlp failed: /opt/tmp/internal-path /tmp/leak.mp3")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Transcription failed" });
    expect(JSON.stringify(body)).not.toContain("/opt/tmp");
  });

  it("returns 500 when whisper fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(whisperLib, "transcribeAudio").mockRejectedValue(
      new Error("whisper crash")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /transcribe — auth enforcement", () => {
  beforeEach(() => {
    process.env.VPS_API_KEY = VALID_KEY;
    vi.restoreAllMocks();
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await transcribe.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 on a wrong bearer token", async () => {
    const res = await transcribe.request("/", {
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
