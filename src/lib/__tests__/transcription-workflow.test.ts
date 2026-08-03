import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionWorkflow as createWorkflowWithPolicy,
  type TranscriptionWorkflowDependencies,
  type TranscriptionWorkflowInput,
  type TranscriptionWorkflowPolicy,
} from "../transcription-workflow.js";
import { AudioDownloadError, AudioMediaLimitError } from "../ytdlp.js";
import { GroqTranscribeError } from "../groq-transcribe.js";
import { LocalTranscriptionError } from "../whisper.js";
import { primaryLanguageCode as primary } from "../../test-support/language-tag.js";

const LOCAL_ONLY_POLICY: Extract<
  TranscriptionWorkflowPolicy,
  { backend: "local-only" }
> = {
  backend: "local-only",
  mediaMaxBytes: 50_000_000,
  mediaMaxDurationSeconds: 1_800,
};

function localOnlyPolicy(
  overrides: Partial<Omit<typeof LOCAL_ONLY_POLICY, "backend">> = {},
): typeof LOCAL_ONLY_POLICY {
  return { ...LOCAL_ONLY_POLICY, ...overrides };
}

type GroqFirstPolicy = Extract<
  TranscriptionWorkflowPolicy,
  { backend: "groq-first" }
>;

function groqFirstPolicy(
  overrides: Partial<Omit<GroqFirstPolicy, "backend">> = {},
): GroqFirstPolicy {
  return {
    backend: "groq-first",
    mediaMaxBytes: 50_000_000,
    mediaMaxDurationSeconds: 1_800,
    localFallbackMaxSeconds: 180,
    transcribeViaGroq: vi.fn().mockResolvedValue({
      segments: [{ text: "groq result", start: 0, duration: 1 }],
      language: "en",
    }),
    ...overrides,
  };
}

const INPUT: TranscriptionWorkflowInput = {
  youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  language: undefined,
  signal: new AbortController().signal,
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
    transcribeLocally: vi
      .fn()
      .mockResolvedValue([{ text: "hello", start: 0, duration: 1 }]),
    logEvent: vi.fn(),
    ...overrides,
  };
}

function createTranscriptionWorkflow(
  workflowDependencies: TranscriptionWorkflowDependencies,
  policy: TranscriptionWorkflowPolicy = LOCAL_ONLY_POLICY,
) {
  return createWorkflowWithPolicy(workflowDependencies, policy);
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

  it("forwards a pinned Primary Language Code to local transcription", async () => {
    const transcribeLocally = vi
      .fn()
      .mockResolvedValue([{ text: "bonjour", start: 0, duration: 1 }]);
    const language = primary("fr");
    const run = createTranscriptionWorkflow(
      dependencies({ transcribeLocally }),
    );

    await run({ ...INPUT, language });

    expect(transcribeLocally).toHaveBeenCalledWith(
      "/tmp/audio.mp3",
      language,
      INPUT.signal,
    );
  });

  it("forwards a pinned Primary Language Code to Groq transcription", async () => {
    const transcribeViaGroq = vi.fn().mockResolvedValue({
      segments: [{ text: "bonjour", start: 0, duration: 1 }],
      language: "fr",
    });
    const language = primary("fr");
    const run = createTranscriptionWorkflow(
      dependencies(),
      groqFirstPolicy({ transcribeViaGroq }),
    );

    await run({ ...INPUT, language });

    expect(transcribeViaGroq).toHaveBeenCalledWith(
      "/tmp/audio.mp3",
      language,
      INPUT.signal,
    );
  });

  it("does not apply the Groq fallback cap to primary local transcription", async () => {
    const transcribeLocally = vi
      .fn()
      .mockResolvedValue([{ text: "long local result", start: 0, duration: 1 }]);
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(181),
        transcribeLocally,
      }),
      localOnlyPolicy({ mediaMaxDurationSeconds: 1_800 }),
    );

    const outcome = await run(INPUT);

    expect({ outcome, localCalls: transcribeLocally.mock.calls }).toEqual({
      outcome: {
        ok: true,
        segments: [{ text: "long local result", start: 0, duration: 1 }],
      },
      localCalls: [["/tmp/audio.mp3", undefined, INPUT.signal]],
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
          LOCAL_ONLY_POLICY.mediaMaxBytes,
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

  it("uses the duration policy supplied when the workflow is constructed", async () => {
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(61),
      }),
      localOnlyPolicy({ mediaMaxDurationSeconds: 60 }),
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
      }),
      groqFirstPolicy({
        transcribeViaGroq: vi.fn().mockResolvedValue({
          segments: [{ text: "groq result", start: 0, duration: 1 }],
          language: "en",
        }),
      }),
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: true,
      segments: [{ text: "groq result", start: 0, duration: 1 }],
    });
  });

  it("completes a short transcription locally after an eligible Groq failure", async () => {
    const run = createTranscriptionWorkflow(
      dependencies(),
      groqFirstPolicy({
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(500, "upstream failure")),
      }),
    );

    const outcome = await run(INPUT);

    expect(outcome).toEqual({
      ok: true,
      segments: [{ text: "hello", start: 0, duration: 1 }],
    });
  });

  it("keeps media exactly at the fallback cap eligible", async () => {
    const transcribeLocally = vi
      .fn()
      .mockResolvedValue([{ text: "boundary result", start: 0, duration: 1 }]);
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(180),
        transcribeLocally,
      }),
      groqFirstPolicy({
        localFallbackMaxSeconds: 180,
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError("network", "reset")),
      }),
    );

    const outcome = await run(INPUT);

    expect({ outcome, localCalls: transcribeLocally.mock.calls }).toEqual({
      outcome: {
        ok: true,
        segments: [{ text: "boundary result", start: 0, duration: 1 }],
      },
      localCalls: [["/tmp/audio.mp3", undefined, INPUT.signal]],
    });
  });

  it("does not use the local backend above the fallback cap", async () => {
    const transcribeLocally = vi.fn();
    const cleanupAudio = vi.fn().mockResolvedValue(undefined);
    const run = createTranscriptionWorkflow(
      dependencies({
        probeAudioDurationSeconds: vi.fn().mockResolvedValue(181),
        transcribeLocally,
        cleanupAudio,
      }),
      groqFirstPolicy({
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError("network", "reset")),
      }),
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
        transcribeLocally,
      }),
      groqFirstPolicy({
        transcribeViaGroq: vi.fn().mockRejectedValue(
          new GroqTranscribeError(
            "compress",
            "invalid audio frame",
            "ffmpeg-failed"
          )
        ),
      }),
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
      dependencies(),
      groqFirstPolicy({
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(429, "rate limited")),
      }),
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
        dependencies(),
        groqFirstPolicy({
          transcribeViaGroq: vi.fn().mockRejectedValue(
            new GroqTranscribeError(
              "compress",
              "compression failed",
              compressKind
            )
          ),
        }),
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

  it("emits the missing-Groq event once per constructed local-only workflow", async () => {
    const logEvent = vi.fn();
    const transcribeLocally = vi
      .fn()
      .mockResolvedValue([{ text: "hello", start: 0, duration: 1 }]);
    const run = createTranscriptionWorkflow(
      dependencies({ transcribeLocally, logEvent }),
    );
    const secondInput: TranscriptionWorkflowInput = {
      ...INPUT,
      correlation: {
        requestId: "second-workflow-request-id",
        videoId: INPUT.correlation.videoId,
      },
    };

    await run(INPUT);
    await run(secondInput);

    expect({
      localCalls: transcribeLocally.mock.calls.length,
      missingGroqEvents: logEvent.mock.calls.filter(
        ([, event]) => event === "transcribe.GROQ_API_KEY_MISSING",
      ),
    }).toEqual({
      localCalls: 2,
      missingGroqEvents: [
        [
          "error",
          "transcribe.GROQ_API_KEY_MISSING",
          {
            errorId: "GROQ_API_KEY_MISSING",
            requestId: "workflow-request-id",
            videoId: "dQw4w9WgXcQ",
          },
        ],
      ],
    });
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
        logEvent,
      }),
      groqFirstPolicy({
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(500, "upstream failure")),
      }),
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
        logEvent,
      }),
      groqFirstPolicy({
        transcribeViaGroq: vi
          .fn()
          .mockRejectedValue(new GroqTranscribeError(429, "rate limited")),
      }),
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
