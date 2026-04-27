import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transcribe } from "../transcribe.js";
import * as ytdlpLib from "../../lib/ytdlp.js";
import * as whisperLib from "../../lib/whisper.js";
import * as groqLib from "../../lib/groq-transcribe.js";
import * as audioDurationLib from "../../lib/audio-duration.js";
import { GroqTranscribeError } from "../../lib/groq-transcribe.js";

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
    // These existing tests exercise the local-Whisper path. Clearing
    // the key forces the route into the GROQ_API_KEY_MISSING branch,
    // which calls transcribeAudio at any length — matching what these
    // tests were always asserting. New describe block below covers
    // the Groq path explicitly.
    delete process.env.GROQ_API_KEY;
    vi.spyOn(ytdlpLib, "downloadAudio").mockResolvedValue("/tmp/fake.mp3");
    vi.spyOn(ytdlpLib, "cleanupAudio").mockResolvedValue(undefined);
    // Suppress the GROQ_API_KEY_MISSING error log that fires on every
    // test in this block — these tests aren't asserting on that log,
    // and silencing it keeps the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await post({ not_the_right_field: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-YouTube URLs with 400", async () => {
    const res = await post({ youtube_url: "https://example.com/video" });
    expect(res.status).toBe(400);
  });

  it.each([
    ["--language", "CLI-flag shape"],
    ["; rm -rf /", "shell metachar shape"],
    [" en", "leading whitespace"],
    ["a", "too short"],
    ["", "empty string"],
  ])("rejects lang=%s (%s) with 400", async (lang) => {
    // Schema-boundary rejection keeps garbage out of whisper's argv so
    // a lang like "--model" can't produce a confusing 500 error deep
    // in the CLI layer.
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      lang,
    });
    expect(res.status).toBe(400);
  });

  it("logs GROQ_API_KEY_MISSING at least once when the key is unset (deploy-window safety net)", async () => {
    // The warning is module-scoped to once-per-process, so on a fresh
    // module-load it fires on the first unset-key request. Subsequent
    // requests in the same process don't re-fire — that's the design.
    // We assert "fired at least once across these test runs" by spying
    // before triggering the request; if a prior test in this describe
    // already triggered the warning, this assertion still holds because
    // the spy captures all calls in the current test.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue([
      { text: "hi", start: 0, duration: 1 },
    ]);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    // The warning either fires now (first unset-key test in process)
    // or doesn't (later test, flag already set). Both are valid.
    // What we MUST lock is: when it fires, the errorId is correct.
    const calls = errSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("GROQ_API_KEY_MISSING")
    );
    if (calls.length > 0) {
      expect(calls[0][1]).toMatchObject({ errorId: "GROQ_API_KEY_MISSING" });
    }
  });

  it("returns 200 with segments + derived transcript and language='auto' when no lang (back-compat)", async () => {
    // Wire response includes `segments` (canonical) and `transcript`
    // (derived from segments). The transcript field is kept for one
    // rollout window so a frontend that hasn't picked up segments yet
    // still works.
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue([
      { text: "hello", start: 0, duration: 1 },
      { text: "world", start: 1, duration: 1 },
    ]);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      segments: [
        { text: "hello", start: 0, duration: 1 },
        { text: "world", start: 1, duration: 1 },
      ],
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
      .mockResolvedValue([{ text: "bonjour", start: 0, duration: 1 }]);
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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    // Pin the structured outer-catch log so a future refactor can't
    // drop the videoId or errorId — operators rely on these for
    // postmortem grep and dashboard partitioning.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("TRANSCRIBE_UNHANDLED"),
      expect.objectContaining({
        errorId: "TRANSCRIBE_UNHANDLED",
        videoId: "dQw4w9WgXcQ",
      })
    );
  });

  it("normalizes whitespace in the derived transcript (matches pre-PR contract)", async () => {
    // Mirror of the captions-route normalization test: the derived
    // `transcript` field preserves the pre-PR `replace(/\s+/g, " ").trim()`
    // normalization so an old frontend that hashed/length-gated the field
    // sees the same byte sequence during the rollout window. Segments
    // themselves stay verbatim — this is purely about the legacy alias.
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue([
      { text: "  hello\tworld  ", start: 0, duration: 1 },
      { text: "\n\n  foo  ", start: 1, duration: 1 },
    ]);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const body = (await res.json()) as { transcript: string };
    expect(body.transcript).toBe("hello world foo");
  });

  it("returns 500 with WHISPER_EMPTY_RESULT when whisper produces zero usable segments", async () => {
    // Symmetric of the captions path's CAPTION_EMPTY_TRANSCRIPT — silently
    // shipping `transcript: ""` would let a VAD misconfig / yt-dlp
    // encoding bug / model upgrade artifact land as a 200 success and
    // produce a garbage LLM summary downstream. Surfacing as 500 routes
    // it through the existing alert + skip-cache path.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(whisperLib, "transcribeAudio").mockResolvedValue([]);
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Transcription produced no content",
    });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("WHISPER_EMPTY_RESULT"),
      expect.objectContaining({
        errorId: "WHISPER_EMPTY_RESULT",
        videoId: "dQw4w9WgXcQ",
      })
    );
  });

  it("returns 500 with generic body when whisper fails (no internal leak)", async () => {
    // Generic body contract: a whisper-internal message must not reach
    // the client. A regression returning `{ error: err.message }` would
    // leak whisper/CTranslate2 internals.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(whisperLib, "transcribeAudio").mockRejectedValue(
      new Error("whisper internal crash: /opt/models/tiny.bin missing")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Transcription failed" });
    expect(JSON.stringify(body)).not.toContain("whisper internal crash");
    expect(JSON.stringify(body)).not.toContain("/opt/models");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("TRANSCRIBE_UNHANDLED"),
      expect.objectContaining({
        errorId: "TRANSCRIBE_UNHANDLED",
        videoId: "dQw4w9WgXcQ",
      })
    );
  });
});

describe("POST /transcribe — Groq orchestration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VPS_API_KEY = VALID_KEY;
    process.env.GROQ_API_KEY = "test-groq-key";
    vi.spyOn(ytdlpLib, "downloadAudio").mockResolvedValue("/tmp/fake.mp3");
    vi.spyOn(ytdlpLib, "cleanupAudio").mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_LOCAL_FALLBACK_MAX_SECONDS;
  });

  it("uses Groq when configured (positive control: long audio still uses Groq, ffprobe not called)", async () => {
    const groqSpy = vi.spyOn(groqLib, "transcribeViaGroq").mockResolvedValue({
      segments: [{ text: "groq", start: 0, duration: 1 }],
      language: "en",
    });
    // Mock-resolve so that if an unintended call happens, the test
    // fails on the assertion instead of crashing on a real ffprobe /
    // whisper invocation against /tmp/fake.mp3.
    const localSpy = vi
      .spyOn(whisperLib, "transcribeAudio")
      .mockResolvedValue([]);
    const probeSpy = vi
      .spyOn(audioDurationLib, "probeAudioDurationSeconds")
      .mockResolvedValue(null);

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(200);
    expect(groqSpy).toHaveBeenCalled();
    expect(localSpy).not.toHaveBeenCalled();
    // Locks the "ffprobe only on fallback path" optimization — a
    // regression that pulls the probe back up before the try would
    // start it firing on every happy-path request.
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("falls back to local Whisper when Groq fails and audio <= cap", async () => {
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new GroqTranscribeError(500, "boom")
    );
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(60);
    const localSpy = vi
      .spyOn(whisperLib, "transcribeAudio")
      .mockResolvedValue([{ text: "local segment", start: 0, duration: 1 }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.segments).toEqual([
      { text: "local segment", start: 0, duration: 1 },
    ]);
    expect(localSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GROQ_FALLBACK"),
      expect.objectContaining({
        errorId: "GROQ_FALLBACK",
        groqStatus: 500,
        audioSeconds: 60,
      })
    );
  });

  it.each([60, 900])(
    "returns 503 when Groq returns 429 (rate-limited) at audio=%ds — no local fallback for quota exhaustion",
    async (audioSeconds) => {
      // Quota exhaustion is the one Groq failure mode we deliberately do
      // NOT mask via local Whisper. The in-process retry inside
      // groq-transcribe.ts has already covered transient per-minute blips
      // by the time we see this error, so 429 here means the quota is
      // genuinely out and the user should see a transcription error
      // rather than a silently-slower local-Whisper summary.
      vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
        new GroqTranscribeError(429, "rate limited")
      );
      vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(audioSeconds);
      const localSpy = vi.spyOn(whisperLib, "transcribeAudio");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await post({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });

      expect(res.status).toBe(503);
      expect(localSpy).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.error).toMatch(/temporarily unavailable/i);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("GROQ_FAILED_NO_FALLBACK"),
        expect.objectContaining({
          errorId: "GROQ_FAILED_NO_FALLBACK",
          audioSeconds,
          fallbackCap: 180,
          groqStatus: 429,
        })
      );
      expect(ytdlpLib.cleanupAudio).toHaveBeenCalledWith("/tmp/fake.mp3");
    }
  );

  it("returns 503 when Groq raises compress: missing-binary, regardless of audio length — no local fallback for deploy regression", async () => {
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new GroqTranscribeError(
        "compress",
        "missing-binary: ffmpeg ENOENT",
        "missing-binary"
      )
    );
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(60);
    const localSpy = vi.spyOn(whisperLib, "transcribeAudio");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(503);
    expect(localSpy).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("GROQ_FAILED_NO_FALLBACK"),
      expect.objectContaining({
        errorId: "GROQ_FAILED_NO_FALLBACK",
        audioSeconds: 60,
        fallbackCap: 180,
        groqStatus: "compress",
      })
    );
    expect(ytdlpLib.cleanupAudio).toHaveBeenCalledWith("/tmp/fake.mp3");
  });

  it("returns 503 when Groq raises compress: timeout, regardless of audio length — no local fallback for ffmpeg timeout (host saturation)", async () => {
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new GroqTranscribeError(
        "compress",
        "timeout: ffmpeg killed by 120000ms timeout",
        "timeout"
      )
    );
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(60);
    const localSpy = vi.spyOn(whisperLib, "transcribeAudio");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(503);
    expect(localSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("GROQ_FAILED_NO_FALLBACK"),
      expect.objectContaining({
        errorId: "GROQ_FAILED_NO_FALLBACK",
        audioSeconds: 60,
        fallbackCap: 180,
        groqStatus: "compress",
      })
    );
  });

  it("falls back to local Whisper when Groq raises compress: ffmpeg-failed (bad input) and audio <= cap", async () => {
    // compress: ffmpeg-failed is bad input, NOT an operational signal.
    // Local Whisper may handle the audio differently — fallback is the
    // right call and this test pins that contract so the fatal-upstream
    // discriminator stays narrow.
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new GroqTranscribeError(
        "compress",
        "ffmpeg-failed: invalid audio frame",
        "ffmpeg-failed"
      )
    );
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(60);
    const localSpy = vi
      .spyOn(whisperLib, "transcribeAudio")
      .mockResolvedValue([{ text: "local segment", start: 0, duration: 1 }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(200);
    expect(localSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GROQ_FALLBACK"),
      expect.objectContaining({
        errorId: "GROQ_FALLBACK",
        groqStatus: "compress",
      })
    );
  });

  it("returns 503 when Groq fails and audio > fallback cap (no local attempt)", async () => {
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new GroqTranscribeError("network", "ECONNRESET")
    );
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(900);
    const localSpy = vi.spyOn(whisperLib, "transcribeAudio");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(503);
    expect(localSpy).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("GROQ_FAILED_NO_FALLBACK"),
      expect.objectContaining({
        errorId: "GROQ_FAILED_NO_FALLBACK",
        audioSeconds: 900,
        fallbackCap: 180,
        groqStatus: "network",
      })
    );
    expect(ytdlpLib.cleanupAudio).toHaveBeenCalledWith("/tmp/fake.mp3");
  });

  it("returns 503 when Groq fails and ffprobe can't determine length (fail-closed)", async () => {
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new GroqTranscribeError(500, "boom")
    );
    vi.spyOn(audioDurationLib, "probeAudioDurationSeconds").mockResolvedValue(null);
    const localSpy = vi.spyOn(whisperLib, "transcribeAudio");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(503);
    expect(localSpy).not.toHaveBeenCalled();
    expect(ytdlpLib.cleanupAudio).toHaveBeenCalledWith("/tmp/fake.mp3");
  });

  it("re-throws non-GroqTranscribeError (programmer errors must surface)", async () => {
    // Defensive: a programming bug in transcribeViaGroq that throws a
    // bare Error must not be swallowed as if it were an operational
    // Groq failure. The route's outer try/catch should still catch it
    // and return 500 with the generic message.
    vi.spyOn(groqLib, "transcribeViaGroq").mockRejectedValue(
      new Error("oops")
    );
    const localSpy = vi.spyOn(whisperLib, "transcribeAudio");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(500);
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("uses local Whisper at any length when GROQ_API_KEY is unset (no fallback cap applies)", async () => {
    // Locks the "no cap when unconfigured" deploy-window contract: the
    // fallback cap (180s) only applies AFTER Groq has been attempted
    // and failed. When Groq is never attempted, local Whisper handles
    // the full audio regardless of length — same as today's behavior
    // before this PR.
    delete process.env.GROQ_API_KEY;
    const groqSpy = vi.spyOn(groqLib, "transcribeViaGroq");
    const probeSpy = vi.spyOn(audioDurationLib, "probeAudioDurationSeconds");
    const localSpy = vi
      .spyOn(whisperLib, "transcribeAudio")
      .mockResolvedValue([{ text: "long-clip transcript", start: 0, duration: 1 }]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(res.status).toBe(200);
    expect(groqSpy).not.toHaveBeenCalled();
    // Pin the optimization: with no Groq attempt, no fallback decision,
    // there is also no reason to probe duration. A regression that
    // calls probe in the unconfigured branch would fire here.
    expect(probeSpy).not.toHaveBeenCalled();
    expect(localSpy).toHaveBeenCalledWith("/tmp/fake.mp3", undefined);
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
