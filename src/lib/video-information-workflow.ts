import {
  detectLanguage,
  extractAvailableCaptions,
} from "./language-detect.js";
import {
  parseLanguageTag,
  type LanguageTag,
  type PrimaryLanguageCode,
} from "./language-tag.js";
import { logServiceEvent } from "./observability.js";
import type { RuntimeConfig } from "./runtime-config.js";
import {
  createYtdlpMetadataFetcher,
  YtdlpAcquisitionError,
  type YtdlpLanguageTagRejection,
  type YtdlpMetadata,
} from "./ytdlp-metadata.js";

const MAX_DIAGNOSTIC_COUNT = 1_000;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 4_000;
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_LANGUAGE_REJECTION_LOG_COUNT = 1_000;

const DEFAULT_LANGUAGE_TAG: LanguageTag = (() => {
  const parsed = parseLanguageTag("en");
  if (!parsed.ok) {
    throw new Error("English fallback must be a valid Language Tag");
  }
  return parsed.languageTag;
})();

function boundDiagnosticMeasurement(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), maximum);
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const name = error.name;
  return typeof name === "string" && SAFE_ERROR_NAME_PATTERN.test(name)
    ? name
    : "unknown";
}

export interface VideoInformationWorkflowInput {
  readonly youtubeUrl: string;
  readonly signal: AbortSignal;
  readonly correlation: {
    readonly requestId: string;
    readonly videoId: string;
  };
}

export interface VideoInformation {
  readonly title: string;
  readonly description: string;
  readonly durationSeconds: number | null;
  readonly languageHint: LanguageTag;
  readonly availableCaptionLanguages: readonly PrimaryLanguageCode[];
}

export type VideoInformationWorkflowOutcome =
  | {
      readonly ok: true;
      readonly videoInformation: VideoInformation;
    }
  | {
      readonly ok: false;
      readonly reason: "temporarily-unavailable";
    };

export type VideoInformationWorkflow = (
  input: VideoInformationWorkflowInput,
) => Promise<VideoInformationWorkflowOutcome>;

export interface VideoInformationWorkflowDependencies {
  readonly fetchMetadata: (
    url: string,
    signal: AbortSignal,
  ) => Promise<YtdlpMetadata>;
  readonly detectLanguage: (metadata: YtdlpMetadata) => LanguageTag | null;
  readonly extractAvailableCaptions: (
    metadata: YtdlpMetadata,
  ) => readonly PrimaryLanguageCode[];
  readonly logEvent: (
    level: "error" | "warn" | "info",
    event: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export function createVideoInformationWorkflow(
  dependencies: VideoInformationWorkflowDependencies,
): VideoInformationWorkflow {
  return async (input) => {
    input.signal.throwIfAborted();
    const correlation = {
      requestId: input.correlation.requestId,
      videoId: input.correlation.videoId,
    };

    dependencies.logEvent("info", "metadata.fetch", {
      ...correlation,
    });

    try {
      const metadata = await dependencies.fetchMetadata(
        input.youtubeUrl,
        input.signal,
      );
      input.signal.throwIfAborted();

      logLanguageTagRejections(
        dependencies,
        metadata.languageTagRejections,
        correlation,
      );

      const detectedLanguage = dependencies.detectLanguage(metadata);
      input.signal.throwIfAborted();
      let languageHint = detectedLanguage;
      if (!languageHint) {
        dependencies.logEvent("warn", "metadata.LANGUAGE_DETECT_FALLBACK", {
          errorId: "LANGUAGE_DETECT_FALLBACK",
          ...correlation,
          hasLanguageField: Boolean(metadata.language),
          subtitleKeyCount: boundDiagnosticMeasurement(
            metadata.subtitles.length,
            MAX_DIAGNOSTIC_COUNT,
          ),
          textLength: boundDiagnosticMeasurement(
            metadata.title.length + metadata.description.length,
            MAX_DIAGNOSTIC_TEXT_LENGTH,
          ),
        });
        input.signal.throwIfAborted();
        languageHint = DEFAULT_LANGUAGE_TAG;
      }

      const availableCaptionLanguages = [
        ...dependencies.extractAvailableCaptions(metadata),
      ];
      input.signal.throwIfAborted();

      return {
        ok: true,
        videoInformation: {
          title: metadata.title,
          description: metadata.description,
          durationSeconds: metadata.duration,
          languageHint,
          availableCaptionLanguages,
        },
      };
    } catch (error) {
      if (input.signal.aborted) input.signal.throwIfAborted();

      if (error instanceof YtdlpAcquisitionError) {
        dependencies.logEvent("error", "metadata.failed", {
          errorId: "METADATA_FAILED",
          ...correlation,
          errorName: safeErrorName(error),
          stage: "acquisition",
        });
        return { ok: false, reason: "temporarily-unavailable" };
      }

      dependencies.logEvent("error", "metadata.WORKFLOW_UNHANDLED", {
        errorId: "METADATA_WORKFLOW_UNHANDLED",
        ...correlation,
        errorName: safeErrorName(error),
      });
      throw error;
    }
  };
}

function logLanguageTagRejections(
  dependencies: VideoInformationWorkflowDependencies,
  rejections: readonly YtdlpLanguageTagRejection[],
  correlation: VideoInformationWorkflowInput["correlation"],
): void {
  if (!rejections || rejections.length === 0) return;

  const grouped = new Map<
    string,
    {
      readonly source: YtdlpLanguageTagRejection["source"];
      readonly reason: YtdlpLanguageTagRejection["reason"];
      count: number;
    }
  >();

  for (const rejection of rejections) {
    const key = `${rejection.source}:${rejection.reason}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count = Math.min(
        existing.count + 1,
        MAX_LANGUAGE_REJECTION_LOG_COUNT,
      );
      continue;
    }
    grouped.set(key, {
      source: rejection.source,
      reason: rejection.reason,
      count: 1,
    });
  }

  for (const rejection of grouped.values()) {
    dependencies.logEvent("warn", "metadata.LANGUAGE_TAG_REJECTED", {
      errorId: "LANGUAGE_TAG_REJECTED",
      ...correlation,
      source: rejection.source,
      reason: rejection.reason,
      rejectionCount: rejection.count,
    });
  }
}

type ProductionVideoInformationConfig = Pick<
  RuntimeConfig,
  "mediaAcquisition"
>;

export function createProductionVideoInformationWorkflow(
  config: ProductionVideoInformationConfig,
): VideoInformationWorkflow {
  return createVideoInformationWorkflow({
    fetchMetadata: createYtdlpMetadataFetcher(config.mediaAcquisition),
    detectLanguage,
    extractAvailableCaptions,
    logEvent: logServiceEvent,
  });
}
