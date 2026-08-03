import { eld } from "eld/extrasmall";
import {
  parseLanguageTag,
  type LanguageTag,
  type PrimaryLanguageCode,
} from "./language-tag.js";
import type { YtdlpMetadata } from "./ytdlp-metadata.js";

// Kept for compatibility with the language-prompt parity test and callers
// that still need to inspect the old detector vocabulary. Provider data and
// detection do not use this table; they use the canonical Language Tag policy.
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

const LANGUAGE_SENTINELS: ReadonlySet<string> = new Set([
  "und",
  "zxx",
  "mul",
  "mis",
]);

/**
 * Compatibility wrapper for the previous detector helper. New provider
 * callers must use parseLanguageTag so they retain the complete tag.
 */
export function normalizeLanguageCode(
  code: string | null | undefined,
): string | null {
  if (!code || LANGUAGE_SENTINELS.has(code.toLowerCase())) return null;
  const parsed = parseLanguageTag(code);
  return parsed.ok ? parsed.languageTag.primaryLanguageCode : null;
}

// Hiragana and Katakana are Japanese-only. Check them before Han because
// Japanese also uses Han characters.
const JAPANESE_KANA_RE = /[\u3040-\u30ff]/;
// Hangul syllables and Jamo are Korean-only.
const KOREAN_HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
// CJK Unified Ideographs provide a useful Chinese fallback for short titles.
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function languageTagFromPrimary(primary: string): LanguageTag | null {
  const parsed = parseLanguageTag(primary);
  return parsed.ok ? parsed.languageTag : null;
}

/**
 * Script-based detection. It returns a primary-only Language Tag when the
 * script is decisive and leaves Latin or other scripts to eld.
 */
function detectByScript(text: string): LanguageTag | null {
  if (JAPANESE_KANA_RE.test(text)) return languageTagFromPrimary("ja");
  if (KOREAN_HANGUL_RE.test(text)) return languageTagFromPrimary("ko");
  if (HAN_RE.test(text)) return languageTagFromPrimary("zh");
  return null;
}

/**
 * Detect a primary-only Language Tag from title and description text. CJK
 * script detection retains its priority over eld for short mixed-script
 * titles, and eld's best guess remains useful even when it is unreliable.
 */
function detectFromText(text: string): LanguageTag | null {
  if (!text.trim()) return null;

  const fromScript = detectByScript(text);
  if (fromScript) return fromScript;

  const result = eld.detect(text);
  return languageTagFromPrimary(result.language);
}

/**
 * Derive the video's source language using the established priority:
 * uploader language, one manual Caption Track language, then text detection.
 * Automatic Caption Track languages never act as source-language evidence.
 */
export function detectLanguage(metadata: YtdlpMetadata): LanguageTag | null {
  if (metadata.language) return metadata.language;

  if (metadata.subtitles.length === 1) {
    const [subtitle] = metadata.subtitles;
    if (subtitle) return subtitle.languageTag;
  }

  const text = `${metadata.title ?? ""} ${metadata.description ?? ""}`.trim();
  return detectFromText(text);
}

/**
 * Collect manually uploaded and automatic Caption Track languages in provider
 * order, deduplicated by their lowercase two-letter Primary Language Code.
 */
export function extractAvailableCaptions(
  metadata: YtdlpMetadata,
): PrimaryLanguageCode[] {
  const codes = new Set<PrimaryLanguageCode>();
  for (const caption of metadata.subtitles) {
    codes.add(caption.languageTag.primaryLanguageCode);
  }
  for (const caption of metadata.automatic_captions) {
    codes.add(caption.languageTag.primaryLanguageCode);
  }
  return Array.from(codes);
}
