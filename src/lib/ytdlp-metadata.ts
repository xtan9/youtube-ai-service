import { execFile } from "child_process";
import { buildYtdlpCommonArgs } from "./ytdlp-common.js";
import {
  parseLanguageTag,
  type LanguageTag,
  type LanguageTagParseFailureReason,
} from "./language-tag.js";
import type { MediaAcquisitionConfig } from "./runtime-config.js";

export interface YtdlpCaptionTrack {
  readonly url: string;
  readonly ext: string;
}

export interface YtdlpCaptionLanguage {
  readonly languageTag: LanguageTag;
  readonly tracks: readonly YtdlpCaptionTrack[];
}

export type YtdlpLanguageRejectionSource =
  | "uploader-language"
  | "manual-caption-key"
  | "automatic-caption-key";

export interface YtdlpLanguageTagRejection {
  readonly source: YtdlpLanguageRejectionSource;
  readonly reason: LanguageTagParseFailureReason;
}

// Keep the normalized provider contract with the acquisition adapter. The
// language-analysis module consumes this data but does not own its schema.
export interface YtdlpMetadata {
  readonly title: string;
  readonly description: string;
  readonly language: LanguageTag | null;
  readonly duration: number | null;
  readonly subtitles: readonly YtdlpCaptionLanguage[];
  readonly automatic_captions: readonly YtdlpCaptionLanguage[];
  readonly languageTagRejections: readonly YtdlpLanguageTagRejection[];
}

/**
 * Safe, expected failure at the yt-dlp acquisition boundary.
 *
 * The message intentionally contains no provider output. The original error
 * remains available as `cause` for internal diagnostics.
 */
export class YtdlpAcquisitionError extends Error {
  constructor(options?: ErrorOptions) {
    super("yt-dlp metadata acquisition failed", options);
    this.name = "YtdlpAcquisitionError";
  }
}

// Descriptions are unbounded user content. Truncate before returning so we
// don't bloat JSON responses or log lines. 2000 chars is more than enough
// for eld's n-gram language model (saturates well below this cap) and
// fits comfortably in a debug log.
const DESCRIPTION_CHAR_CAP = 2000;

// Metadata extraction is fast compared to audio download (no byte
// streaming), but the player-response fetch can still stall on a slow
// backend. 30s is generous without letting a stuck yt-dlp hold up the
// request indefinitely.
const YTDLP_METADATA_TIMEOUT_MS = 30_000;

const MAX_LANGUAGE_TAG_REJECTIONS = 1_000;

/**
 * Build the argv for a yt-dlp metadata-only invocation. Reuses the same
 * player_client / PO Token / UA profile as the audio download so a
 * successful download implies a successful metadata fetch (and vice versa).
 */
export function buildYtdlpMetadataArgs(
  url: string,
  config: MediaAcquisitionConfig
): string[] {
  return [
    "--dump-json",
    "--skip-download",
    ...buildYtdlpCommonArgs(config),
    url,
  ];
}

/**
 * Invoke yt-dlp to dump the video's metadata JSON, parse, and normalize.
 * Expected process, parse, and provider-schema failures become one safe
 * YtdlpAcquisitionError. Abort reasons are rethrown unchanged so request
 * cancellation cannot be mistaken for provider unavailability.
 */
export function createYtdlpMetadataFetcher(config: MediaAcquisitionConfig) {
  return (url: string, signal?: AbortSignal) =>
    fetchYtdlpMetadataWithConfig(config, url, signal);
}

async function fetchYtdlpMetadataWithConfig(
  config: MediaAcquisitionConfig,
  url: string,
  signal?: AbortSignal,
): Promise<YtdlpMetadata> {
  const args = buildYtdlpMetadataArgs(url, config);

  signal?.throwIfAborted();

  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "yt-dlp",
        args,
        {
          timeout: YTDLP_METADATA_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
          signal,
        },
        (error, out) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(out);
        }
      );
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new YtdlpAcquisitionError({ cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new YtdlpAcquisitionError({ cause: err });
  }

  return normalizeYtdlpMetadata(raw);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    ("code" in error && error.code === "ABORT_ERR")
  );
}

export function normalizeYtdlpMetadata(raw: unknown): YtdlpMetadata {
  // Narrow to Record before field access — yt-dlp output is schema-drift-y;
  // a minor version bump could rename fields. Missing fields collapse to
  // safe defaults; type-unexpected values (e.g. `language: 42`) also
  // collapse, keeping the caller's contract simple.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new YtdlpAcquisitionError();
  }
  const obj = raw as Record<string, unknown>;

  // Every real yt-dlp video-info payload carries at least one of these
  // anchor fields. `{}` (schema regression, partial response, wrong
  // endpoint) would otherwise collapse to all-defaults and flow through
  // as a silent success — the route would return 200 with garbage and
  // the orchestrator would pin an arbitrary language to whisper.
  const ANCHORS = ["id", "title", "webpage_url", "duration", "uploader"] as const;
  const hasAnchor = ANCHORS.some(
    (k) => obj[k] !== undefined && obj[k] !== null
  );
  if (!hasAnchor) {
    throw new YtdlpAcquisitionError();
  }

  const title = typeof obj.title === "string" ? obj.title : "";
  const description =
    typeof obj.description === "string"
      ? obj.description.slice(0, DESCRIPTION_CHAR_CAP)
      : "";
  const languageTagRejections: YtdlpLanguageTagRejection[] = [];
  const language = parseProviderLanguage(
    obj.language,
    "uploader-language",
    languageTagRejections,
  );
  // yt-dlp emits `duration` as a number of seconds for VOD entries and
  // omits it (or sets it to null) on live streams. Anything that isn't
  // a finite non-negative number — string, boolean, NaN, Infinity,
  // negative, missing — collapses to `null` so a yt-dlp regression
  // that fills the field with a sentinel can't flow through and bias
  // downstream length checks. Zero is preserved (zero-second clips
  // exist and are a legitimate VOD case).
  const duration =
    typeof obj.duration === "number" &&
    Number.isFinite(obj.duration) &&
    obj.duration >= 0
      ? obj.duration
      : null;

  return {
    title,
    description,
    language,
    duration,
    subtitles: normalizeCaptionDict(
      obj.subtitles,
      "manual-caption-key",
      languageTagRejections,
    ),
    automatic_captions: normalizeCaptionDict(
      obj.automatic_captions,
      "automatic-caption-key",
      languageTagRejections,
    ),
    languageTagRejections,
  };
}

function parseProviderLanguage(
  raw: unknown,
  source: YtdlpLanguageRejectionSource,
  rejections: YtdlpLanguageTagRejection[],
): LanguageTag | null {
  if (raw === null || raw === undefined) return null;

  const parsed = parseLanguageTag(raw);
  if (!parsed.ok) {
    recordLanguageTagRejection(rejections, source, parsed.reason);
    return null;
  }

  return parsed.languageTag;
}

function recordLanguageTagRejection(
  rejections: YtdlpLanguageTagRejection[],
  source: YtdlpLanguageRejectionSource,
  reason: LanguageTagParseFailureReason,
): void {
  if (rejections.length >= MAX_LANGUAGE_TAG_REJECTIONS) return;
  rejections.push({ source, reason });
}

function normalizeCaptionDict(
  raw: unknown,
  source: YtdlpLanguageRejectionSource,
  rejections: YtdlpLanguageTagRejection[],
): readonly YtdlpCaptionLanguage[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const entries = new Map<string, { languageTag: LanguageTag; tracks: YtdlpCaptionTrack[] }>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const tracks = value
      .filter(
        (t): t is { url?: unknown; ext?: unknown } =>
          t !== null && typeof t === "object" && !Array.isArray(t)
      )
      .map((t) => ({
        url: typeof t.url === "string" ? t.url : "",
        ext: typeof t.ext === "string" ? t.ext : "",
      }));
    if (tracks.length === 0) continue;

    const parsed = parseLanguageTag(key);
    if (!parsed.ok) {
      recordLanguageTagRejection(rejections, source, parsed.reason);
      continue;
    }

    const existing = entries.get(parsed.languageTag.tag);
    if (existing) {
      existing.tracks.push(...tracks);
      continue;
    }

    entries.set(parsed.languageTag.tag, {
      languageTag: parsed.languageTag,
      tracks,
    });
  }
  return Array.from(entries.values());
}
