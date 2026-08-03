import {
  parseLanguageTag,
  type PrimaryLanguageCode,
} from "../lib/language-tag.js";

export function primaryLanguageCode(input: string): PrimaryLanguageCode {
  const result = parseLanguageTag(input);
  if (!result.ok) throw new Error(`Expected a language code: ${input}`);
  return result.languageTag.primaryLanguageCode;
}
