

const MAX_UNICODE_CODEPOINT = 0x10ffff;

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": "\u00a0",
};

function safeFromCodePoint(codePoint: number, original: string): string {
  // Unicode scalar values exclude the surrogate range even though
  // String.fromCodePoint accepts it on some runtimes.
  if (
    !Number.isFinite(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_UNICODE_CODEPOINT ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return original;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
}

function decodeEntitiesOnce(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (match) =>
      NAMED_XML_ENTITIES[match] ?? match,
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16), match),
    )
    .replace(/&#(\d+);/g, (match, decimal: string) =>
      safeFromCodePoint(parseInt(decimal, 10), match),
    );
}

export function decodeCaptionEntities(text: string): string {
  const once = decodeEntitiesOnce(text);
  return once === text ? once : decodeEntitiesOnce(once);
}
