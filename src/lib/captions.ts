import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResult,
  type TranscriptSegment,
} from "youtube-transcript-plus";

// Caption fetching must run from an IP YouTube classifies as residential —
// datacenter IPs get caption-track URLs stripped from the watch-page
// response, making every caption fetch look like "no transcripts available".
// This service egresses through the Tailscale exit node (home Mac) which
// gives youtube-transcript-plus the residential presence it needs.

export type PromptLocale = "en" | "zh";

export interface CaptionResult {
  readonly transcript: string;
  readonly source: "auto_captions";
  readonly language: PromptLocale;
  // `null` not `""`: the distinction between "YouTube returned empty" and
  // "we never got videoDetails" matters to the frontend UI, and forcing
  // callers to handle the unknown case at the type level prevents the
  // silent-empty-string bug class.
  readonly title: string | null;
  readonly channelName: string | null;
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
  segments: readonly TranscriptSegment[],
  videoId?: string
): PromptLocale {
  const lang = segments[0]?.lang ?? "";
  const normalized = lang.toLowerCase();
  if (normalized.startsWith("zh")) return "zh";
  if (!normalized.startsWith("en") && normalized !== "") {
    console.warn("[captions] unknown locale falling back to en", {
      videoId,
      lang,
    });
  }
  return "en";
}

/**
 * Fetch auto-captions for a YouTube URL.
 *
 * Returns `null` for the expected "no captions available" outcome (the
 * frontend falls back to Whisper transcription). Throws on unexpected
 * library or network failures so the route can return 5xx — a blanket
 * `null` here would trigger a silent Whisper fallback on every bug,
 * hiding real problems behind compute bills.
 */
export async function fetchCaptions(
  youtubeUrl: string
): Promise<CaptionResult | null> {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) return null;

  let result: TranscriptResult;
  try {
    const response = await fetchTranscript(videoId, { videoDetails: true });
    result = response as TranscriptResult;
  } catch (err) {
    if (isExpectedNoCaptions(err)) return null;
    console.error("[captions] CAPTION_UNEXPECTED_FAILURE", {
      errorId: "CAPTION_UNEXPECTED_FAILURE",
      videoId,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
      err,
    });
    throw err;
  }

  const { segments, videoDetails } = result;
  if (!segments || segments.length === 0) {
    // Library reported success but handed back no segments. Usually this
    // means the video genuinely has no captions, but a YouTube schema
    // shift ("segments array now lives under .tracks") could hit this
    // path silently. Log so a rising rate is detectable before a wave
    // of unnecessary Whisper fallbacks hits the compute bill.
    console.warn("[captions] empty segments array, treating as no_captions", {
      errorId: "CAPTION_EMPTY_SEGMENTS",
      videoId,
    });
    return null;
  }

  const transcript = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!transcript) {
    // All segments were whitespace-only. Rare but real (music-cue
    // videos). Log for the same reason as the empty-segments branch.
    console.warn("[captions] whitespace-only transcript, treating as no_captions", {
      errorId: "CAPTION_EMPTY_TRANSCRIPT",
      videoId,
      segmentCount: segments.length,
    });
    return null;
  }

  return {
    transcript,
    source: "auto_captions",
    language: pickLocale(segments, videoId),
    title: videoDetails?.title ?? null,
    channelName: videoDetails?.author ?? null,
  };
}
