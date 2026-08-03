import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionWorkflow,
  type TranscriptionWorkflowDependencies,
  type TranscriptionWorkflowInput,
  type TranscriptionWorkflowPolicy,
} from "../transcription-workflow.js";
import { parseYouTubeVideoReference } from "../youtube-url.js";

const VIDEO_REFERENCE = parseYouTubeVideoReference(
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
);
if (!VIDEO_REFERENCE) throw new Error("test fixture must be a YouTube URL");

const INPUT: TranscriptionWorkflowInput = {
  videoReference: VIDEO_REFERENCE,
  signal: new AbortController().signal,
  correlation: {
    requestId: "policy-request-id",
    videoId: "dQw4w9WgXcQ",
  },
};

const LOCAL_ONLY_POLICY: TranscriptionWorkflowPolicy = {
  backend: "local-only",
  mediaMaxBytes: 50_000_000,
  mediaMaxDurationSeconds: 1_800,
};

function dependencies(): TranscriptionWorkflowDependencies {
  return {
    createAudioPath: vi.fn().mockReturnValue("/tmp/audio.mp3"),
    downloadAudio: vi.fn().mockResolvedValue(undefined),
    cleanupAudio: vi.fn().mockResolvedValue(undefined),
    probeAudioDurationSeconds: vi.fn().mockResolvedValue(60),
    transcribeLocally: vi
      .fn()
      .mockResolvedValue([{ text: "local result", start: 0, duration: 1 }]),
    logEvent: vi.fn(),
  };
}

describe("transcription workflow construction policy", () => {
  it("runs a local-only policy through local transcription", async () => {
    const run = createTranscriptionWorkflow(dependencies(), LOCAL_ONLY_POLICY);

    await expect(run(INPUT)).resolves.toEqual({
      ok: true,
      segments: [{ text: "local result", start: 0, duration: 1 }],
    });
  });

  it("captures backend and media policy values at construction", async () => {
    const transcribeViaGroq = vi.fn().mockResolvedValue({
      segments: [{ text: "groq result", start: 0, duration: 1 }],
      language: "en",
    });
    const policy: TranscriptionWorkflowPolicy = {
      backend: "groq-first",
      mediaMaxBytes: 50_000_000,
      mediaMaxDurationSeconds: 60,
      transcribeViaGroq,
      localFallbackMaxSeconds: 180,
    };
    const run = createTranscriptionWorkflow(dependencies(), policy);

    const mutablePolicy = policy as unknown as {
      backend: string;
      mediaMaxDurationSeconds: number;
    };
    mutablePolicy.backend = "local-only";
    mutablePolicy.mediaMaxDurationSeconds = 30;

    await expect(run(INPUT)).resolves.toEqual({
      ok: true,
      segments: [{ text: "groq result", start: 0, duration: 1 }],
    });
    expect(transcribeViaGroq).toHaveBeenCalledOnce();
  });
});
