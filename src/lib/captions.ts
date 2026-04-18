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

// The Vercel side previously called this library directly — but Vercel's
// serverless egresses from AWS datacenter IPs, which YouTube strips
// caption-track URLs for. Running it from this service (which has
// residential egress via the Tailscale exit node) actually gets captions.
// This endpoint is the caption-fetch half of what used to live in the
// frontend's caption-extractor.ts.

export type PromptLocale = "en" | "zh";

export interface CaptionResult {
  readonly transcript: string;
  readonly source: "auto_captions";
  readonly language: PromptLocale;
  readonly title: string;
  readonly channelName: string;
}

// youtu.be shortlinks + watch?v= + shorts URLs — whatever yt-dlp accepts,
// we accept. Kept simple: extract the 11-char video ID.
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

// Errors that mean "no usable captions" — distinct from "caption library
// blew up unexpectedly". Callers upstream rely on this distinction to
// decide whether to fall back to Whisper (expected) or alert (unexpected).
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
// a single "zh" locale. Everything else falls through to "en".
function pickLocale(segments: readonly TranscriptSegment[]): PromptLocale {
  const lang = segments[0]?.lang ?? "";
  return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

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
    if (!isExpectedNoCaptions(err)) {
      // Alertable: unexpected failures silently fall back to Whisper
      // transcription, which costs compute + Mac-tunnel bandwidth.
      console.error("[captions] CAPTION_UNEXPECTED_FAILURE", {
        errorId: "CAPTION_UNEXPECTED_FAILURE",
        videoId,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        err,
      });
    }
    return null;
  }

  const { segments, videoDetails } = result;
  if (!segments || segments.length === 0) return null;

  const transcript = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!transcript) return null;

  return {
    transcript,
    source: "auto_captions",
    language: pickLocale(segments),
    title: videoDetails?.title ?? "",
    channelName: videoDetails?.author ?? "",
  };
}
