type LogLevel = "error" | "warn" | "info";

// Allow-list fields rather than trying to scrub arbitrary provider errors.
// This makes it impossible for a future route log to accidentally emit a
// bearer token, full YouTube URL, Transcript, Summary, or Video Chat body.
const SAFE_FIELDS = new Set([
  "requestId",
  "errorId",
  "status",
  "videoId",
  "lang",
  "source",
  "language",
  "audioSeconds",
  "fallbackCap",
  "groqStatus",
  "compressKind",
  "hasLanguageField",
  "subtitleKeyCount",
  "textLength",
  "errorName",
  "errorClass",
  "stage",
  "reason",
  "segmentCount",
  "requested",
  "matched",
  "availableCount",
  "originalLang",
  "retryLang",
  "rejectionCount",
]);

const URL_PATTERN = /https?:\/\/\S+/gi;

function sanitizeValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(URL_PATTERN, "[redacted-url]").slice(0, 120);
}

export function redactLogFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => SAFE_FIELDS.has(key))
      .map(([key, value]) => [key, sanitizeValue(value)])
  );
}

export function logServiceEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const safeFields = redactLogFields(fields);
  if (level === "error") {
    console.error(`[${event}]`, safeFields);
  } else if (level === "warn") {
    console.warn(`[${event}]`, safeFields);
  } else {
    console.info(`[${event}]`, safeFields);
  }
}
