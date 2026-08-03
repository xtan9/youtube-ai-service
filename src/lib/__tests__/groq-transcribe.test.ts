import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "fs/promises";
import * as audioCompress from "../audio-compress.js";
import {
  createGroqTranscriber,
  GroqTranscribeError,
} from "../groq-transcribe.js";
import type { GroqConfig } from "../runtime-config.js";
import { primaryLanguageCode as primary } from "../../test-support/language-tag.js";

// Mock fs to avoid real disk reads; Groq receives whatever bytes we hand it.
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock the I/O surfaces of audio-compress (compressForGroq, cleanupCompressed)
// without redefining AudioCompressError — vi.importActual preserves the real
// class so the prod `instanceof AudioCompressError` check at the call site
// is exercised against the actual class identity, not a test-local shadow.
vi.mock("../audio-compress.js", async () => {
  const actual = await vi.importActual<
    typeof import("../audio-compress.js")
  >("../audio-compress.js");
  return {
    ...actual,
    compressForGroq: vi.fn(),
    cleanupCompressed: vi.fn(),
  };
});

const mockedReadFile = vi.mocked(readFile);
const mockedCompress = vi.mocked(audioCompress.compressForGroq);
const mockedCleanup = vi.mocked(audioCompress.cleanupCompressed);
const COMPRESSED_PATH = "/tmp/groq-compressed.mp3";
const validGroqBody = {
  language: "en",
  segments: [
    { start: 0, end: 1.5, text: " hello" },
    { start: 1.5, end: 3.0, text: "world " },
  ],
};

const defaultConfig: GroqConfig = {
  apiKey: "test-key",
  model: "whisper-large-v3",
  timeoutMs: 180_000,
};

let transcribeViaGroq = createGroqTranscriber(defaultConfig);

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("transcribeViaGroq", () => {
  beforeEach(() => {
    transcribeViaGroq = createGroqTranscriber(defaultConfig);
    mockedReadFile.mockResolvedValue(Buffer.from("fake-audio-bytes"));
    mockedCompress.mockResolvedValue(COMPRESSED_PATH);
    mockedCleanup.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // vitest 4 changed `vi.restoreAllMocks()` to no longer clear mock call
    // history (it only restores `vi.spyOn` originals now). Call
    // `vi.clearAllMocks()` explicitly so the next test's `toHaveBeenCalled`
    // checks see only that test's calls.
    vi.restoreAllMocks();
    vi.clearAllMocks();
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

    await transcribeViaGroq("/tmp/clip.mp3", primary("fr"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("language")).toBe("fr");
    expect(formData.get("model")).toBe("whisper-large-v3");
    expect(formData.get("response_format")).toBe("verbose_json");
  });

  it("uses the configured Groq model", async () => {
    // The README actively recommends `GROQ_MODEL=whisper-large-v3-turbo`
    // for ops who want speed back. A typo in the env-read path
    // Ignoring the configured model would silently pin every prod request
    // to large-v3 regardless
    // — the kind of regression that's invisible until billing or
    // p95-latency dashboards surface it weeks later. Pin the override
    // here so a future refactor can't break it.
    transcribeViaGroq = createGroqTranscriber({
      ...defaultConfig,
      model: "whisper-large-v3-turbo",
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3", primary("en"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("uses the request work signal for compression, file I/O, and Groq fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3", undefined, controller.signal);

    expect(mockedCompress).toHaveBeenCalledWith(
      "/tmp/clip.mp3",
      controller.signal,
    );
    expect(mockedReadFile).toHaveBeenCalledWith(
      COMPRESSED_PATH,
      expect.objectContaining({ signal: controller.signal }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const fetchSignal = init.signal as AbortSignal;
    expect(fetchSignal.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal.aborted).toBe(true);
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

  it("sends a native-language `prompt` alongside `language` so the model doesn't drift", async () => {
    // Captured on video hrREdNm7vB4: with only `language=zh`, Groq's
    // hosted Whisper hallucinated English (and French "même") during
    // non-speech segments and propagated through subsequent chunks
    // via the model's internal prev-text conditioning. Groq's hosted
    // Whisper does not expose `condition_on_previous_text`, so the
    // `prompt` form field is the only available lever — a short
    // native-language anchor biases the output distribution every chunk
    // and stops the drift. Test asserts the anchor is non-empty and in
    // the target language so a future refactor can't drop the field
    // back to Whisper-default behavior.
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3", primary("zh"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    const prompt = formData.get("prompt");
    expect(typeof prompt).toBe("string");
    expect(prompt).toBeTruthy();
    // Anchor must contain CJK characters when lang=zh — proves it's a
    // native-language anchor, not the prior English-default fallback or
    // an empty placeholder.
    expect(prompt as string).toMatch(/[一-鿿]/);
    // Executable comment: Groq's hosted Whisper does not expose
    // `condition_on_previous_text`, so we must NOT send a field with
    // that name. A future engineer might assume it works and silently
    // bloat the multipart body for no effect — pin the absence so a
    // copy-paste from the local-Whisper fix can't slip in.
    expect(formData.get("condition_on_previous_text")).toBeNull();
  });

  it("omits `prompt` when no lang is provided (no language to anchor to)", async () => {
    // Without a target language we can't pick an anchor — sending an
    // English prompt would bias auto-detect toward English, the exact
    // failure mode we're trying to fix.
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("prompt")).toBeNull();
  });

  it("omits `prompt` for a lang we have no anchor for (falls through to language-only pinning)", async () => {
    // Strictly additive guard: an unknown ISO 639-1 code (Welsh, etc.)
    // skips the prompt rather than sending a wrong-language anchor that
    // would actively *cause* the bug we're fixing.
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3", primary("cy"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("language")).toBe("cy");
    expect(formData.get("prompt")).toBeNull();
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

  it("compresses before upload, reads only the compressed path, and uploads with a .mp3 filename", async () => {
    // Sanity-check that the compressed bytes (not the original) reach
    // Groq, AND that the filename Groq uses for format detection ends
    // in .mp3. See audio-compress.ts for the bitrate / 25 MB rationale.
    mockedReadFile.mockReset();
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (path === COMPRESSED_PATH) return Buffer.from("compressed-bytes");
      return Buffer.from("ORIGINAL-DO-NOT-UPLOAD");
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip-orig.mp3");

    expect(mockedCompress).toHaveBeenCalledWith(
      "/tmp/clip-orig.mp3",
      expect.any(AbortSignal),
    );
    expect(mockedReadFile).toHaveBeenCalledWith(
      COMPRESSED_PATH,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockedReadFile).not.toHaveBeenCalledWith("/tmp/clip-orig.mp3");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    const file = formData.get("file") as File;
    const sentBytes = Buffer.from(await file.arrayBuffer());
    expect(sentBytes.toString()).toBe("compressed-bytes");
    // Groq trusts the multipart filename extension for format detection,
    // so a regression that uploads compressed bytes under the original
    // (non-mp3) filename would silently break Groq. Pin .mp3.
    expect(file.name).toMatch(/\.mp3$/);
  });

  it("cleans up the compressed temp file even when Groq returns 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 }))
    );

    await expect(transcribeViaGroq("/tmp/clip.mp3")).rejects.toMatchObject({
      status: 500,
    });
    expect(mockedCleanup).toHaveBeenCalledWith(COMPRESSED_PATH);
  });

  it("cleans up the compressed temp file on the happy path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(validGroqBody)));

    await transcribeViaGroq("/tmp/clip.mp3");

    expect(mockedCleanup).toHaveBeenCalledWith(COMPRESSED_PATH);
  });

  it("throws GroqTranscribeError(status='compress') when re-encode fails, carrying the kind in the body excerpt", async () => {
    // ffmpeg failure is treated symmetrically with a Groq-side failure
    // so the route's catch can apply the same fallback rules. The kind
    // travels via bodyExcerpt so route logs distinguish missing-binary
    // (deploy regression) from ffmpeg-failed (bad input) from timeout.
    mockedCompress.mockRejectedValueOnce(
      new audioCompress.AudioCompressError(
        "ffmpeg-failed",
        "Invalid data found in input"
      )
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const err = await transcribeViaGroq("/tmp/clip.mp3").catch((e) => e);
    expect(err.status).toBe("compress");
    expect(err.bodyExcerpt).toContain("ffmpeg-failed");
    expect(err.bodyExcerpt).toContain("Invalid data");
    expect(fetchMock).not.toHaveBeenCalled();
    // No compressed file was produced, so cleanup must not be called
    // with a stale value.
    expect(mockedCleanup).not.toHaveBeenCalled();
  });

  it("exposes the AudioCompressError kind as a typed compressKind on GroqTranscribeError (so route discriminator doesn't depend on bodyExcerpt prefix)", async () => {
    // Belt-and-suspenders pin on the throw-site contract: the route's
    // fatal-upstream discriminator now reads err.compressKind instead
    // of prefix-matching err.bodyExcerpt, so a future drift here (kind
    // not propagated, or wrong kind propagated) would silently
    // re-classify production failures from no-fallback to fallback.
    // This test fails immediately on that drift.
    mockedCompress.mockRejectedValueOnce(
      new audioCompress.AudioCompressError(
        "missing-binary",
        "spawn ffmpeg ENOENT"
      )
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const err = await transcribeViaGroq("/tmp/clip.mp3").catch((e) => e);
    expect(err).toBeInstanceOf(GroqTranscribeError);
    expect(err.status).toBe("compress");
    expect(err.compressKind).toBe("missing-binary");
    expect(fetchMock).not.toHaveBeenCalled();
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
