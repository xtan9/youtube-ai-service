import { describe, it, expect } from "vitest";
import { getLanguageAnchorPrompt } from "../language-prompt.js";

describe("getLanguageAnchorPrompt", () => {
  it("returns a non-empty string for every detectLanguage()-returnable code", () => {
    // detectLanguage() in language-detect.ts can return any value in its
    // ISO_639_3_TO_1 map plus "en" (final fallback). This test pins the
    // contract that every such code has an anchor — a missing entry would
    // silently fall through to flag-only pinning and reintroduce the
    // hallucination bug for that language.
    const codes = [
      "en", "zh", "fr", "es", "ja", "ko", "de", "pt", "ru", "it",
      "ar", "hi", "nl", "tr", "vi", "id", "th", "pl", "uk", "sv",
      "da", "no", "fi", "cs", "el", "he", "ro", "hu",
    ];
    for (const code of codes) {
      const prompt = getLanguageAnchorPrompt(code);
      expect(prompt, `missing anchor for ${code}`).toBeTruthy();
      expect(prompt!.length).toBeGreaterThan(5);
    }
  });

  it("returns null for unknown codes (caller falls through to flag-only pinning)", () => {
    // Welsh — valid ISO 639-1 but not in our map. Returning null lets
    // the caller decide; sending a wrong-language anchor would actively
    // reintroduce the drift bug.
    expect(getLanguageAnchorPrompt("cy")).toBeNull();
  });

  it("returns null for null/undefined/empty inputs", () => {
    expect(getLanguageAnchorPrompt(null)).toBeNull();
    expect(getLanguageAnchorPrompt(undefined)).toBeNull();
    expect(getLanguageAnchorPrompt("")).toBeNull();
    expect(getLanguageAnchorPrompt("  ")).toBeNull();
  });

  it("is case-insensitive", () => {
    // Callers normalize to lowercase but a stray ZH or Zh shouldn't
    // silently fall through to null and break the fix for those
    // call sites.
    expect(getLanguageAnchorPrompt("ZH")).toEqual(getLanguageAnchorPrompt("zh"));
    expect(getLanguageAnchorPrompt("Zh")).toEqual(getLanguageAnchorPrompt("zh"));
  });

  it("zh anchor contains CJK characters", () => {
    // Sanity: catches the bug where someone "fixes" an encoding issue
    // by replacing CJK chars with English placeholders — that would
    // make the anchor *cause* the drift bug instead of preventing it.
    const prompt = getLanguageAnchorPrompt("zh");
    expect(prompt).toMatch(/[一-鿿]/);
  });

  it("ja anchor contains Japanese script", () => {
    const prompt = getLanguageAnchorPrompt("ja");
    // Hiragana, katakana, or kanji block — at least one must be present.
    expect(prompt).toMatch(/[぀-ゟ゠-ヿ一-鿿]/);
  });

  it("ko anchor contains Hangul", () => {
    const prompt = getLanguageAnchorPrompt("ko");
    expect(prompt).toMatch(/[가-힯]/);
  });

  it("ar anchor contains Arabic script", () => {
    const prompt = getLanguageAnchorPrompt("ar");
    expect(prompt).toMatch(/[؀-ۿ]/);
  });
});
