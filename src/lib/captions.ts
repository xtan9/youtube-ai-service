import {
  areLanguageTagsEqual,
  haveSamePrimaryLanguage,
  parseLanguageTag,
  type LanguageTag,
} from "./language-tag.js";
import { logServiceEvent } from "./observability.js";
import {
  createYoutubeTranscriptCaptionTrackProvider,
  type CaptionTrackProvider,
  type CaptionTrackProviderResult,
} from "./caption-provider.js";
import type { TimedTextSegment } from "./timed-text.js";
import type { YouTubeVideoReference } from "./youtube-url.js";

export type {
  CaptionTrackProvider,
  CaptionTrackProviderRequest,
  CaptionTrackProviderResult,
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

const MAX_PROVIDER_LANGUAGE_TOKEN_LENGTH = 64;
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

type ProviderRetryTrack = Readonly<{
  readonly languageTag: LanguageTag;
  readonly rawToken: string;
}>;

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

function parseProviderLanguageToken(input: unknown): ProviderRetryTrack | null {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_PROVIDER_LANGUAGE_TOKEN_LENGTH
  ) {
    return null;
  }

  const parsed = parseLanguageTag(input);
  if (!parsed.ok) return null;

  return Object.freeze({
    languageTag: parsed.languageTag,
    rawToken: input,
  });
}

function selectProviderRetryTrack(
  requested: LanguageTag,
  available: readonly unknown[],
): ProviderRetryTrack | null {
  const tracks = available
    .map(parseProviderLanguageToken)
    .filter((track): track is ProviderRetryTrack => track !== null);

  const exact = tracks.find((track) =>
    areLanguageTagsEqual(track.languageTag, requested),
  );
  if (exact) return exact;

  // A specific script, region, or variant request is an exact identity
  // request. Only a bare primary tag may select the first same-primary track.
  if (requested.tag !== requested.primaryLanguageCode) return null;

  return (
    tracks.find((track) =>
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

function selectPromptLocale(
  request: CaptionTrackAcquisitionRequest,
  languageTag: string | undefined,
): PromptLocale {
  const parsed = parseLanguageTag(languageTag);
  if (!parsed.ok) {
    logServiceEvent("warn", "captions.unknown_locale", {
      ...providerCorrelation(request),
      reason: languageTag === undefined ? "missing" : parsed.reason,
    });
    return "en";
  }

  if (parsed.languageTag.primaryLanguageCode === "zh") return "zh";
  if (parsed.languageTag.primaryLanguageCode !== "en") {
    logServiceEvent("warn", "captions.unknown_locale", {
      ...providerCorrelation(request),
      lang: parsed.languageTag.tag,
    });
  }
  return "en";
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
  return Object.freeze({
    kind: "acquired" as const,
    segments: Object.freeze(segments),
    source: "auto_captions" as const,
    promptLocale: selectPromptLocale(request, result.languageTag),
    title: result.title,
    channelName: result.channelName,
  });
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

function requestedProviderLanguage(
  request: CaptionTrackAcquisitionRequest,
  language: string | undefined,
): {
  readonly videoId: string;
  readonly signal: AbortSignal;
  readonly language?: string;
} {
  return {
    videoId: request.videoReference.videoId,
    ...(language !== undefined ? { language } : {}),
    signal: request.signal,
  };
}

export function createCaptionTrackAcquisition(
  provider: CaptionTrackProvider,
): CaptionTrackAcquisition {
  return async (request) => {
    request.signal.throwIfAborted();
    const correlation = providerCorrelation(request);
    logServiceEvent("info", "captions.acquire", {
      ...correlation,
      lang: request.requestedLanguage?.tag,
    });

    try {
      let result = await provider(
        requestedProviderLanguage(request, request.requestedLanguage?.tag),
      );
      request.signal.throwIfAborted();

      if (
        result.kind === "absent" &&
        result.reason === "language-mismatch" &&
        request.requestedLanguage
      ) {
        const availableLanguages = result.availableLanguages ?? [];
        const matched = selectProviderRetryTrack(
          request.requestedLanguage,
          availableLanguages,
        );
        if (!matched) {
          logServiceEvent("info", "captions.language_mismatch", {
            ...correlation,
            lang: request.requestedLanguage.tag,
            availableCount: boundDiagnosticCount(availableLanguages.length),
          });
          return absent(request, "language-mismatch");
        }

        request.signal.throwIfAborted();
        logServiceEvent("warn", "captions.CAPTION_LANG_RETRY_PRIMARY_SUBTAG", {
          ...correlation,
          errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
          requested: request.requestedLanguage.tag,
          matched: matched.rawToken,
          availableCount: boundDiagnosticCount(availableLanguages.length),
        });
        result = await provider(
          requestedProviderLanguage(request, matched.rawToken),
        );
        request.signal.throwIfAborted();
      }

      return mapProviderResult(request, result);
    } catch (error) {
      request.signal.throwIfAborted();
      logServiceEvent("error", "captions.CAPTION_UNEXPECTED_FAILURE", {
        ...correlation,
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        errorClass: safeErrorClass(error),
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
