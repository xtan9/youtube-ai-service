import { describe, it, expect } from "vitest";
import { getLanguageAnchorPrompt } from "../language-prompt.js";
import { ISO_639_3_TO_1 } from "../language-detect.js";

describe("getLanguageAnchorPrompt", () => {
  it("returns a non-empty string for every code detectLanguage() can return", () => {
    // detectLanguage() emits values from ISO_639_3_TO_1 plus "en" (the
    // ultimate fallback). Iterating the *imported* map — not a copy —
    // is the parity guard: a future PR that adds e.g. `tgl: "tl"` to
    // ISO_639_3_TO_1 without adding `tl` here will fail this test
    // instead of silently dropping the anchor for that language and
    // reintroducing the drift bug. A hardcoded list would not catch
    // that drift.
    const codes = new Set<string>([...Object.values(ISO_639_3_TO_1), "en"]);
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

  it("returns null for normalizeLanguageCode sentinels", () => {
    // detectLanguage upstream rejects und/zxx/mul/mis at
    // normalizeLanguageCode and won't pass them down — but a manual VPS
    // caller could. Pinning null here means a future map edit can't
    // accidentally wire an anchor to a sentinel code, which would force
    // a wrong-language anchor onto undetected/no-content audio.
    expect(getLanguageAnchorPrompt("und")).toBeNull();
    expect(getLanguageAnchorPrompt("zxx")).toBeNull();
    expect(getLanguageAnchorPrompt("mul")).toBeNull();
    expect(getLanguageAnchorPrompt("mis")).toBeNull();
  });

  it("extracts the primary subtag from BCP-47 input", () => {
    // VPS schema (`languageCodeSchema` in youtube-url.ts) accepts
    // BCP-47 directly. The frontend's `primarySubtag` normalizes
    // before calling, but a direct VPS caller (or a future frontend
    // bug) could ship `zh-Hans`. Without primary-subtag extraction
    // here, that case silently skips the anchor and reintroduces the
    // drift bug for the dominant Chinese variant.
    const zh = getLanguageAnchorPrompt("zh");
    expect(getLanguageAnchorPrompt("zh-Hans")).toEqual(zh);
    expect(getLanguageAnchorPrompt("zh-Hant-TW")).toEqual(zh);
    expect(getLanguageAnchorPrompt("en-US")).toEqual(getLanguageAnchorPrompt("en"));
  });

  it("is case-insensitive", () => {
    // Callers normalize to lowercase but a stray ZH or Zh shouldn't
    // silently fall through to null and break the fix for those
    // call sites.
    expect(getLanguageAnchorPrompt("ZH")).toEqual(getLanguageAnchorPrompt("zh"));
    expect(getLanguageAnchorPrompt("Zh")).toEqual(getLanguageAnchorPrompt("zh"));
    expect(getLanguageAnchorPrompt("ZH-HANS")).toEqual(getLanguageAnchorPrompt("zh"));
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

  it("no anchor matches Whisper's documented meta-template hallucination pattern", () => {
    // Regression guard for the post-#23 finding: the prior anchor form
    // ("The following is a sentence in <X>") matched a Whisper
    // training-data prompt template, and during long silent stretches
    // the model regurgitated that exact phrasing as transcript output
    // — segment 194.03s on hrREdNm7vB4 came back as literally "The
    // following is a sentence in English." Anchors must be natural
    // content openers, not meta-templates, so the failure mode shifts
    // from "obvious meta-phrase" to "plausible video content" if
    // regurgitation does occur. Iterate ISO_639_3_TO_1 (plus "en") so
    // a future PR that adds a new anchor with the bad pattern fails
    // here instead of silently re-introducing the bug.
    const codes = new Set<string>([...Object.values(ISO_639_3_TO_1), "en"]);
    for (const code of codes) {
      const prompt = getLanguageAnchorPrompt(code);
      expect(prompt, `null anchor for ${code}`).toBeTruthy();
      // The English-typed phrasing is what Whisper's training data
      // contains — guarding the literal pattern keeps non-English
      // anchors out too if a future contributor copy-pastes the form
      // and translates word-for-word.
      expect(
        prompt!.toLowerCase().includes("the following is a sentence"),
        `${code} anchor uses the documented regurgitation template`
      ).toBe(false);
    }
  });
});
