import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  normalizeLanguageCode,
  extractAvailableCaptions,
  type YtdlpMetadata,
} from "../language-detect.js";

const base: YtdlpMetadata = {
  title: "",
  description: "",
  language: null,
  subtitles: {},
  automatic_captions: {},
};

describe("normalizeLanguageCode", () => {
  it.each([
    ["en", "en"],
    ["EN", "en"],
    ["en-US", "en"],
    ["en-gb", "en"],
    ["fr-FR", "fr"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh"],
    ["zh-Hans", "zh"],
    // ISO 639-3 three-letter codes franc returns — map to 639-1 where we
    // have a concrete mapping. Unknown 639-3 codes pass through unchanged
    // rather than silently collapsing to "en", so the caller can log + fall
    // through to the ultimate fallback instead of masking an unknown lang
    // as English.
    ["fra", "fr"],
    ["eng", "en"],
    ["cmn", "zh"],
    ["spa", "es"],
    ["jpn", "ja"],
    ["kor", "ko"],
    ["deu", "de"],
    ["por", "pt"],
    ["rus", "ru"],
    ["ita", "it"],
    ["ara", "ar"],
    ["hin", "hi"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeLanguageCode(input)).toBe(expected);
  });

  it("returns null for empty / und / bogus input", () => {
    expect(normalizeLanguageCode("")).toBeNull();
    expect(normalizeLanguageCode("und")).toBeNull();
    expect(normalizeLanguageCode(null)).toBeNull();
    expect(normalizeLanguageCode(undefined)).toBeNull();
  });
});

describe("detectLanguage", () => {
  it("trusts the yt-dlp `language` field when present (highest priority)", () => {
    const result = detectLanguage({
      ...base,
      language: "fr",
      description: "This is clearly English text, lots of it, more than enough",
    });
    // Even when description language disagrees, the uploader-specified
    // `language` field wins — it's authoritative while text detection is
    // heuristic.
    expect(result).toBe("fr");
  });

  it("normalizes yt-dlp `language` to ISO 639-1 primary subtag", () => {
    expect(detectLanguage({ ...base, language: "zh-Hans" })).toBe("zh");
    expect(detectLanguage({ ...base, language: "en-US" })).toBe("en");
  });

  it("uses the sole manually-uploaded subtitle track as signal when language is absent", () => {
    const result = detectLanguage({
      ...base,
      subtitles: { fr: [{ url: "x", ext: "vtt" }] },
    });
    expect(result).toBe("fr");
  });

  it("does NOT use subtitles when multiple manual tracks exist (ambiguous)", () => {
    // Uploaders commonly upload BOTH the source language and an English
    // translation — picking one arbitrarily would reintroduce the exact
    // bug class we're fixing.
    const result = detectLanguage({
      ...base,
      subtitles: {
        fr: [{ url: "x", ext: "vtt" }],
        en: [{ url: "y", ext: "vtt" }],
      },
      description:
        "Ceci est un texte en français suffisamment long pour que la détection fonctionne correctement.",
    });
    expect(result).toBe("fr");
  });

  it("falls back to text detection on description + title", () => {
    const result = detectLanguage({
      ...base,
      title: "Comment apprendre la programmation",
      description:
        "Ceci est un texte en français suffisamment long pour que la détection fonctionne correctement. Nous allons explorer les bases du développement logiciel et des concepts essentiels.",
    });
    expect(result).toBe("fr");
  });

  it("detects Chinese via text detection and collapses to zh", () => {
    const result = detectLanguage({
      ...base,
      title: "如何学习编程",
      description:
        "这是一段中文文字，用于测试语言检测功能。我们将探讨编程的基础知识和一些重要的概念。请仔细阅读以下内容。",
    });
    expect(result).toBe("zh");
  });

  it("falls back to 'en' when text is too short for confident detection", () => {
    const result = detectLanguage({ ...base, title: "Hi", description: "" });
    expect(result).toBe("en");
  });

  it("does NOT treat automatic_captions keys as a language signal", () => {
    // YouTube populates automatic_captions with many translated variants
    // regardless of the source language. Trusting this field would let a
    // captioned French video get labelled English (alphabetically first)
    // or arbitrary.
    const result = detectLanguage({
      ...base,
      automatic_captions: {
        ar: [{ url: "x", ext: "vtt" }],
        en: [{ url: "x", ext: "vtt" }],
        fr: [{ url: "x", ext: "vtt" }],
      },
    });
    expect(result).toBe("en"); // ultimate fallback (no other signal)
  });
});

describe("extractAvailableCaptions", () => {
  it("returns union of subtitles and automatic_captions keys, normalized", () => {
    const result = extractAvailableCaptions({
      ...base,
      subtitles: { fr: [{ url: "x", ext: "vtt" }] },
      automatic_captions: {
        "en-US": [{ url: "x", ext: "vtt" }],
        "zh-CN": [{ url: "x", ext: "vtt" }],
      },
    });
    expect(result).toEqual(expect.arrayContaining(["fr", "en", "zh"]));
    // Deduplicated: same normalized code shouldn't appear twice.
    expect(result.length).toBe(new Set(result).size);
  });

  it("returns empty array when both dicts are empty", () => {
    expect(extractAvailableCaptions(base)).toEqual([]);
  });
});
