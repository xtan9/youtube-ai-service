import { describe, expect, it } from "vitest";
import {
  areLanguageTagsEqual,
  haveSamePrimaryLanguage,
  parseLanguageTag,
  type LanguageTag,
  type PrimaryLanguageCode,
} from "../language-tag.js";

const parse = (input: unknown): LanguageTag => {
  const result = parseLanguageTag(input);
  if (!result.ok) {
    throw new Error(`Expected a Language Tag, got ${result.reason}`);
  }
  return result.languageTag;
};

describe("parseLanguageTag", () => {
  it.each([
    ["en", "en", "en"],
    ["EN", "en", "en"],
    ["fra-CA", "fr-CA", "fr"],
    ["zh-hant-tw", "zh-Hant-TW", "zh"],
    ["en-Latn-US", "en-Latn-US", "en"],
    ["de-DE-1996", "de-DE-1996", "de"],
    ["sl-rozaj", "sl-rozaj", "sl"],
  ])(
    "canonicalizes %s to %s with Primary Language Code %s",
    (input, expectedTag, expectedPrimary) => {
      const result = parseLanguageTag(input);

      expect(result).toEqual({
        ok: true,
        languageTag: {
          tag: expectedTag,
          primaryLanguageCode: expectedPrimary,
        },
      });
    },
  );

  it.each([
    ["ENG", "en", "en"],
    ["fra", "fr", "fr"],
    ["cmn", "zh", "zh"],
    ["iw", "he", "he"],
    ["in", "id", "id"],
    ["ji", "yi", "yi"],
    ["mo", "ro", "ro"],
  ])("canonicalizes recognized alias %s to %s", (input, expectedTag, expectedPrimary) => {
    const result = parseLanguageTag(input);

    expect(result).toEqual({
      ok: true,
      languageTag: {
        tag: expectedTag,
        primaryLanguageCode: expectedPrimary,
      },
    });
  });

  it("returns an immutable Language Tag with a branded Primary Language Code", () => {
    const languageTag = parse("ZH-hant-tw");

    expect(Object.isFrozen(languageTag)).toBe(true);
    expect(languageTag.tag).toBe("zh-Hant-TW");
    expect(languageTag.primaryLanguageCode).toBe("zh");

    const primaryLanguageCode: PrimaryLanguageCode =
      languageTag.primaryLanguageCode;
    expect(primaryLanguageCode).toBe("zh");
  });

  const malformedInputs: Array<[string, unknown]> = [
    ["empty", ""],
    ["surrounding leading whitespace", " en"],
    ["surrounding trailing whitespace", "en "],
    ["non-ASCII text", "français"],
    ["overlong text", "en-" + "a".repeat(63)],
    ["underscore separator", "en_US"],
    ["empty subtag", "en--US"],
    ["missing primary", "-US"],
    ["missing trailing subtag", "en-"],
    ["locale extension", "en-u-ca-gregory"],
    ["private-use suffix", "en-x-private"],
    ["private-use-only tag", "x-private"],
  ];

  it.each(malformedInputs)("rejects %s as malformed", (_label, input) => {
    expect(parseLanguageTag(input)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each(["auto", "AUTO", "und", "UND-Latn", "zxx", "ZXX", "mul", "mis"])(
    "rejects sentinel %s as sentinel",
    (input) => {
      expect(parseLanguageTag(input)).toEqual({ ok: false, reason: "sentinel" });
    },
  );

  it.each(["abc", "abc-Latn", "qaa"])(
    "rejects canonical primary %s without a two-letter representation",
    (input) => {
      expect(parseLanguageTag(input)).toEqual({
        ok: false,
        reason: "unsupported-primary",
      });
    },
  );

  it.each([
    "",
    " en",
    "en ",
    "français",
    "en-" + "a".repeat(63),
    "en-u-ca-gregory",
    "en-x-private",
    "auto",
    "und",
    "zxx",
    "mul",
    "mis",
    "abc",
    null,
    undefined,
    42,
    { language: "en" },
  ])("does not throw for untrusted input %p", (input) => {
    expect(() => parseLanguageTag(input)).not.toThrow();
  });
});

describe("Language Tag identity", () => {
  it("compares canonical full-tag identity after alias and casing normalization", () => {
    expect(areLanguageTagsEqual(parse("iw"), parse("HE"))).toBe(true);
    expect(areLanguageTagsEqual(parse("iw"), parse("he"))).toBe(true);
    expect(areLanguageTagsEqual(parse("fra-CA"), parse("fr-CA"))).toBe(true);
    expect(areLanguageTagsEqual(parse("fr-CA"), parse("fr-FR"))).toBe(false);
  });

  it("compares Primary Language Code identity without discarding tag specificity", () => {
    const simplifiedChinese = parse("zh-Hans-CN");
    const traditionalChinese = parse("zh-Hant-TW");

    expect(haveSamePrimaryLanguage(simplifiedChinese, traditionalChinese)).toBe(
      true,
    );
    expect(simplifiedChinese.tag).not.toBe(traditionalChinese.tag);
    expect(haveSamePrimaryLanguage(simplifiedChinese, parse("ja"))).toBe(false);
  });
});
