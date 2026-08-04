import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResult,
} from "youtube-transcript-plus";
import {
  parseLanguageTag,
  type LanguageTag,
  type LanguageTagParseFailureReason,
} from "./language-tag.js";

interface CaptionTrackProviderRequestBase {
  readonly videoId: string;
  readonly signal: AbortSignal;
}

export type CaptionTrackProviderRequest =
  | (CaptionTrackProviderRequestBase & {
      readonly kind: "initial";
      readonly requestedLanguage?: LanguageTag;
    })
  | (CaptionTrackProviderRequestBase & {
      readonly kind: "retry";
      readonly candidate: CaptionTrackProviderCandidate;
    });

export interface ProviderTimedTextSegment {
  readonly text: string;
  readonly start: number;
  readonly duration: number;
}

export type ProviderCaptionTrackLanguage =
  | Readonly<{
      readonly kind: "identified";
      readonly languageTag: LanguageTag;
    }>
  | Readonly<{
      readonly kind: "unidentified";
      readonly reason: "missing" | LanguageTagParseFailureReason;
    }>;

export interface CaptionTrackProviderCandidate {
  readonly languageTag: LanguageTag;
}

export type CaptionTrackProviderResult =
  | {
      readonly kind: "success";
      readonly segments: readonly ProviderTimedTextSegment[];
      readonly trackLanguage: ProviderCaptionTrackLanguage;
      readonly title: string | null;
      readonly channelName: string | null;
    }
  | {
      readonly kind: "absent";
      readonly reason: "disabled" | "missing";
    }
  | {
      readonly kind: "absent";
      readonly reason: "language-mismatch";
      readonly availableTracks: readonly CaptionTrackProviderCandidate[];
      readonly availableCount: number;
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

const MAX_PROVIDER_LANGUAGE_TOKEN_LENGTH = 64;
const MAX_PROVIDER_LANGUAGE_CANDIDATES = 1_000;

type ProviderCandidateTransport = Readonly<{
  readonly videoId: string;
  readonly rawToken: string;
}>;

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
  const languageToken =
    isRecord(firstSegment) && typeof firstSegment.lang === "string"
      ? firstSegment.lang
      : undefined;
  const parsedLanguage = parseLanguageTag(languageToken);
  const trackLanguage: ProviderCaptionTrackLanguage = parsedLanguage.ok
    ? Object.freeze({
        kind: "identified",
        languageTag: parsedLanguage.languageTag,
      })
    : Object.freeze({
        kind: "unidentified",
        reason: languageToken === undefined ? "missing" : parsedLanguage.reason,
      });

  return Object.freeze({
    kind: "success" as const,
    segments: Object.freeze(segments),
    trackLanguage,
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
      .slice(0, MAX_PROVIDER_LANGUAGE_CANDIDATES),
  );
}

function createProviderTrackCandidate(
  candidateTransports: WeakMap<
    CaptionTrackProviderCandidate,
    ProviderCandidateTransport
  >,
  videoId: string,
  input: string,
): CaptionTrackProviderCandidate | null {
  if (input.length === 0 || input.length > MAX_PROVIDER_LANGUAGE_TOKEN_LENGTH) {
    return null;
  }
  const parsed = parseLanguageTag(input);
  if (!parsed.ok) return null;
  const candidate = Object.freeze({ languageTag: parsed.languageTag });
  candidateTransports.set(candidate, { videoId, rawToken: input });
  return candidate;
}

function classifyProviderError(
  request: CaptionTrackProviderRequest,
  candidateTransports: WeakMap<
    CaptionTrackProviderCandidate,
    ProviderCandidateTransport
  >,
  error: unknown,
): CaptionTrackProviderResult | null {
  if (error instanceof YoutubeTranscriptDisabledError) {
    return { kind: "absent", reason: "disabled" };
  }
  if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
    const availableLanguages = normalizeAvailableLanguages(error.availableLangs);
    const availableTracks = availableLanguages
      .map((language) =>
        createProviderTrackCandidate(
          candidateTransports,
          request.videoId,
          language,
        ),
      )
      .filter(
        (track): track is CaptionTrackProviderCandidate => track !== null,
      );
    return Object.freeze({
      kind: "absent",
      reason: "language-mismatch",
      availableTracks: Object.freeze(availableTracks),
      availableCount: availableLanguages.length,
    });
  }
  if (error instanceof YoutubeTranscriptNotAvailableError) {
    return { kind: "absent", reason: "missing" };
  }
  if (error instanceof YoutubeTranscriptVideoUnavailableError) {
    return { kind: "unavailable", reason: "provider-video-unavailable" };
  }
  if (error instanceof YoutubeTranscriptInvalidVideoIdError) {
    return { kind: "unavailable", reason: "invalid-video-reference" };
  }
  return null;
}

async function fetchProviderTrack(
  request: CaptionTrackProviderRequest,
  candidateTransports: WeakMap<
    CaptionTrackProviderCandidate,
    ProviderCandidateTransport
  >,
  language: string | undefined,
): Promise<CaptionTrackProviderResult> {
  request.signal.throwIfAborted();
  try {
    const response = await fetchTranscript(request.videoId, {
      videoDetails: true,
      ...(language !== undefined ? { lang: language } : {}),
      signal: request.signal,
    });
    request.signal.throwIfAborted();
    return normalizeTranscriptResult(response as TranscriptResult);
  } catch (error) {
    request.signal.throwIfAborted();
    const outcome = classifyProviderError(request, candidateTransports, error);
    if (outcome) return outcome;
    throw error;
  }
}

/**
 * Adapter for youtube-transcript-plus. Provider exception classes and its
 * response schema stop at this boundary; the application-facing acquisition
 * seam consumes only the classified adapter result above.
 */
export function createYoutubeTranscriptCaptionTrackProvider(): CaptionTrackProvider {
  const candidateTransports = new WeakMap<
    CaptionTrackProviderCandidate,
    ProviderCandidateTransport
  >();

  return async (request) => {
    if (request.kind === "initial") {
      return fetchProviderTrack(
        request,
        candidateTransports,
        request.requestedLanguage?.tag,
      );
    }

    const transport = candidateTransports.get(request.candidate);
    if (!transport || transport.videoId !== request.videoId) {
      throw new CaptionProviderSchemaError();
    }
    return fetchProviderTrack(request, candidateTransports, transport.rawToken);
  };
}
