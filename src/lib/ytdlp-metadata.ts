import { execFile } from "child_process";
import { buildYtdlpCommonArgs } from "./ytdlp-common.js";
import type { YtdlpMetadata } from "./language-detect.js";

// Descriptions are unbounded user content. Truncate before returning so we
// don't bloat JSON responses or log lines. 2000 chars is more than enough
// for language detection (franc's trigram model saturates around ~200
// chars) and fits comfortably in a debug log.
const DESCRIPTION_CHAR_CAP = 2000;

// Metadata extraction is fast compared to audio download (no byte
// streaming), but the player-response fetch can still stall on a slow
// backend. 30s is generous without letting a stuck yt-dlp hold up the
// request indefinitely.
const YTDLP_METADATA_TIMEOUT_MS = 30_000;

/**
 * Build the argv for a yt-dlp metadata-only invocation. Reuses the same
 * player_client / PO Token / UA profile as the audio download so a
 * successful download implies a successful metadata fetch (and vice versa).
 */
export function buildYtdlpMetadataArgs(url: string): string[] {
  return [
    "--dump-json",
    "--skip-download",
    ...buildYtdlpCommonArgs(),
    url,
  ];
}

/**
 * Invoke yt-dlp to dump the video's metadata JSON, parse, and normalize.
 * Throws on non-zero exit or JSON parse failure — the caller's route
 * should classify this as 500 so a persistent yt-dlp regression is
 * visible rather than silently collapsing to "no language signal".
 */
export async function fetchYtdlpMetadata(url: string): Promise<YtdlpMetadata> {
  const args = buildYtdlpMetadataArgs(url);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "yt-dlp",
      args,
      { timeout: YTDLP_METADATA_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (error, out, stderr) => {
        if (error) {
          reject(new Error(`yt-dlp metadata failed: ${stderr || error.message}`));
          return;
        }
        resolve(out);
      }
    );
  });

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `yt-dlp metadata returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return normalizeYtdlpJson(raw);
}

function normalizeYtdlpJson(raw: unknown): YtdlpMetadata {
  // Narrow to Record before field access — yt-dlp output is schema-drift-y;
  // a minor version bump could rename fields. Missing fields collapse to
  // safe defaults; type-unexpected values (e.g. `language: 42`) also
  // collapse, keeping the caller's contract simple.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("yt-dlp metadata returned a non-object payload");
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
    throw new Error(
      "yt-dlp metadata payload is missing all anchor fields — likely a schema regression"
    );
  }

  const title = typeof obj.title === "string" ? obj.title : "";
  const description =
    typeof obj.description === "string"
      ? obj.description.slice(0, DESCRIPTION_CHAR_CAP)
      : "";
  const language =
    typeof obj.language === "string" && obj.language.length > 0
      ? obj.language
      : null;
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
    subtitles: normalizeCaptionDict(obj.subtitles),
    automatic_captions: normalizeCaptionDict(obj.automatic_captions),
  };
}

function normalizeCaptionDict(
  raw: unknown
): Readonly<Record<string, readonly { url: string; ext: string }[]>> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, { url: string; ext: string }[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const tracks = value
      .filter(
        (t): t is { url?: unknown; ext?: unknown } => t !== null && typeof t === "object"
      )
      .map((t) => ({
        url: typeof t.url === "string" ? t.url : "",
        ext: typeof t.ext === "string" ? t.ext : "",
      }));
    if (tracks.length > 0) result[key] = tracks;
  }
  return result;
}
