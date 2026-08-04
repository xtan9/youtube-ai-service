import {
  areLanguageTagsEqual,
  haveSamePrimaryLanguage,
  type LanguageTag,
  type PrimaryLanguageCode,
} from "./language-tag.js";
import { logServiceEvent } from "./observability.js";
import {
  createYoutubeTranscriptCaptionTrackProvider,
  type CaptionTrackProviderCandidate,
  type ProviderCaptionTrackLanguage,
  type CaptionTrackProvider,
  type CaptionTrackProviderResult,
} from "./caption-provider.js";
import type { TimedTextSegment } from "./timed-text.js";
import type { YouTubeVideoReference } from "./youtube-url.js";

export type {
  CaptionTrackProvider,
  CaptionTrackProviderCandidate,
  CaptionTrackProviderRequest,
  CaptionTrackProviderResult,
  ProviderCaptionTrackLanguage,
  ProviderTimedTextSegment,
} from "./caption-provider.js";
export type { TimedTextSegment } from "./timed-text.js";

export type PromptLocale = "en" | "zh";

export type CaptionTrackAbsentReason =
  | "disabled"
  | "missing"
  | "language-mismatch"
  | "empty-provider-result"
  | "filtered-empty";

export type VideoUnavailableReason =
  | "provider-video-unavailable"
  | "invalid-video-reference";

export interface CaptionTrackAcquisitionRequest {
  readonly videoReference: YouTubeVideoReference;
  readonly requestedLanguage?: LanguageTag;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export type AcquiredCaptionTrack = Readonly<{
  readonly kind: "acquired";
  readonly segments: readonly TimedTextSegment[];
  readonly source: "auto_captions";
  readonly promptLocale: PromptLocale;
  readonly title: string | null;
  readonly channelName: string | null;
}>;

export type CaptionTrackAbsent = Readonly<{
  readonly kind: "absent";
  readonly reason: CaptionTrackAbsentReason;
}>;

export type VideoUnavailable = Readonly<{
  readonly kind: "video-unavailable";
  readonly reason: VideoUnavailableReason;
}>;

export type CaptionTrackAcquisitionOutcome =
  | AcquiredCaptionTrack
  | CaptionTrackAbsent
  | VideoUnavailable;

export type CaptionTrackAcquisition = (
  request: CaptionTrackAcquisitionRequest,
) => Promise<CaptionTrackAcquisitionOutcome>;

const MAX_DIAGNOSTIC_COUNT = 1_000;
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_UNICODE_CODEPOINT = 0x10ffff;

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": "\u00a0",
};

function boundDiagnosticCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), MAX_DIAGNOSTIC_COUNT);
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return SAFE_ERROR_NAME_PATTERN.test(error.constructor.name)
    ? error.constructor.name
    : "unknown";
}

function cancellationClassification(reason: unknown):
  | "deadline"
  | "caller-aborted" {
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? "deadline"
    : "caller-aborted";
}

function providerCorrelation(
  request: CaptionTrackAcquisitionRequest,
): { readonly requestId: string; readonly videoId: string } {
  return {
    requestId: request.requestId,
    videoId: request.videoReference.videoId,
  };
}

function absent(
  request: CaptionTrackAcquisitionRequest,
  reason: CaptionTrackAbsentReason,
): CaptionTrackAbsent {
  request.signal.throwIfAborted();
  const outcome = Object.freeze({ kind: "absent" as const, reason });
  logServiceEvent("info", "captions.absent", {
    ...providerCorrelation(request),
    outcome: "absent",
    classification: reason,
  });
  return outcome;
}

function unavailable(
  request: CaptionTrackAcquisitionRequest,
  reason: VideoUnavailableReason,
): VideoUnavailable {
  request.signal.throwIfAborted();
  const outcome = Object.freeze({
    kind: "video-unavailable" as const,
    reason,
  });
  logServiceEvent("info", "captions.video_unavailable", {
    ...providerCorrelation(request),
    outcome: "video-unavailable",
    classification: reason,
  });
  return outcome;
}

function selectProviderRetryTrack(
  requested: LanguageTag,
  available: readonly CaptionTrackProviderCandidate[],
): CaptionTrackProviderCandidate | null {
  const exact = available.find((track) =>
    areLanguageTagsEqual(track.languageTag, requested),
  );
  if (exact) return exact;

  // Specific tags require exact identity. Only a bare primary request may
  // select the provider's first same-primary candidate.
  if (requested.tag !== requested.primaryLanguageCode) return null;
  return (
    available.find((track) =>
      haveSamePrimaryLanguage(track.languageTag, requested),
    ) ?? null
  );
}

function safeFromCodePoint(codePoint: number, original: string): string {
  // Unicode scalar values exclude the surrogate range even though
  // String.fromCodePoint accepts it on some runtimes.
  if (
    !Number.isFinite(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_UNICODE_CODEPOINT ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return original;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
}

function decodeEntitiesOnce(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (match) =>
      NAMED_XML_ENTITIES[match] ?? match,
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16), match),
    )
    .replace(/&#(\d+);/g, (match, decimal: string) =>
      safeFromCodePoint(parseInt(decimal, 10), match),
    );
}

function decodeCaptionEntities(text: string): string {
  const once = decodeEntitiesOnce(text);
  return once === text ? once : decodeEntitiesOnce(once);
}

function trackPrimaryLanguage(
  request: CaptionTrackAcquisitionRequest,
  trackLanguage: ProviderCaptionTrackLanguage,
): PrimaryLanguageCode | undefined {
  if (trackLanguage.kind === "unidentified") {
    logServiceEvent("warn", "captions.unknown_locale", {
      ...providerCorrelation(request),
      reason: trackLanguage.reason,
    });
    return undefined;
  }

  const { primaryLanguageCode } = trackLanguage.languageTag;
  if (primaryLanguageCode !== "en" && primaryLanguageCode !== "zh") {
    logServiceEvent("warn", "captions.unknown_locale", {
      ...providerCorrelation(request),
      lang: trackLanguage.languageTag.tag,
    });
  }
  return primaryLanguageCode;
}

function selectPromptLocale(
  primaryLanguageCode: PrimaryLanguageCode | undefined,
): PromptLocale {
  return primaryLanguageCode === "zh" ? "zh" : "en";
}

function acquiredFromProviderResult(
  request: CaptionTrackAcquisitionRequest,
  result: Extract<CaptionTrackProviderResult, { readonly kind: "success" }>,
): CaptionTrackAcquisitionOutcome {
  request.signal.throwIfAborted();
  if (result.segments.length === 0) {
    logServiceEvent("warn", "captions.empty_provider_result", {
      ...providerCorrelation(request),
      errorId: "CAPTION_EMPTY_PROVIDER_RESULT",
      segmentCount: 0,
    });
    return absent(request, "empty-provider-result");
  }

  const segments = result.segments
    .map((segment) => ({
      text: decodeCaptionEntities(segment.text),
      start: segment.start,
      duration: segment.duration,
    }))
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => Object.freeze(segment));

  if (segments.length === 0) {
    logServiceEvent("warn", "captions.filtered_empty", {
      ...providerCorrelation(request),
      errorId: "CAPTION_SEGMENTS_FILTERED_EMPTY",
      segmentCount: boundDiagnosticCount(result.segments.length),
    });
    return absent(request, "filtered-empty");
  }

  request.signal.throwIfAborted();
  const promptLocale = selectPromptLocale(
    trackPrimaryLanguage(request, result.trackLanguage),
  );
  const outcome = Object.freeze({
    kind: "acquired" as const,
    segments: Object.freeze(segments),
    source: "auto_captions" as const,
    promptLocale,
    title: result.title,
    channelName: result.channelName,
  });
  logServiceEvent("info", "captions.acquired", {
    ...providerCorrelation(request),
    outcome: "acquired",
    source: outcome.source,
    language: outcome.promptLocale,
    segmentCount: boundDiagnosticCount(outcome.segments.length),
  });
  return outcome;
}

function mapProviderResult(
  request: CaptionTrackAcquisitionRequest,
  result: CaptionTrackProviderResult,
): CaptionTrackAcquisitionOutcome {
  request.signal.throwIfAborted();
  switch (result.kind) {
    case "success":
      return acquiredFromProviderResult(request, result);
    case "absent":
      return absent(request, result.reason);
    case "unavailable":
      return unavailable(request, result.reason);
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      throw new Error("Caption Track provider returned an unknown outcome");
    }
  }
}

export function createCaptionTrackAcquisition(
  provider: CaptionTrackProvider,
): CaptionTrackAcquisition {
  return async (request) => {
    const correlation = providerCorrelation(request);
    try {
      request.signal.throwIfAborted();
      logServiceEvent("info", "captions.acquire", {
        ...correlation,
        lang: request.requestedLanguage?.tag,
      });
      let result = await provider({
        kind: "initial",
        videoId: request.videoReference.videoId,
        ...(request.requestedLanguage
          ? { requestedLanguage: request.requestedLanguage }
          : {}),
        signal: request.signal,
      });
      request.signal.throwIfAborted();

      if (
        result.kind === "absent" &&
        result.reason === "language-mismatch" &&
        request.requestedLanguage
      ) {
        const matched = selectProviderRetryTrack(
          request.requestedLanguage,
          result.availableTracks,
        );
        if (!matched) {
          logServiceEvent("info", "captions.language_mismatch", {
            ...correlation,
            lang: request.requestedLanguage.tag,
            availableCount: boundDiagnosticCount(result.availableCount),
          });
          return absent(request, "language-mismatch");
        }

        request.signal.throwIfAborted();
        logServiceEvent("warn", "captions.CAPTION_LANG_RETRY_PRIMARY_SUBTAG", {
          ...correlation,
          errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
          requested: request.requestedLanguage.tag,
          matched: matched.languageTag.tag,
          availableCount: boundDiagnosticCount(result.availableCount),
        });
        result = await provider({
          kind: "retry",
          videoId: request.videoReference.videoId,
          candidate: matched,
          signal: request.signal,
        });
        request.signal.throwIfAborted();
      }

      return mapProviderResult(request, result);
    } catch (error) {
      if (request.signal.aborted) {
        logServiceEvent("info", "captions.cancelled", {
          ...correlation,
          outcome: "cancelled",
          classification: cancellationClassification(request.signal.reason),
        });
        request.signal.throwIfAborted();
      }
      logServiceEvent("error", "captions.CAPTION_UNEXPECTED_FAILURE", {
        ...correlation,
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        errorClass: safeErrorClass(error),
        outcome: "unexpected",
      });
      throw error;
    }
  };
}

export function createProductionCaptionTrackAcquisition(): CaptionTrackAcquisition {
  return createCaptionTrackAcquisition(
    createYoutubeTranscriptCaptionTrackProvider(),
  );
}
