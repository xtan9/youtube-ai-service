const MAX_LANGUAGE_TAG_LENGTH = 64;
const ASCII_PATTERN = /^[\x00-\x7f]*$/;
const TWO_LETTER_PRIMARY_PATTERN = /^[a-z]{2}$/;
const LANGUAGE_TAG_SENTINELS = new Set(["und", "zxx", "mul", "mis"]);

declare const languageTagBrand: unique symbol;
declare const primaryLanguageCodeBrand: unique symbol;

/** An opaque, canonical, two-letter primary language identity. */
export type PrimaryLanguageCode = string & {
  readonly [primaryLanguageCodeBrand]: "PrimaryLanguageCode";
};

/** A canonical full Language Tag and the two-letter identity it carries. */
export type LanguageTag = Readonly<{
  readonly tag: string;
  readonly primaryLanguageCode: PrimaryLanguageCode;
  readonly [languageTagBrand]: "LanguageTag";
}>;

export type LanguageTagParseFailureReason =
  | "malformed"
  | "sentinel"
  | "unsupported-primary";

export type LanguageTagParseFailure = Readonly<{
  readonly ok: false;
  readonly reason: LanguageTagParseFailureReason;
}>;

export type LanguageTagParseResult =
  | Readonly<{
      readonly ok: true;
      readonly languageTag: LanguageTag;
    }>
  | LanguageTagParseFailure;

function failure(reason: LanguageTagParseFailureReason): LanguageTagParseFailure {
  return Object.freeze({ ok: false, reason });
}

/**
 * Parse bounded untrusted text into the service's canonical Language Tag.
 *
 * The runtime canonicalizer owns casing and registered alias normalization.
 * This boundary deliberately admits only a canonical base tag: extensions
 * and private-use subtags are rejected because downstream service policies
 * need language identity, not locale behavior or opaque metadata.
 */
export function parseLanguageTag(input: unknown): LanguageTagParseResult {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_LANGUAGE_TAG_LENGTH ||
    input !== input.trim() ||
    !ASCII_PATTERN.test(input)
  ) {
    return failure("malformed");
  }

  if (input.toLowerCase() === "auto") {
    return failure("sentinel");
  }

  let canonicalizer: Intl.Locale;
  try {
    canonicalizer = new Intl.Locale(input);
  } catch {
    return failure("malformed");
  }

  const canonicalTag = canonicalizer.baseName;
  if (canonicalizer.toString() !== canonicalTag) {
    return failure("malformed");
  }

  const primaryLanguage = (
    canonicalizer.language ?? canonicalTag.split("-")[0]
  )?.toLowerCase();

  if (!primaryLanguage) {
    return failure("malformed");
  }

  if (LANGUAGE_TAG_SENTINELS.has(primaryLanguage)) {
    return failure("sentinel");
  }

  if (!TWO_LETTER_PRIMARY_PATTERN.test(primaryLanguage)) {
    return failure("unsupported-primary");
  }

  const languageTag = Object.freeze({
    tag: canonicalTag,
    primaryLanguageCode: primaryLanguage as PrimaryLanguageCode,
  }) as LanguageTag;

  return Object.freeze({ ok: true, languageTag });
}

/** Compare two parsed Language Tags by their canonical full identity. */
export function areLanguageTagsEqual(
  left: LanguageTag,
  right: LanguageTag,
): boolean {
  return left.tag === right.tag;
}

/** Compare two parsed Language Tags by their two-letter primary identity. */
export function haveSamePrimaryLanguage(
  left: LanguageTag,
  right: LanguageTag,
): boolean {
  return left.primaryLanguageCode === right.primaryLanguageCode;
}
