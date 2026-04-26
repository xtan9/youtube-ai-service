import { describe, it, expect, vi } from "vitest";
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
  duration: null,
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

  it.each([["zxx"], ["mul"], ["mis"], ["ZXX"], ["Mul"]])(
    "treats yt-dlp sentinel %s as no-signal (null)",
    (code) => {
      // These codes reach whisper as `--language zxx` and produce cryptic
      // CLI errors. Fall through rather than forward garbage.
      expect(normalizeLanguageCode(code)).toBeNull();
    }
  );
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = detectLanguage({ ...base, title: "Hi", description: "" });
    expect(result).toBe("en");
  });

  it("logs LANGUAGE_DETECT_FALLBACK with context when every signal fails", async () => {
    // A silent "en" here defeats the whole point of the PR — a rising
    // miss rate should be alertable. Lock the errorId + context shape
    // so a future refactor can't drop the log.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    detectLanguage({ ...base, title: "Hi", description: "" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("fallback to en"),
      expect.objectContaining({
        errorId: "LANGUAGE_DETECT_FALLBACK",
        hasLanguageField: false,
        subtitleKeyCount: 0,
      })
    );
  });

  it("falls through to text detection when the sole subtitle key is unnormalizable", () => {
    // A subtitle track with a bogus key like "??" must NOT short-circuit
    // the priority chain — the fallback to text detection is the whole
    // point of having multiple signals.
    const result = detectLanguage({
      ...base,
      subtitles: { "??": [{ url: "x", ext: "vtt" }] },
      description:
        "Ceci est un texte en français suffisamment long pour que la détection fonctionne correctement. Nous allons explorer plusieurs concepts.",
    });
    expect(result).toBe("fr");
  });

  it("does NOT treat automatic_captions keys as a language signal", () => {
    // YouTube populates automatic_captions with many translated variants
    // regardless of the source language. Trusting this field would let a
    // captioned French video get labelled English (alphabetically first)
    // or arbitrary.
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
