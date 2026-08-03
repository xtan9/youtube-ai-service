import {
  detectLanguage,
  extractAvailableCaptions,
} from "./language-detect.js";
import { logServiceEvent } from "./observability.js";
import type { RuntimeConfig } from "./runtime-config.js";
import {
  createYtdlpMetadataFetcher,
  YtdlpAcquisitionError,
  type YtdlpMetadata,
} from "./ytdlp-metadata.js";

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
  readonly languageHint: string;
  readonly availableCaptionLanguages: readonly string[];
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
  readonly detectLanguage: (metadata: YtdlpMetadata) => string | null;
  readonly extractAvailableCaptions: (metadata: YtdlpMetadata) => readonly string[];
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
    const { correlation } = input;

    dependencies.logEvent("info", "metadata.fetch", {
      ...correlation,
    });

    try {
      const metadata = await dependencies.fetchMetadata(
        input.youtubeUrl,
        input.signal,
      );
      input.signal.throwIfAborted();

      const detectedLanguage = dependencies.detectLanguage(metadata);
      let languageHint = detectedLanguage;
      if (!languageHint) {
        dependencies.logEvent("warn", "metadata.LANGUAGE_DETECT_FALLBACK", {
          errorId: "LANGUAGE_DETECT_FALLBACK",
          ...correlation,
          hasLanguageField: Boolean(metadata.language),
          subtitleKeyCount: Object.keys(metadata.subtitles).length,
          textLength:
            (metadata.title?.length ?? 0) +
            (metadata.description?.length ?? 0),
        });
        languageHint = "en";
      }

      return {
        ok: true,
        videoInformation: {
          title: metadata.title,
          description: metadata.description,
          durationSeconds: metadata.duration,
          languageHint,
          availableCaptionLanguages: [
            ...dependencies.extractAvailableCaptions(metadata),
          ],
        },
      };
    } catch (error) {
      if (input.signal.aborted) input.signal.throwIfAborted();

      if (error instanceof YtdlpAcquisitionError) {
        dependencies.logEvent("error", "metadata.failed", {
          errorId: "METADATA_FAILED",
          ...correlation,
          errorName: error.name,
          stage: "acquisition",
        });
        return { ok: false, reason: "temporarily-unavailable" };
      }

      dependencies.logEvent("error", "metadata.WORKFLOW_UNHANDLED", {
        errorId: "METADATA_WORKFLOW_UNHANDLED",
        ...correlation,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  };
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
