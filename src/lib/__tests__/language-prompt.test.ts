import { describe, expect, it } from "vitest";
import { getLanguageAnchorPrompt } from "../language-prompt.js";
import { primaryLanguageCode as primary } from "../../test-support/language-tag.js";

const representativeAnchorLanguages = ["en", "zh", "ja", "ko", "ar"];

describe("getLanguageAnchorPrompt", () => {
  it("returns native-language anchors for representative supported languages", () => {
    for (const code of representativeAnchorLanguages) {
      const prompt = getLanguageAnchorPrompt(primary(code));
      expect(prompt, `missing anchor for ${code}`).toBeTruthy();
      expect(prompt!.length).toBeGreaterThan(5);
    }
  });

  it("retains explicit unavailability for a valid primary code without an anchor", () => {
    expect(getLanguageAnchorPrompt(primary("cy"))).toBeNull();
  });

  it("returns null when no primary language code is provided", () => {
    expect(getLanguageAnchorPrompt(null)).toBeNull();
    expect(getLanguageAnchorPrompt(undefined)).toBeNull();
  });

  it("selects prompts from the validated primary code", () => {
    const zh = getLanguageAnchorPrompt(primary("zh"));

    expect(getLanguageAnchorPrompt(primary("ZH"))).toEqual(zh);
    expect(getLanguageAnchorPrompt(primary("zh-Hant-TW"))).toEqual(zh);
  });

  it("preserves native-language anchor content", () => {
    expect(getLanguageAnchorPrompt(primary("zh"))).toMatch(/\p{Script=Han}/u);
    expect(getLanguageAnchorPrompt(primary("ja"))).toMatch(
      /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u,
    );
    expect(getLanguageAnchorPrompt(primary("ko"))).toMatch(/\p{Script=Hangul}/u);
    expect(getLanguageAnchorPrompt(primary("ar"))).toMatch(/\p{Script=Arabic}/u);
  });

  it("does not use the old meta-template anchor", () => {
    const banned = [
      "the following is a sentence",
      "the following is",
      "\u4ee5\u4e0b\u662f\u666e\u901a\u8bdd",
      "\u4ee5\u4e0b\u306f",
      "\ub2e4\uc74c\uc740",
      "lo siguiente es",
      "ce qui suit",
      "il seguente \u00e8",
      "a seguir est\u00e1",
      "het volgende is",
      "\u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0435 ",
      "\u0645\u0627 \u064a\u0644\u064a ",
      "\u05dc\u05d4\u05dc\u05df ",
      "a\u015fa\u011f\u0131daki ",
      "sau \u0111\u00e2y l\u00e0",
      "berikut adalah",
      "\u0e15\u0e48\u0e2d\u0e44\u0e1b\u0e19\u0e35\u0e49",
      "poni\u017cej znajduje si\u0119",
      "\u0446\u0435 \u0440\u0435\u0447\u0435\u043d\u043d\u044f",
      "f\u00f6ljande \u00e4r",
      "f\u00f8lgende er",
      "seuraava on",
      "n\u00e1sleduje v\u011bta",
      "\u03c4\u03bf \u03b1\u03ba\u03cc\u03bb\u03bf\u03c5\u03b8\u03bf",
      "urm\u0103toarea este",
      "a k\u00f6vetkez\u0151",
      "\u092f\u0939 \u0939\u093f\u0902\u0926\u0940 \u092e\u0947\u0902 \u090f\u0915 \u0935\u093e\u0915\u094d\u092f",
    ];

    for (const code of representativeAnchorLanguages) {
      const prompt = getLanguageAnchorPrompt(primary(code));
      expect(prompt).toBeTruthy();
      const lower = prompt!.toLowerCase();
      for (const phrase of banned) {
        expect(lower).not.toContain(phrase);
      }
    }
  });
});
