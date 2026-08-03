import { describe, it, expect, vi } from "vitest";
import {
  detectLanguage,
  normalizeLanguageCode,
  extractAvailableCaptions,
} from "../language-detect.js";
import type { YtdlpMetadata } from "../ytdlp-metadata.js";

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

  it("returns null when text is empty (no signal at all)", () => {
    // The function honestly reports "no signal" instead of guessing "en".
    // The route layer is responsible for mapping null → "en" with a
    // structured warn log; testing the route fallback lives in
    // routes/__tests__/metadata.test.ts so the wire-contract back-compat
    // is pinned independently of the detection internals.
    expect(detectLanguage({ ...base, title: "", description: "" })).toBeNull();
  });

  it("returns eld's best guess for short Latin titles even when unreliable", () => {
    // Per spec: even when eld.isReliable() is false, use result.language
    // for non-CJK short text — an unreliable Latin-script guess beats
    // null because the language hint then propagates to whisper's
    // prompt anchor, biasing output even on uncertain detection.
    // Pin the deterministic case: eld v2/extrasmall on "Gracias"
    // returns "es" (unreliable). A future eld bump that drops short-
    // Latin guesses entirely IS the regression we want surfaced —
    // a `expect(... || null)` disjunction would silently let it slide.
    expect(detectLanguage({ ...base, title: "Gracias", description: "" })).toBe(
      "es"
    );
  });

  it("CJK script fallback overrides eld for short mixed-script titles", () => {
    // Captured failure: "极海Channel" (Chinese channel name + Latin
    // word) is detected by eld as French with isReliable=true. A
    // single Han char is unambiguous Chinese signal — script range
    // check pre-empts eld for any text containing CJK Unified
    // Ideographs / Hiragana / Katakana / Hangul. Same path catches
    // the bug video hrREdNm7vB4 (~18 Chinese chars, below franc's
    // prior 30-char threshold).
    expect(
      detectLanguage({ ...base, title: "极海Channel", description: "" })
    ).toBe("zh");
    expect(
      detectLanguage({
        ...base,
        title: "初级开发别跳槽！最新大裁员4个主要原因！",
        description: "",
      })
    ).toBe("zh");
  });

  it("script fallback distinguishes Japanese (kana) from Chinese (Han only)", () => {
    // Japanese uses both kana and kanji. Pure-Han text → zh; any kana
    // present → ja. Order in detectByScript matters: kana check before
    // Han check so a Japanese title with both scripts isn't
    // misclassified as Chinese.
    expect(
      detectLanguage({
        ...base,
        title: "プログラミングを学ぶ",
        description: "",
      })
    ).toBe("ja");
    expect(
      detectLanguage({
        ...base,
        title: "今日は日本語の話",
        description: "",
      })
    ).toBe("ja");
  });

  it("script fallback returns ko for Hangul", () => {
    expect(
      detectLanguage({
        ...base,
        title: "프로그래밍을 배우자",
        description: "",
      })
    ).toBe("ko");
  });

  it("script fallback handles mixed Hangul + Latin (Korean analog of 极海Channel)", () => {
    // Same mixed-script class as the captured "极海Channel" failure
    // — short text where eld might pick the Latin word and miss the
    // Hangul evidence.
    expect(
      detectLanguage({ ...base, title: "K-Pop 프로그래밍", description: "" })
    ).toBe("ko");
    // Japanese mixed-script with kana (the Japanese-disambiguator)
    // resolves to ja even when adjacent to Latin words. Pure-kanji
    // text without kana would resolve to zh — that's a documented
    // limitation of the script heuristic, not a regression.
    expect(
      detectLanguage({ ...base, title: "Gaming プログラミング講座", description: "" })
    ).toBe("ja");
  });

  it("script fallback fires on description-only signal (no title)", () => {
    // The detection runs on `title + description` so a video with no
    // title and a Chinese description should still resolve to zh. Pins
    // the concatenation behavior; without this, a future refactor
    // could accidentally restrict detection to title only.
    expect(
      detectLanguage({
        ...base,
        title: "",
        description: "这是一段中文描述",
      })
    ).toBe("zh");
  });

  it.each([
    ["whitespace only", "   \t\n  "],
    ["digits only", "12345"],
    ["punctuation only", "!!!???..."],
    ["emoji only", "🔥🔥🔥"],
  ])("returns null for %s (no detectable language signal)", (_label, title) => {
    // None of these contain Han / kana / Hangul, and eld returns ""
    // (no detection) for content-free input. Pin null rather than
    // letting eld's behavior on novel inputs drift through.
    expect(detectLanguage({ ...base, title, description: "" })).toBeNull();
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
    const result = detectLanguage({
      ...base,
      automatic_captions: {
        ar: [{ url: "x", ext: "vtt" }],
        en: [{ url: "x", ext: "vtt" }],
        fr: [{ url: "x", ext: "vtt" }],
      },
    });
    // Returns null — automatic_captions is not used as signal, and
    // there's no title/description to detect from. The route layer
    // maps null → "en" with a structured warn for ops visibility.
    expect(result).toBeNull();
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
