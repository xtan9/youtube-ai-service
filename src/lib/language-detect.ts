import { franc } from "franc";

// Minimum character count before we trust franc's output. Below this, franc's
// trigram model produces noisy results (short text often mis-detects as an
// exotic language). 30 chars is the library's own documented threshold.
const MIN_TEXT_DETECTION_LENGTH = 30;

// Codes we map from franc's ISO 639-3 output to ISO 639-1 (what whisper and
// YouTube caption tracks use). Only languages with concrete 639-1 mappings —
// unlisted 639-3 codes pass through unchanged so the caller can log and
// fall through to the ultimate fallback rather than silently lying.
//
// Exported as a const for cross-module parity tests (every 639-1 value
// here must have a matching anchor in language-prompt.ts). Not intended
// for runtime mutation.
export const ISO_639_3_TO_1: Record<string, string> = {
  eng: "en",
  cmn: "zh",
  fra: "fr",
  spa: "es",
  jpn: "ja",
  kor: "ko",
  deu: "de",
  por: "pt",
  rus: "ru",
  ita: "it",
  ara: "ar",
  hin: "hi",
  nld: "nl",
  tur: "tr",
  vie: "vi",
  ind: "id",
  tha: "th",
  pol: "pl",
  ukr: "uk",
  swe: "sv",
  dan: "da",
  nor: "no",
  fin: "fi",
  ces: "cs",
  ell: "el",
  heb: "he",
  ron: "ro",
  hun: "hu",
};

export interface YtdlpCaptionTrack {
  readonly url: string;
  readonly ext: string;
}

// Subset of yt-dlp JSON we actually consume. Accepting arbitrary extra keys
// keeps us forward-compatible with yt-dlp schema changes.
export interface YtdlpMetadata {
  readonly title: string;
  readonly description: string;
  readonly language: string | null;
  // Length in seconds (non-negative finite, may be fractional).
  // `null` for live streams, omitted payloads, and any non-finite or
  // negative value rejected by the normalizer — callers that gate
  // behavior on duration must treat null as "unknown" and fall
  // through, never as zero (which would unconditionally pass any
  // "too long?" check).
  readonly duration: number | null;
  readonly subtitles: Readonly<Record<string, readonly YtdlpCaptionTrack[]>>;
  readonly automatic_captions: Readonly<
    Record<string, readonly YtdlpCaptionTrack[]>
  >;
}

// yt-dlp / franc sentinels that mean "no linguistic content" or "ambiguous" —
// forwarding any of these to whisper as `--language zxx` produces a cryptic
// CLI error. Treat as "no signal" and let callers fall through.
const LANGUAGE_SENTINELS: ReadonlySet<string> = new Set([
  "und", // undetermined — franc's "couldn't detect" output
  "zxx", // no linguistic content — yt-dlp uses this for music-only tracks
  "mul", // multiple languages
  "mis", // uncoded languages
]);

/**
 * Normalize a language tag to ISO 639-1 primary subtag (lowercase 2-letter).
 * Accepts BCP-47 2-letter-primary tags (`en-US` → `en`, `zh-Hans` → `zh`)
 * through the regex branch, and ISO 639-3 3-letter codes (`fra` → `fr`) via
 * the mapping table. Returns `null` for empty, sentinels (und/zxx/mul/mis),
 * or unrecognized codes — callers treat null as "no signal" and fall through.
 */
export function normalizeLanguageCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const lower = code.toLowerCase().trim();
  if (!lower || LANGUAGE_SENTINELS.has(lower)) return null;

  // Primary subtag already: "en", "fr", etc. Accept any 2-char lowercase.
  if (/^[a-z]{2}$/.test(lower)) return lower;

  // BCP-47 with region/script: "en-US", "zh-Hans". Take the primary subtag.
  const match = lower.match(/^([a-z]{2,3})(?:-.+)?$/);
  if (!match) return null;
  const primary = match[1];

  if (primary.length === 2) return primary;

  // ISO 639-3 three-letter: map via table, else null (no silent fallback —
  // callers can log and try the next signal).
  return ISO_639_3_TO_1[primary] ?? null;
}

/**
 * Derive the video's language from yt-dlp metadata. Priority order:
 *   1. `language` field (uploader-specified, authoritative).
 *   2. Sole manually-uploaded subtitle track (2+ tracks is ambiguous — a
 *      French-source uploader often ships fr + en, and picking one
 *      arbitrarily reintroduces the tracks[0] bug class).
 *   3. Text detection on description + title via franc (heuristic fallback).
 *   4. `"en"` ultimate fallback, with a warn log so a high miss rate is
 *      observable in production (a rising rate is a detection-quality
 *      regression or a corpus of metadata-sparse videos we should fix).
 *
 * `automatic_captions` is NOT used as a signal — YouTube populates it with
 * many auto-translations regardless of source language.
 */
export function detectLanguage(metadata: YtdlpMetadata): string {
  const fromLanguage = normalizeLanguageCode(metadata.language);
  if (fromLanguage) return fromLanguage;

  const subtitleKeys = Object.keys(metadata.subtitles);
  if (subtitleKeys.length === 1) {
    const normalized = normalizeLanguageCode(subtitleKeys[0]);
    if (normalized) return normalized;
    // Unnormalizable single key (e.g. "??", "zxx") — fall through to
    // text detection rather than trusting the bogus signal.
  }

  const text = `${metadata.title ?? ""} ${metadata.description ?? ""}`.trim();
  let francResult: string | null = null;
  if (text.length >= MIN_TEXT_DETECTION_LENGTH) {
    francResult = franc(text);
    const normalized = normalizeLanguageCode(francResult);
    if (normalized) return normalized;
  }

  // Everything failed. Log the fallback so a rising miss rate is alertable —
  // a silent "en" here defeats the PR's purpose of pinning the right
  // language to whisper.
  console.warn("[language-detect] fallback to en (no usable signal)", {
    errorId: "LANGUAGE_DETECT_FALLBACK",
    hasLanguageField: Boolean(metadata.language),
    subtitleKeyCount: subtitleKeys.length,
    textLength: text.length,
    francResult,
  });
  return "en";
}

/**
 * Collect every caption language the video has at least one track for —
 * union of `subtitles` and `automatic_captions` keys, normalized to ISO
 * 639-1, deduplicated. Feeds the orchestrator's "try English as a
 * fallback before whisper" decision.
 */
export function extractAvailableCaptions(metadata: YtdlpMetadata): string[] {
  const codes = new Set<string>();
  for (const key of Object.keys(metadata.subtitles)) {
    const normalized = normalizeLanguageCode(key);
    if (normalized) codes.add(normalized);
  }
  for (const key of Object.keys(metadata.automatic_captions)) {
    const normalized = normalizeLanguageCode(key);
    if (normalized) codes.add(normalized);
  }
  return Array.from(codes);
}
