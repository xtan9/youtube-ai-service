import type { TranscriptSegment } from "./captions.js";
import type { AudioCompressKind } from "./audio-compress.js";
import { probeAudioDurationSeconds } from "./audio-duration.js";
import {
  createGroqTranscriber,
  GroqTranscribeError,
} from "./groq-transcribe.js";
import { logServiceEvent } from "./observability.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { LocalTranscriptionError, transcribeAudio } from "./whisper.js";
import {
  AudioDownloadError,
  AudioMediaLimitError,
  cleanupAudio,
  createAudioDownloader,
  createAudioPath,
} from "./ytdlp.js";

function isOperationalCompressKind(kind: AudioCompressKind): boolean {
  switch (kind) {
    case "missing-binary":
    case "timeout":
      return true;
    case "ffmpeg-failed":
      return false;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export interface TranscriptionWorkflowInput {
  youtubeUrl: string;
  language?: string;
  signal: AbortSignal;
  limits: {
    mediaMaxBytes: number;
    mediaMaxDurationSeconds: number;
  };
  correlation: {
    requestId: string;
    videoId: string;
  };
}

export type TranscriptionWorkflowOutcome =
  | {
      ok: true;
      segments: TranscriptSegment[];
    }
  | {
      ok: false;
      reason:
        | "media-size-exceeded"
        | "media-duration-unknown"
        | "media-duration-exceeded"
        | "temporarily-unavailable"
        | "empty-result"
        | "transcription-failed";
    };

export interface TranscriptionWorkflowDependencies {
  createAudioPath(): string;
  downloadAudio(
    youtubeUrl: string,
    audioPath: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<void>;
  cleanupAudio(audioPath: string): Promise<void>;
  probeAudioDurationSeconds(
    audioPath: string,
    signal: AbortSignal,
  ): Promise<number | null>;
  transcribeViaGroq(
    audioPath: string,
    language: string | undefined,
    signal: AbortSignal,
  ): Promise<{ segments: TranscriptSegment[]; language: string }>;
  transcribeLocally(
    audioPath: string,
    language: string | undefined,
    signal: AbortSignal,
  ): Promise<TranscriptSegment[]>;
  isGroqConfigured(): boolean;
  readLocalFallbackMaxSeconds(): number;
  logEvent(
    level: "error" | "warn" | "info",
    event: string,
    fields?: Record<string, unknown>
  ): void;
}

export type TranscriptionWorkflow = (
  input: TranscriptionWorkflowInput
) => Promise<TranscriptionWorkflowOutcome>;

export function createTranscriptionWorkflow(
  dependencies: TranscriptionWorkflowDependencies
): TranscriptionWorkflow {
  let groqKeyMissingWarned = false;

  return async (input) => {
    const correlation = input.correlation;
    dependencies.logEvent("info", "transcribe.start", {
      ...correlation,
      lang: input.language,
    });

    try {
      const audioPath = dependencies.createAudioPath();

      try {
        await dependencies.downloadAudio(
          input.youtubeUrl,
          audioPath,
          input.limits.mediaMaxBytes,
          input.signal,
        );
        dependencies.logEvent("info", "transcribe.audio_downloaded", {
          ...correlation,
        });

        const audioSeconds =
          await dependencies.probeAudioDurationSeconds(
            audioPath,
            input.signal,
          );
        if (audioSeconds === null) {
          dependencies.logEvent(
            "warn",
            "transcribe.MEDIA_DURATION_UNKNOWN",
            {
              errorId: "MEDIA_DURATION_UNKNOWN",
              ...correlation,
            }
          );
          return { ok: false, reason: "media-duration-unknown" };
        }
        if (audioSeconds > input.limits.mediaMaxDurationSeconds) {
          dependencies.logEvent(
            "info",
            "transcribe.MEDIA_DURATION_EXCEEDED",
            {
              errorId: "MEDIA_DURATION_EXCEEDED",
              ...correlation,
              audioSeconds,
            }
          );
          return { ok: false, reason: "media-duration-exceeded" };
        }
        let segments: TranscriptSegment[];
        if (!dependencies.isGroqConfigured()) {
          if (!groqKeyMissingWarned) {
            groqKeyMissingWarned = true;
            dependencies.logEvent(
              "error",
              "transcribe.GROQ_API_KEY_MISSING",
              {
                errorId: "GROQ_API_KEY_MISSING",
                ...correlation,
              }
            );
          }
          segments = await dependencies.transcribeLocally(
            audioPath,
            input.language,
            input.signal,
          );
        } else {
          try {
            segments = (
              await dependencies.transcribeViaGroq(
                audioPath,
                input.language,
                input.signal,
              )
            ).segments;
          } catch (error) {
            if (!(error instanceof GroqTranscribeError)) throw error;
            const fallbackCap =
              dependencies.readLocalFallbackMaxSeconds();
            if (
              error.status === 429 ||
              (error.status === "compress" &&
                (error.compressKind === undefined ||
                  isOperationalCompressKind(error.compressKind))) ||
              audioSeconds > fallbackCap
            ) {
              dependencies.logEvent(
                "error",
                "transcribe.GROQ_FAILED_NO_FALLBACK",
                {
                  errorId: "GROQ_FAILED_NO_FALLBACK",
                  ...correlation,
                  audioSeconds,
                  fallbackCap,
                  groqStatus: error.status,
                  compressKind: error.compressKind,
                }
              );
              return { ok: false, reason: "temporarily-unavailable" };
            }
            dependencies.logEvent("warn", "transcribe.GROQ_FALLBACK", {
              errorId: "GROQ_FALLBACK",
              ...correlation,
              audioSeconds,
              groqStatus: error.status,
              compressKind: error.compressKind,
            });
            segments = await dependencies.transcribeLocally(
              audioPath,
              input.language,
              input.signal,
            );
          }
        }
        dependencies.logEvent("info", "transcribe.complete", {
          ...correlation,
          segmentCount: segments.length,
        });
        if (segments.length === 0) {
          dependencies.logEvent("error", "transcribe.WHISPER_EMPTY_RESULT", {
            errorId: "WHISPER_EMPTY_RESULT",
            ...correlation,
          });
          return { ok: false, reason: "empty-result" };
        }
        return { ok: true, segments };
      } finally {
        try {
          await dependencies.cleanupAudio(audioPath);
        } catch (cleanupError) {
          dependencies.logEvent("warn", "transcribe.CLEANUP_AUDIO_FAILED", {
            errorId: "CLEANUP_AUDIO_FAILED",
            ...correlation,
            errorName:
              cleanupError instanceof Error ? cleanupError.name : "unknown",
          });
        }
      }
    } catch (error) {
      input.signal.throwIfAborted();
      if (error instanceof AudioMediaLimitError) {
        dependencies.logEvent("info", "transcribe.MEDIA_SIZE_EXCEEDED", {
          errorId: "MEDIA_SIZE_EXCEEDED",
          ...correlation,
        });
        return { ok: false, reason: "media-size-exceeded" };
      }
      if (
        error instanceof AudioDownloadError ||
        error instanceof LocalTranscriptionError
      ) {
        dependencies.logEvent("error", "transcribe.TRANSCRIPTION_FAILED", {
          errorId: "TRANSCRIPTION_FAILED",
          ...correlation,
          stage:
            error instanceof AudioDownloadError
              ? "media-acquisition"
              : "local-transcription",
          errorName: error.name,
        });
        return { ok: false, reason: "transcription-failed" };
      }
      dependencies.logEvent("error", "transcribe.TRANSCRIBE_UNHANDLED", {
        errorId: "TRANSCRIBE_UNHANDLED",
        ...correlation,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  };
}

type ProductionWorkflowConfig = Pick<
  RuntimeConfig,
  "transcription" | "mediaAcquisition"
>;

export function createProductionTranscriptionWorkflow(
  config: ProductionWorkflowConfig
): TranscriptionWorkflow {
  const groqConfig = config.transcription.groq;
  const transcribeViaGroq = groqConfig
    ? createGroqTranscriber(groqConfig)
    : async () => {
        throw new Error("Groq transcription is not configured");
      };

  return createTranscriptionWorkflow({
    createAudioPath,
    downloadAudio: createAudioDownloader(config.mediaAcquisition),
    cleanupAudio,
    probeAudioDurationSeconds,
    transcribeViaGroq,
    transcribeLocally: transcribeAudio,
    isGroqConfigured: () => groqConfig !== null,
    readLocalFallbackMaxSeconds: () =>
      config.transcription.localFallbackMaxSeconds,
    logEvent: logServiceEvent,
  });
}
