import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "fs/promises";
import {
  transcribeViaGroq,
  GroqTranscribeError,
} from "../groq-transcribe.js";

// Mock fs to avoid real disk reads; Groq receives whatever bytes we hand it.
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const validGroqBody = {
  language: "en",
  segments: [
    { start: 0, end: 1.5, text: " hello" },
    { start: 1.5, end: 3.0, text: "world " },
  ],
};

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("transcribeViaGroq", () => {
  beforeEach(() => {
    vi.stubEnv("GROQ_API_KEY", "test-key");
    mockedReadFile.mockResolvedValue(Buffer.from("fake-audio-bytes"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the audio file and parses Groq's verbose_json into our segment shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(validGroqBody)));

    const result = await transcribeViaGroq("/tmp/clip.mp3");

    expect(result.segments).toEqual([
      { text: "hello", start: 0, duration: 1.5 },
      { text: "world", start: 1.5, duration: 1.5 },
    ]);
    expect(result.language).toBe("en");
  });

  it("forwards lang as the `language` form field when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3", "fr");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("language")).toBe("fr");
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
    expect(formData.get("response_format")).toBe("verbose_json");
  });

  it("omits `language` from the form when no lang arg is provided", async () => {
    // Sending `language: undefined` would be rejected by Groq's strict
    // multipart parser (some shapes return 400, some silently ignore).
    // Omitting the field entirely lets Groq's auto-detect run.
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("language")).toBeNull();
  });

  it("retries once on 429 with backoff and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    const promise = transcribeViaGroq("/tmp/clip.mp3");
    // Advance through the 2s backoff so the second call fires.
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.segments.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("throws GroqTranscribeError(429) when both attempts return 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = transcribeViaGroq("/tmp/clip.mp3");
    const caught = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await caught;
    expect(err).toBeInstanceOf(GroqTranscribeError);
    expect(err).toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does NOT retry on 500 — throws GroqTranscribeError(500) immediately", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeViaGroq("/tmp/clip.mp3")).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies fetch network failures as status='network'", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("ECONNRESET"), { name: "TypeError" })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeViaGroq("/tmp/clip.mp3")).rejects.toMatchObject({
      status: "network",
    });
  });

  it("classifies AbortSignal.timeout as status='timeout'", async () => {
    const timeoutErr = new Error("aborted");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutErr));

    await expect(transcribeViaGroq("/tmp/clip.mp3")).rejects.toMatchObject({
      status: "timeout",
    });
  });

  it("throws status='schema' when Groq returns malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    await expect(transcribeViaGroq("/tmp/clip.mp3")).rejects.toMatchObject({
      status: "schema",
    });
  });

  it("throws status='schema' when Groq returns missing-segments payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ language: "en" }))
    );
    await expect(transcribeViaGroq("/tmp/clip.mp3")).rejects.toMatchObject({
      status: "schema",
    });
  });

  it("returns empty segments when every Groq segment is empty / whitespace", async () => {
    // Symmetric with the local-Whisper path: an all-whitespace response
    // is "no content," handled identically by the route's length check
    // at the bottom (WHISPER_EMPTY_RESULT → 500). Throwing here would
    // route through the Groq-failure catch and either fall back to
    // local (wasteful: same source audio, same outcome) or return 503
    // (misleading: Groq actually responded, just empty).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse({
          language: "en",
          segments: [
            { start: 0, end: 1, text: "   " },
            { start: 1, end: 2, text: "" },
          ],
        })
      )
    );
    const result = await transcribeViaGroq("/tmp/clip.mp3");
    expect(result.segments).toEqual([]);
    expect(result.language).toBe("en");
  });

  it("coerces a segment whose start > end to duration=0 (defensive)", async () => {
    // Groq's contract guarantees start ≤ end, but the impl applies
    // Math.max(0, end - start) defensively. Without this test, a future
    // refactor that drops the floor could silently produce negative
    // durations that break the frontend's clickable-timestamp math.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse({
          language: "en",
          segments: [
            { start: 5, end: 3, text: "weird" },
            { start: 10, end: 11, text: "normal" },
          ],
        })
      )
    );
    const result = await transcribeViaGroq("/tmp/clip.mp3");
    expect(result.segments).toEqual([
      { text: "weird", start: 5, duration: 0 },
      { text: "normal", start: 10, duration: 1 },
    ]);
  });
});
