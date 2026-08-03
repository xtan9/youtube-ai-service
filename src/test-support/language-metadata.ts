import {
  parseLanguageTag,
  type LanguageTag,
} from "../lib/language-tag.js";
import type {
  YtdlpCaptionLanguage,
  YtdlpCaptionTrack,
  YtdlpMetadata,
} from "../lib/ytdlp-metadata.js";

export function languageTag(input: string): LanguageTag {
  const parsed = parseLanguageTag(input);
  if (!parsed.ok) {
    throw new Error(`Expected a valid Language Tag in test data: ${input}`);
  }
  return parsed.languageTag;
}

export function captionLanguage(
  input: string,
  tracks: readonly YtdlpCaptionTrack[] = [{ url: "x", ext: "vtt" }],
): YtdlpCaptionLanguage {
  return {
    languageTag: languageTag(input),
    tracks,
  };
}

export function createYtdlpMetadata(
  overrides: Partial<YtdlpMetadata> = {},
): YtdlpMetadata {
  return {
    title: "",
    description: "",
    language: null,
    duration: null,
    subtitles: [],
    automatic_captions: [],
    languageTagRejections: [],
    ...overrides,
  };
}
