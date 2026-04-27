import { readFile } from "fs/promises";
import { z } from "zod";
import {
  AudioCompressError,
  cleanupCompressed,
  compressForGroq,
} from "./audio-compress.js";
import type { TranscriptSegment } from "./captions.js";

// Subset of Groq's `verbose_json` response we consume. Groq's full shape
// includes word-level timestamps and per-segment confidence; ignoring them
// keeps the schema stable across Groq's minor format changes — `start`,
// `end`, and `text` per segment is the contract Whisper has held forever.
export const GroqResponseSchema = z.object({
  language: z.string().optional(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
    })
  ),
});

// Discriminated error shape so callers can branch on `status` to decide
// whether to fall back. `number` covers HTTP statuses; the string variants
// cover the network-layer failures `fetch` represents as thrown
// errors (and the synthetic "schema" we raise on Zod parse failures).
export class GroqTranscribeError extends Error {
  constructor(
    public readonly status:
      | number
      | "network"
      | "timeout"
      | "schema"
      | "compress",
    public readonly bodyExcerpt?: string
  ) {
    super(
      `Groq transcription failed (${status})${
        bodyExcerpt ? `: ${bodyExcerpt.slice(0, 200)}` : ""
      }`
    );
    this.name = "GroqTranscribeError";
  }
}

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = 2_000;

export async function transcribeViaGroq(
  audioPath: string,
  lang?: string
): Promise<{ segments: TranscriptSegment[]; language: string }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // Defensive: the route is supposed to check this before calling us.
    // A thrown Error (not GroqTranscribeError) signals "programmer error,
    // not operational failure" so the route's discriminating catch will
    // re-throw rather than fall back.
    throw new Error("GROQ_API_KEY not set (call site should have checked)");
  }

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  // `Number.isFinite && > 0` (not `||`) so an explicit `0` doesn't get
  // silently rewritten to the default — same convention the frontend's
  // MAX_TRANSCRIBE_DURATION_SECONDS parser uses.
  const rawTimeout = Number(process.env.GROQ_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_TIMEOUT_MS;

  // Re-encode to 16 kHz mono 32 kbps mp3 before upload. yt-dlp's
  // `--audio-quality 0` mp3 produces ~245 kbps VBR, which blows past
  // Groq's 25 MB free-tier upload cap once audio crosses ~14 min.
  // Downsampling to Whisper's native 16 kHz mono is transcription-
  // neutral (Whisper resamples to that rate before inference anyway).
  let uploadPath: string;
  try {
    uploadPath = await compressForGroq(audioPath);
  } catch (err) {
    if (err instanceof AudioCompressError) {
      // Surface as a Groq-side failure so the route's catch can apply
      // the same fallback rules — eligible for local Whisper iff the
      // audio is short enough per the route's fallback cap, else 503.
      // Detail string carries the AudioCompressError kind so the route
      // log distinguishes "missing-binary" (deploy regression) from
      // "ffmpeg-failed" (bad input) from "timeout" (host saturation).
      throw new GroqTranscribeError(
        "compress",
        `${err.kind}: ${err.detail}`
      );
    }
    throw err;
  }

  try {
    const fileBytes = await readFile(uploadPath);
    const buildBody = () => {
      const body = new FormData();
      body.append(
        "file",
        new Blob([fileBytes], { type: "audio/mpeg" }),
        // Compressed filename ends in .mp3 by construction; Groq trusts
        // the extension for format detection.
        uploadPath.split("/").pop() || "audio.mp3"
      );
      body.append("model", model);
      body.append("response_format", "verbose_json");
      if (lang) body.append("language", lang);
      return body;
    };

    const doFetch = () =>
      fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildBody(),
        signal: AbortSignal.timeout(timeoutMs),
      });

    let resp: Response;
    try {
      resp = await doFetch();
      // Single retry on 429. Free-tier rate limits are per-minute, so a
      // brief backoff usually clears. We deliberately do NOT retry 5xx —
      // Groq's incidents tend to last longer than 2s and we want to fail
      // through to the local fallback quickly.
      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        resp = await doFetch();
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new GroqTranscribeError("timeout");
      }
      throw new GroqTranscribeError(
        "network",
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!resp.ok) {
      // `.text().catch(() => "")` mirrors the existing vps-client.ts safety
      // pattern — a body-read failure must not swallow the original status.
      const text = await resp.text().catch(() => "");
      throw new GroqTranscribeError(resp.status, text);
    }

    let raw: unknown;
    try {
      raw = await resp.json();
    } catch (err) {
      throw new GroqTranscribeError(
        "schema",
        `JSON parse: ${err instanceof Error ? err.message : err}`
      );
    }

    const parsed = GroqResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GroqTranscribeError("schema", parsed.error.message);
    }

    // Drop empty / whitespace-only segments (Groq occasionally emits a
    // trailing empty-text segment for end-of-audio silence — same defensive
    // behavior parseWhisperJson already applies).
    const segments: TranscriptSegment[] = [];
    for (const s of parsed.data.segments) {
      const text = s.text.trim();
      if (!text) continue;
      segments.push({
        text,
        start: s.start,
        duration: Math.max(0, s.end - s.start),
      });
    }
    // Return empty segments verbatim — the route's existing length check
    // handles "no usable content" identically for both this backend and
    // the local-Whisper fallback path (WHISPER_EMPTY_RESULT). Throwing
    // here would break that symmetry by routing the response through the
    // Groq-failure catch (fallback / 503) instead of the cleaner 500 +
    // "Transcription produced no content."
    return { segments, language: parsed.data.language ?? lang ?? "auto" };
  } finally {
    // Defensive: cleanupCompressed today swallows non-leak errors (logs
    // them) so it should never throw, but a future cleanup-error policy
    // change must NOT swallow the body's throw via finally semantics.
    try {
      await cleanupCompressed(uploadPath);
    } catch (cleanupErr) {
      console.warn(
        `[groq-transcribe] CLEANUP_COMPRESSED_THREW for ${uploadPath}`,
        {
          errorId: "CLEANUP_COMPRESSED_THREW",
          path: uploadPath,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        }
      );
    }
  }
}
