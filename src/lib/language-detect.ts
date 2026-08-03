import { eld } from "eld/extrasmall";
import type { YtdlpMetadata } from "./ytdlp-metadata.js";

// Codes the prior franc-based implementation could return as ISO 639-3.
// Kept as a const for cross-module parity tests (every 639-1 value here
// must have a matching anchor in language-prompt.ts) and for
// `normalizeLanguageCode` to translate any 3-letter codes a caller
// happens to pass through. Not used by the new eld-based detection
// path — eld returns ISO 639-1 directly.
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

// yt-dlp / detector sentinels that mean "no linguistic content" or
// "ambiguous" — forwarding any of these to whisper as `--language zxx`
// produces a cryptic CLI error. Treat as "no signal" and let callers
// fall through. eld reports "no detection" by returning the empty
// string, not a sentinel — so the und/mul/mis entries are
// defensive-only for callers passing these tags through
// `normalizeLanguageCode` (yt-dlp can emit `language: "zxx"` for
// music-only tracks).
const LANGUAGE_SENTINELS: ReadonlySet<string> = new Set([
  "und", // undetermined
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

// Hiragana (぀–ゟ) and Katakana (゠–ヿ) are
// Japanese-only — not present in Chinese or Korean. Match before Han
// because Japanese also uses Han chars (kanji), but the presence of
// even one kana char is unambiguous evidence of Japanese.
const JAPANESE_KANA_RE = /[぀-ゟ゠-ヿ]/;
// Hangul syllables (가–힯) and Jamo (ᄀ–ᇿ) are
// Korean-only.
const KOREAN_HANGUL_RE = /[가-힯ᄀ-ᇿ]/;
// CJK Unified Ideographs (一–鿿) — used by Chinese (and
// Japanese kanji, but kana check above pre-empts that case). Applied
// to the title + description concatenation; even one Han char
// outweighs an ambiguous Latin / mixed-script eld guess (e.g.
// "极海Channel" — eld returns French with isReliable=true, but a
// single Han char is unambiguous Chinese signal). Doesn't cover CJK
// Extension A (U+3400-U+4DBF) or B+ (U+20000+) — vanishingly rare for
// YouTube titles and eld picks up the long tail; revisit if
// LANGUAGE_DETECT_FALLBACK warns surface those characters.
const HAN_RE = /[一-鿿]/;

/**
 * Script-based language detection. Returns null when no CJK script
 * is present so the caller can fall through to eld for Latin / other
 * scripts. Order matters: kana → ja before han → zh because Japanese
 * uses both kana and kanji and we want the more specific signal to win.
 */
function detectByScript(text: string): string | null {
  if (JAPANESE_KANA_RE.test(text)) return "ja";
  if (KOREAN_HANGUL_RE.test(text)) return "ko";
  if (HAN_RE.test(text)) return "zh";
  return null;
}

/**
 * Detect language from text using eld with a CJK script-range fallback
 * for short titles. Returns ISO 639-1 or null. Trusts eld even when
 * `isReliable()` returns false — for short Latin titles like "Hello"
 * or "Gracias" the unreliable detection is still better than a "no
 * signal" null that forces callers into a bare auto-detect on the
 * audio path. eld's empty-string return (no detection at all) maps to
 * null so the caller can decide.
 *
 * Script detection runs *before* eld for CJK text because eld gets
 * confused by short mixed-script titles — "极海Channel" is detected as
 * French with isReliable=true, but a single Han char is unambiguous
 * Chinese signal. Matches the bug class captured on hrREdNm7vB4 where
 * the title (~18 Chinese chars) was below franc's 30-char threshold
 * and fell through to the "en" fallback.
 */
function detectFromText(text: string): string | null {
  if (!text.trim()) return null;
  const fromScript = detectByScript(text);
  if (fromScript) return fromScript;
  const result = eld.detect(text);
  // Per spec: trust eld.language even when isReliable() is false —
  // unreliable Latin-script detection beats null for our use case
  // because the language hint then propagates to whisper's prompt
  // anchor, which biases output even on uncertain detection.
  const normalized = normalizeLanguageCode(result.language);
  return normalized;
}

/**
 * Derive the video's language from yt-dlp metadata. Priority order:
 *   1. `language` field (uploader-specified, authoritative).
 *   2. Sole manually-uploaded subtitle track (2+ tracks is ambiguous — a
 *      French-source uploader often ships fr + en, and picking one
 *      arbitrarily reintroduces the tracks[0] bug class).
 *   3. Text detection (CJK script range → eld) on title + description.
 *   4. Returns null when every signal failed — callers should log and
 *      decide. Ultimate-fallback "en" lives in the route layer, not
 *      here, so the function honestly reports "no signal" instead of
 *      lying with a guess.
 *
 * `automatic_captions` is NOT used as a signal — YouTube populates it
 * with many auto-translations regardless of source language.
 */
export function detectLanguage(metadata: YtdlpMetadata): string | null {
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
  return detectFromText(text);
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
