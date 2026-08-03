import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResult,
} from "youtube-transcript-plus";

export interface CaptionTrackProviderRequest {
  readonly videoId: string;
  readonly language?: string;
  readonly signal: AbortSignal;
}

export interface ProviderTimedTextSegment {
  readonly text: string;
  readonly start: number;
  readonly duration: number;
}

export type CaptionTrackProviderResult =
  | {
      readonly kind: "success";
      readonly segments: readonly ProviderTimedTextSegment[];
      readonly languageTag?: string;
      readonly title: string | null;
      readonly channelName: string | null;
    }
  | {
      readonly kind: "absent";
      readonly reason: "disabled" | "missing" | "language-mismatch";
      readonly availableLanguages?: readonly unknown[];
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "provider-video-unavailable" | "invalid-video-reference";
    };

export type CaptionTrackProvider = (
  request: CaptionTrackProviderRequest,
) => Promise<CaptionTrackProviderResult>;

class CaptionProviderSchemaError extends Error {
  constructor() {
    super("caption provider returned an invalid response");
    this.name = "CaptionProviderSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNullableText(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const field = record[key];
  if (field === undefined || field === null) return null;
  if (typeof field !== "string") throw new CaptionProviderSchemaError();
  return field;
}

function normalizeTranscriptResult(
  result: unknown,
): Extract<CaptionTrackProviderResult, { readonly kind: "success" }> {
  if (!isRecord(result) || !Array.isArray(result.segments)) {
    throw new CaptionProviderSchemaError();
  }

  const segments = result.segments.map((segment) => {
    if (!isRecord(segment)) throw new CaptionProviderSchemaError();
    const { text, offset, duration, lang } = segment;
    if (
      typeof text !== "string" ||
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      (lang !== undefined && lang !== null && typeof lang !== "string")
    ) {
      throw new CaptionProviderSchemaError();
    }
    return Object.freeze({
      text,
      start: offset,
      duration,
    });
  });

  const videoDetails = result.videoDetails;
  if (
    videoDetails !== undefined &&
    videoDetails !== null &&
    !isRecord(videoDetails)
  ) {
    throw new CaptionProviderSchemaError();
  }
  const details = isRecord(videoDetails) ? videoDetails : undefined;
  const firstSegment = result.segments[0];
  const languageTag =
    isRecord(firstSegment) && typeof firstSegment.lang === "string"
      ? firstSegment.lang
      : undefined;

  return Object.freeze({
    kind: "success" as const,
    segments: Object.freeze(segments),
    languageTag,
    title: details ? readNullableText(details, "title") : null,
    channelName: details
      ? readNullableText(details, "author")
      : null,
  });
}

function normalizeAvailableLanguages(
  availableLanguages: unknown,
): readonly string[] {
  if (!Array.isArray(availableLanguages)) return [];
  return Object.freeze(
    availableLanguages
      .filter((language): language is string => typeof language === "string")
      .slice(0, 1_000),
  );
}

/**
 * Adapter for youtube-transcript-plus. Provider exception classes and its
 * response schema stop at this boundary; the application-facing acquisition
 * seam consumes only the classified adapter result above.
 */
export function createYoutubeTranscriptCaptionTrackProvider(): CaptionTrackProvider {
  return async (request) => {
    request.signal.throwIfAborted();

    try {
      const response = await fetchTranscript(request.videoId, {
        videoDetails: true,
        ...(request.language !== undefined
          ? { lang: request.language }
          : {}),
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      return normalizeTranscriptResult(response as TranscriptResult);
    } catch (error) {
      request.signal.throwIfAborted();
      if (error instanceof YoutubeTranscriptDisabledError) {
        return { kind: "absent", reason: "disabled" };
      }
      if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
        return {
          kind: "absent",
          reason: "language-mismatch",
          availableLanguages: normalizeAvailableLanguages(error.availableLangs),
        };
      }
      if (error instanceof YoutubeTranscriptNotAvailableError) {
        return { kind: "absent", reason: "missing" };
      }
      if (error instanceof YoutubeTranscriptVideoUnavailableError) {
        return {
          kind: "unavailable",
          reason: "provider-video-unavailable",
        };
      }
      if (error instanceof YoutubeTranscriptInvalidVideoIdError) {
        return {
          kind: "unavailable",
          reason: "invalid-video-reference",
        };
      }
      throw error;
    }
  };
}
