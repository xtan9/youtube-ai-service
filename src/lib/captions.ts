import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResult,
  type TranscriptSegment as YtTranscriptSegment,
} from "youtube-transcript-plus";
import {
  areLanguageTagsEqual,
  haveSamePrimaryLanguage,
  parseLanguageTag,
  type LanguageTag,
} from "./language-tag.js";
import { logServiceEvent } from "./observability.js";

// Caption fetching must run from an IP YouTube classifies as residential —
// datacenter IPs get caption-track URLs stripped from the watch-page
// response, making every caption fetch look like "no transcripts available".
// This service egresses through the Tailscale exit node (home Mac) which
// gives youtube-transcript-plus the residential presence it needs.

export type PromptLocale = "en" | "zh";

/**
 * One transcript line with its playback timing. The frontend uses these to
 * render clickable timestamps that seek the embedded YouTube player.
 *
 * Same shape is produced by the Whisper fallback so consumers don't need to
 * branch on transcript source.
 */
export interface TranscriptSegment {
  readonly text: string;
  readonly start: number; // seconds from start of video
  readonly duration: number; // seconds
}

export interface CaptionResult {
  readonly segments: readonly TranscriptSegment[];
  readonly source: "auto_captions";
  readonly language: PromptLocale;
  // `null` not `""`: the distinction between "YouTube returned empty" and
  // "we never got videoDetails" matters to the frontend UI, and forcing
  // callers to handle the unknown case at the type level prevents the
  // silent-empty-string bug class.
  readonly title: string | null;
  readonly channelName: string | null;
}

// `youtube-transcript-plus` already decodes the named XML entities
// (`&amp; &lt; &gt; &quot; &apos; &#39;`) once, but YouTube sometimes
// emits them double-encoded (`&amp;#39;` survives the first pass as
// `&#39;`) and the library doesn't cover hex-numeric (`&#x27;`) or
// arbitrary `&#NNN;` decimal entities at all. Run an iterative pass
// here so the segment text we hand callers is a clean Unicode string —
// otherwise React renders the literal `&` and users see "I&#39;m"
// where they should see "I'm".
//
// Bounded to two passes total: enough to unwrap `&amp;<entity>;`
// without risk of an infinite loop on adversarial input that happens
// to keep producing entity-shaped substrings. Whisper output is plain
// text so this only matters on the captions path.
const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

// `String.fromCodePoint` throws RangeError for values > 0x10FFFF (e.g.
// adversarial `&#999999999999;`). A defensive decoder must never throw —
// a single malformed entity would otherwise crash the whole captions
// fetch. Return the original match unchanged when the codepoint is out
// of range so downstream sees the raw entity instead of a 500.
const MAX_UNICODE_CODEPOINT = 0x10ffff;
function safeFromCodePoint(cp: number, originalMatch: string): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > MAX_UNICODE_CODEPOINT) {
    return originalMatch;
  }
  try {
    return String.fromCodePoint(cp);
  } catch {
    return originalMatch;
  }
}

function decodeEntitiesOnce(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => NAMED_XML_ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) =>
      safeFromCodePoint(parseInt(hex, 16), m)
    )
    .replace(/&#(\d+);/g, (m, dec) =>
      safeFromCodePoint(parseInt(dec, 10), m)
    );
}

export function decodeCaptionEntities(text: string): string {
  const once = decodeEntitiesOnce(text);
  if (once === text) return once;
  return decodeEntitiesOnce(once);
}

// 11-char YouTube video IDs. Covers watch, youtu.be shortlink, Shorts,
// and embed forms. Hostless so m.youtube.com / music.youtube.com flow
// through the same patterns.
const VIDEO_ID_PATTERNS: readonly RegExp[] = [
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /[?&]v=([a-zA-Z0-9_-]{11})/,
  /\/shorts\/([a-zA-Z0-9_-]{11})/,
  /\/embed\/([a-zA-Z0-9_-]{11})/,
];

export function extractVideoId(url: string): string | null {
  for (const pattern of VIDEO_ID_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// youtube-transcript-plus matches a requested `lang` against the provider's
// track code with strict equality. When the library reports a language miss,
// `availableLangs` contains the provider's actual track tokens. Parse those
// tokens into canonical identities for selection, but retain each bounded raw
// token so a strict retry uses exactly the spelling the provider advertised.
// A specific request must not downgrade to a sibling provider track.
// Provider spelling is never exposed beyond this adapter.
const MAX_PROVIDER_LANGUAGE_TOKEN_LENGTH = 64;

type ProviderCaptionTrack = Readonly<{
  readonly languageTag: LanguageTag;
  readonly rawToken: string;
}>;

function parseProviderCaptionTrack(input: unknown): ProviderCaptionTrack | null {
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
): ProviderCaptionTrack | null {
  const tracks = available
    .map(parseProviderCaptionTrack)
    .filter((track): track is ProviderCaptionTrack => track !== null);

  const exact = tracks.find((track) =>
    areLanguageTagsEqual(track.languageTag, requested),
  );
  if (exact) return exact;

  // Only a bare primary tag permits a same-primary fallback. A specific
  // script, region, or variant request must remain an exact identity match.
  if (requested.tag !== requested.primaryLanguageCode) return null;

  return (
    tracks.find((track) =>
      haveSamePrimaryLanguage(track.languageTag, requested),
    ) ?? null
  );
}

// Errors the library raises for "this video genuinely has no captions" —
// expected outcomes that callers handle with a Whisper fallback. Anything
// else (TypeError from schema drift, fetch abort, parse failure) is an
// operational problem that should surface, not silently degrade to paid
// transcription on every request.
const EXPECTED_NO_CAPTIONS_ERRORS = [
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptInvalidVideoIdError,
] as const;

export function isExpectedNoCaptions(err: unknown): boolean {
  return EXPECTED_NO_CAPTIONS_ERRORS.some((cls) => err instanceof cls);
}

// zh-CN and zh-TW both map to "zh" — the downstream prompt templates use
// a single "zh" locale. Unknown locales default to "en" because that's
// the only prompt template guaranteed to exist; the warning is so we can
// audit miss rate and decide whether to add ja/ko/etc.
export function pickLocale(
  segments: readonly YtTranscriptSegment[],
  videoId?: string,
  requestId?: string
): PromptLocale {
  const rawLang = segments[0]?.lang;
  const parsedTag = parseLanguageTag(rawLang);
  if (!parsedTag.ok) {
    logServiceEvent("warn", "captions.unknown_locale", {
      requestId,
      videoId,
      reason: rawLang === undefined ? "missing" : parsedTag.reason,
    });
    return "en";
  }

  const { languageTag } = parsedTag;
  if (languageTag.primaryLanguageCode === "zh") return "zh";
  if (languageTag.primaryLanguageCode !== "en") {
    logServiceEvent("warn", "captions.unknown_locale", {
      requestId,
      videoId,
      lang: languageTag.tag,
    });
  }

  return "en";
}

/**
 * Fetch auto-captions for a YouTube URL.
 *
 * When `lang` is provided, forwards it to the library so the specific
 * caption track is selected instead of `tracks[0]` (which YouTube can
 * order arbitrarily — the bug that produced Arabic for French videos).
 *
 * Returns `null` for the expected "no captions available" outcome (the
 * frontend falls back to Whisper transcription). Throws on unexpected
 * library or network failures so the route can return 5xx — a blanket
 * `null` here would trigger a silent Whisper fallback on every bug,
 * hiding real problems behind compute bills.
 */
export async function fetchCaptions(
  youtubeUrl: string,
  lang?: LanguageTag,
  requestId?: string,
  signal?: AbortSignal,
): Promise<CaptionResult | null> {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) return null;

  let result: TranscriptResult;
  try {
    const response = await fetchTranscript(videoId, {
      videoDetails: true,
      ...(lang ? { lang: lang.tag } : {}),
      ...(signal ? { signal } : {}),
    });
    result = response as TranscriptResult;
  } catch (err) {
    signal?.throwIfAborted();
    // A strict provider miss may still have a canonical exact track (or,
    // for a bare primary request only, a same-primary track) in the ordered
    // available list. Retry once with that track's exact provider token.
    if (lang && err instanceof YoutubeTranscriptNotAvailableLanguageError) {
      const availableLangs = Array.isArray(err.availableLangs)
        ? err.availableLangs
        : [];
      const matched = selectProviderRetryTrack(lang, availableLangs);
      if (!matched) return null;
      logServiceEvent("warn", "captions.CAPTION_LANG_RETRY_PRIMARY_SUBTAG", {
        errorId: "CAPTION_LANG_RETRY_PRIMARY_SUBTAG",
        requestId,
        videoId,
        requested: lang.tag,
        matched: matched.rawToken,
        availableCount: availableLangs.length,
      });
      try {
        const retryResponse = await fetchTranscript(videoId, {
          videoDetails: true,
          lang: matched.rawToken,
          ...(signal ? { signal } : {}),
        });
        result = retryResponse as TranscriptResult;
      } catch (retryErr) {
        signal?.throwIfAborted();
        if (isExpectedNoCaptions(retryErr)) return null;
        logServiceEvent("error", "captions.CAPTION_UNEXPECTED_FAILURE", {
          errorId: "CAPTION_UNEXPECTED_FAILURE",
          requestId,
          videoId,
          errorClass:
            retryErr instanceof Error
              ? retryErr.constructor.name
              : typeof retryErr,
          originalLang: lang.tag,
          retryLang: matched.rawToken,
        });
        throw retryErr;
      }
    } else if (isExpectedNoCaptions(err)) {
      return null;
    } else {
      logServiceEvent("error", "captions.CAPTION_UNEXPECTED_FAILURE", {
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        requestId,
        videoId,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      });
      throw err;
    }
  }

  const { segments: ytSegments, videoDetails } = result;
  if (!ytSegments || ytSegments.length === 0) {
    // Library reported success but handed back no segments. Usually this
    // means the video genuinely has no captions, but a YouTube schema
    // shift ("segments array now lives under .tracks") could hit this
    // path silently. Log so a rising rate is detectable before a wave
    // of unnecessary Whisper fallbacks hits the compute bill.
    logServiceEvent("warn", "captions.empty_segments", {
      errorId: "CAPTION_EMPTY_SEGMENTS",
      requestId,
      videoId,
    });
    return null;
  }

  // Keep only segments whose text contains visible characters. A track of
  // pure-whitespace lines (music-cue videos) yields no useful transcript
  // and should fall back to Whisper rather than persist an empty string
  // through the pipeline.
  const segments: TranscriptSegment[] = ytSegments
    .filter((s) => s.text.trim().length > 0)
    .map((s) => ({
      text: decodeCaptionEntities(s.text),
      start: s.offset,
      duration: s.duration,
    }));

  if (segments.length === 0) {
    logServiceEvent("warn", "captions.empty_transcript", {
      errorId: "CAPTION_EMPTY_TRANSCRIPT",
      requestId,
      videoId,
      segmentCount: ytSegments.length,
    });
    return null;
  }

  return {
    segments,
    source: "auto_captions",
    language: pickLocale(ytSegments, videoId, requestId),
    title: videoDetails?.title ?? null,
    channelName: videoDetails?.author ?? null,
  };
}
