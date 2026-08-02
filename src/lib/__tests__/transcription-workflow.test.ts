import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionWorkflow,
  type TranscriptionWorkflowDependencies,
  type TranscriptionWorkflowInput,
} from "../transcription-workflow.js";
import { AudioDownloadError, AudioMediaLimitError } from "../ytdlp.js";
import { GroqTranscribeError } from "../groq-transcribe.js";
import { LocalTranscriptionError } from "../whisper.js";

const INPUT: TranscriptionWorkflowInput = {
  youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  language: undefined,
  signal: new AbortController().signal,
  limits: {
    mediaMaxBytes: 50_000_000,
    mediaMaxDurationSeconds: 1_800,
  },
  correlation: {
    requestId: "workflow-request-id",
    videoId: "dQw4w9WgXcQ",
  },
};

function dependencies(
  overrides: Partial<TranscriptionWorkflowDependencies> = {}
): TranscriptionWorkflowDependencies {
  return {
    createAudioPath: vi.fn().mockReturnValue("/tmp/audio.mp3"),
    downloadAudio: vi.fn().mockResolvedValue(undefined),
    cleanupAudio: vi.fn().mockResolvedValue(undefined),
    probeAudioDurationSeconds: vi.fn().mockResolvedValue(60),
    transcribeViaGroq: vi.fn(),
    transcribeLocally: vi
      .fn()
      .mockResolvedValue([{ text: "hello", start: 0, duration: 1 }]),
    isGroqConfigured: vi.fn().mockReturnValue(false),
    readLocalFallbackMaxSeconds: vi.fn().mockReturnValue(180),
    logEvent: vi.fn(),
    ...overrides,
  };
}

describe("transcription workflow", () => {
  it("completes a transcription with the local backend", async () => {
    const run = createTranscriptionWorkflow(dependencies());

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: true,
      segments: [{ text: "hello", start: 0, duration: 1 }],
    });
  });

  it("passes the request work signal through every active stage", async () => {
    const deps = dependencies();
    const run = createTranscriptionWorkflow(deps);

    await run(INPUT);

    expect({
      download: vi.mocked(deps.downloadAudio).mock.calls,
      duration: vi.mocked(deps.probeAudioDurationSeconds).mock.calls,
      local: vi.mocked(deps.transcribeLocally).mock.calls,
    }).toEqual({
      download: [
        [
          INPUT.youtubeUrl,
          "/tmp/audio.mp3",
          INPUT.limits.mediaMaxBytes,
          INPUT.signal,
        ],
      ],
      duration: [["/tmp/audio.mp3", INPUT.signal]],
      local: [["/tmp/audio.mp3", undefined, INPUT.signal]],
    });
  });

  it("classifies media with an unknown duration", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(null),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: "media-duration-unknown",
    });
  });

  it("classifies media beyond the processing duration limit", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(1_800.1),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: "media-duration-exceeded",
    });
  });

  it("classifies media beyond the processing size limit", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        downloadAudio: vi
          .fn()
          .mockRejectedValue(new AudioMediaLimitError(50_000_001, 50_000_000)),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: "media-size-exceeded",
    });
  });

  it("classifies failed acquisition and cleans any partial media", async () => {
    const cleanupAudio = vi.fn().mockResolvedValue(undefined);
    const run = createTranscriptionWorkflow(
      dependencies({
        downloadAudio: vi
          .fn()
          .mockRejectedValue(new AudioDownloadError("yt-dlp failed")),
        cleanupAudio,
      })
    );

    const outcome = await run(INPUT);

    expect({ outcome, cleaned: cleanupAudio.mock.calls }).toEqual({
      outcome: { ok: false, reason: "transcription-failed" },
      cleaned: [["/tmp/audio.mp3"]],
    });
  });

  it("classifies a routine local backend failure", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        transcribeLocally: vi
          .fn()
          .mockRejectedValue(new LocalTranscriptionError("CLI failed")),
        logEvent,
      })
    );

    const outcome = await run(INPUT);

    expect({ outcome, failureEvent: logEvent.mock.calls.at(-1) }).toEqual({
      outcome: {
        ok: false,
        reason: "transcription-failed",
      },
      failureEvent: [
        "error",
        "transcribe.TRANSCRIPTION_FAILED",
        {
          errorId: "TRANSCRIPTION_FAILED",
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
          stage: "local-transcription",
          errorName: "LocalTranscriptionError",
        },
      ],
    });
  });

  it("completes a transcription with the configured Groq backend", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        transcribeViaGroq: vi.fn().mockResolvedValue({
          segments: [{ text: "groq result", start: 0, duration: 1 }],
          language: "en",
        }),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: true,
      segments: [{ text: "groq result", start: 0, duration: 1 }],
    });
  });

  it("completes a short transcription locally after an eligible Groq failure", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(500, "upstream failure")),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: true,
      segments: [{ text: "hello", start: 0, duration: 1 }],
    });
  });

  it("does not use the local backend above the fallback cap", async () => {
    const transcribeLocally = vi.fn();
    const cleanupAudio = vi.fn().mockResolvedValue(undefined);
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(181),
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError("network", "reset")),
        transcribeLocally,
        cleanupAudio,
      })
    );

    const outcome = await run(INPUT);

    expect({
      outcome,
      localCalls: transcribeLocally.mock.calls,
      cleanupCalls: cleanupAudio.mock.calls,
    }).toEqual({
      outcome: { ok: false, reason: "temporarily-unavailable" },
      localCalls: [],
      cleanupCalls: [["/tmp/audio.mp3"]],
    });
  });

  it("uses the local backend for a short input-shaped compression failure", async () => {
    const transcribeLocally = vi
      .fn()
      .mockResolvedValue([{ text: "local result", start: 0, duration: 1 }]);
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        transcribeViaGroq: vi.fn().mockRejectedValue(
          new GroqTranscribeError(
            "compress",
            "invalid audio frame",
            "ffmpeg-failed"
          )
        ),
        transcribeLocally,
      })
    );

    const outcome = await run(INPUT);

    expect({ outcome, localCalls: transcribeLocally.mock.calls }).toEqual({
      outcome: {
        ok: true,
        segments: [{ text: "local result", start: 0, duration: 1 }],
      },
      localCalls: [["/tmp/audio.mp3", undefined, INPUT.signal]],
    });
  });

  it("classifies Groq quota exhaustion as temporarily unavailable", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(429, "rate limited")),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: "temporarily-unavailable",
    });
  });

  it.each(["missing-binary", "timeout", undefined] as const)(
    "classifies operational compression failure %s as temporarily unavailable",
    async (compressKind) => {
      const run = createTranscriptionWorkflow(
        dependencies({
          isGroqConfigured: vi.fn().mockReturnValue(true),
          transcribeViaGroq: vi.fn().mockRejectedValue(
            new GroqTranscribeError(
              "compress",
              "compression failed",
              compressKind
            )
          ),
        })
      );

      const outcome = await run(INPUT);

      expect(outcome).toEqual({
        ok: false,
        reason: "temporarily-unavailable",
      });
    }
  );

  it("classifies an empty backend result", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        transcribeLocally: vi.fn().mockResolvedValue([]),
      })
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: false,
      reason: "empty-result",
    });
  });

  it("emits the local transcription lifecycle", async () => {
    const events: Array<{
      level: string;
      event: string;
      fields?: Record<string, unknown>;
    }> = [];
    const run = createTranscriptionWorkflow(
      dependencies({
        logEvent: (level, event, fields) => {
          events.push({ level, event, fields });
        },
      })
    );

    await run(INPUT);

    expect(events).toEqual([
      {
        level: "info",
        event: "transcribe.start",
        fields: {
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
          lang: undefined,
        },
      },
      {
        level: "info",
        event: "transcribe.audio_downloaded",
        fields: {
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
        },
      },
      {
        level: "error",
        event: "transcribe.GROQ_API_KEY_MISSING",
        fields: {
          errorId: "GROQ_API_KEY_MISSING",
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
        },
      },
      {
        level: "info",
        event: "transcribe.complete",
        fields: {
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
          segmentCount: 1,
        },
      },
    ]);
  });

  it("preserves the primary outcome when downloaded-media cleanup fails", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        cleanupAudio: vi.fn().mockRejectedValue(new Error("EBUSY")),
        logEvent,
      })
    );

    const outcome = await run(INPUT);

    expect({ outcome, cleanupEvent: logEvent.mock.calls.at(-1) }).toEqual({
      outcome: {
        ok: true,
        segments: [{ text: "hello", start: 0, duration: 1 }],
      },
      cleanupEvent: [
        "warn",
        "transcribe.CLEANUP_AUDIO_FAILED",
        {
          errorId: "CLEANUP_AUDIO_FAILED",
          requestId: "workflow-request-id",
          videoId: "dQw4w9WgXcQ",
          errorName: "Error",
        },
      ],
    });
  });

  it("rethrows an unexpected defect after emitting a safe failure event", async () => {
    const failure = new Error("internal path must not be logged");
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        transcribeLocally: vi.fn().mockRejectedValue(failure),
        logEvent,
      })
    );

    await expect(run(INPUT)).rejects.toBe(failure);
    expect(logEvent.mock.calls.at(-1)).toEqual([
      "error",
      "transcribe.TRANSCRIBE_UNHANDLED",
      {
        errorId: "TRANSCRIBE_UNHANDLED",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
        errorName: "Error",
      },
    ]);
  });

  it("emits a stable event when media duration is unknown", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(null),
        logEvent,
      })
    );

    await run(INPUT);

    expect(logEvent.mock.calls.at(-1)).toEqual([
      "warn",
      "transcribe.MEDIA_DURATION_UNKNOWN",
      {
        errorId: "MEDIA_DURATION_UNKNOWN",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
      },
    ]);
  });

  it("emits a stable event when media exceeds the duration limit", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(1_800.1),
        logEvent,
      })
    );

    await run(INPUT);

    expect(logEvent.mock.calls.at(-1)).toEqual([
      "info",
      "transcribe.MEDIA_DURATION_EXCEEDED",
      {
        errorId: "MEDIA_DURATION_EXCEEDED",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
        audioSeconds: 1_800.1,
      },
    ]);
  });

  it("emits a stable event when media exceeds the size limit", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        downloadAudio: vi
          .fn()
          .mockRejectedValue(new AudioMediaLimitError(50_000_001, 50_000_000)),
        logEvent,
      })
    );

    await run(INPUT);

    expect(logEvent.mock.calls.at(-1)).toEqual([
      "info",
      "transcribe.MEDIA_SIZE_EXCEEDED",
      {
        errorId: "MEDIA_SIZE_EXCEEDED",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
      },
    ]);
  });

  it("emits a stable event when Groq falls back to local transcription", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(500, "upstream failure")),
        logEvent,
      })
    );

    await run(INPUT);

    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "transcribe.GROQ_FALLBACK",
      {
        errorId: "GROQ_FALLBACK",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
        audioSeconds: 60,
        groqStatus: 500,
        compressKind: undefined,
      }
    );
  });

  it("emits a stable event when Groq cannot fall back", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        isGroqConfigured: vi.fn().mockReturnValue(true),
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(429, "rate limited")),
        logEvent,
      })
    );

    await run(INPUT);

    expect(logEvent.mock.calls.at(-1)).toEqual([
      "error",
      "transcribe.GROQ_FAILED_NO_FALLBACK",
      {
        errorId: "GROQ_FAILED_NO_FALLBACK",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
        audioSeconds: 60,
        fallbackCap: 180,
        groqStatus: 429,
        compressKind: undefined,
      },
    ]);
  });

  it("emits a stable event when transcription produces no content", async () => {
    const logEvent = vi.fn();
    const run = createTranscriptionWorkflow(
      dependencies({
        transcribeLocally: vi.fn().mockResolvedValue([]),
        logEvent,
      })
    );

    await run(INPUT);

    expect(logEvent.mock.calls.at(-1)).toEqual([
      "error",
      "transcribe.WHISPER_EMPTY_RESULT",
      {
        errorId: "WHISPER_EMPTY_RESULT",
        requestId: "workflow-request-id",
        videoId: "dQw4w9WgXcQ",
      },
    ]);
  });
});
