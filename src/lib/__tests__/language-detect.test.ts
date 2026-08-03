import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  extractAvailableCaptions,
} from "../language-detect.js";
import { captionLanguage, createYtdlpMetadata, languageTag } from "../../test-support/language-metadata.js";

describe("detectLanguage", () => {
  it("preserves uploader Language Tag detail at the highest priority", () => {
    const result = detectLanguage(
      createYtdlpMetadata({
        language: languageTag("fr-FR"),
        description: "This is clearly English text with a conflicting hint.",
        subtitles: [captionLanguage("en")],
      }),
    );

    expect(result).toEqual({
      tag: "fr-FR",
      primaryLanguageCode: "fr",
    });
  });

  it("uses the sole manually uploaded Caption Track as full-tag evidence", () => {
    const result = detectLanguage(
      createYtdlpMetadata({
        subtitles: [captionLanguage("zh-Hans-CN")],
      }),
    );

    expect(result?.tag).toBe("zh-Hans-CN");
    expect(result?.primaryLanguageCode).toBe("zh");
  });

  it("keeps multiple manual Caption Tracks ambiguous and falls through to text", () => {
    const result = detectLanguage(
      createYtdlpMetadata({
        subtitles: [captionLanguage("fr"), captionLanguage("en")],
        description:
          "Ceci est un texte en francais suffisamment long pour que la detection fonctionne correctement. Nous explorons plusieurs concepts.",
      }),
    );

    expect(result?.tag).toBe("fr");
    expect(result?.primaryLanguageCode).toBe("fr");
  });

  it("falls back to CJK script detection and returns a primary-only Language Tag", () => {
    const result = detectLanguage(
      createYtdlpMetadata({
        title: "\u521d\u7ea7\u5f00\u53d1\u522b\u8df3\u69fd",
        description: "\u8fd9\u662f\u4e00\u6bb5\u4e2d\u6587\u6587\u5b57\u3002",
      }),
    );

    expect(result).toEqual({ tag: "zh", primaryLanguageCode: "zh" });
  });

  it("keeps Japanese and Korean script detection ahead of generic text detection", () => {
    expect(
      detectLanguage(
        createYtdlpMetadata({ title: "\u30d7\u30ed\u30b0\u30e9\u30df\u30f3\u30b0\u3092\u5b66\u3076" }),
      )?.tag,
    ).toBe("ja");
    expect(
      detectLanguage(
        createYtdlpMetadata({ title: "\ud504\ub85c\uadf8\ub798\ubc0d\uc744 \ubc30\uc6b0\uc790" }),
      )?.tag,
    ).toBe("ko");
  });

  it("trusts eld's best guess for a short Latin title", () => {
    expect(
      detectLanguage(createYtdlpMetadata({ title: "Gracias" }))?.tag,
    ).toBe("es");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   \t\n"],
    ["digits", "12345"],
    ["punctuation", "!!!???"],
    ["emoji", "\ud83d\udd25\ud83d\udd25"],
  ])("returns absence for %s text with no usable signal", (_label, title) => {
    expect(detectLanguage(createYtdlpMetadata({ title }))).toBeNull();
  });

  it("does not use automatic Caption Track languages as source evidence", () => {
    expect(
      detectLanguage(
        createYtdlpMetadata({
          automatic_captions: [
            captionLanguage("ar"),
            captionLanguage("en"),
            captionLanguage("fr"),
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("extractAvailableCaptions", () => {
  it("returns normalized Primary Language Codes in provider order", () => {
    const result = extractAvailableCaptions(
      createYtdlpMetadata({
        subtitles: [
          captionLanguage("zh-Hans"),
          captionLanguage("zh-Hant-TW"),
          captionLanguage("en-US"),
        ],
        automatic_captions: [
          captionLanguage("fr-FR"),
          captionLanguage("en"),
        ],
      }),
    );

    expect(result).toEqual(["zh", "en", "fr"]);
  });

  it("returns an empty collection when no Caption Tracks exist", () => {
    expect(extractAvailableCaptions(createYtdlpMetadata())).toEqual([]);
  });
});
