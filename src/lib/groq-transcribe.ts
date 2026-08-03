import { readFile } from "fs/promises";
import { z } from "zod";
import {
  AudioCompressError,
  cleanupCompressed,
  compressForGroq,
} from "./audio-compress.js";
import type { AudioCompressKind } from "./audio-compress.js";
import type { TimedTextSegment } from "./timed-text.js";
import { getLanguageAnchorPrompt } from "./language-prompt.js";
import type { GroqConfig } from "./runtime-config.js";
import type { PrimaryLanguageCode } from "./language-tag.js";

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
    public readonly bodyExcerpt?: string,
    public readonly compressKind?: AudioCompressKind
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
// `whisper-large-v3` is more robust than `-turbo` against the
// long-silent-stretch hallucination class that survived the prior
// anchor-prompt fix on its own (a 25s silent gap between Chinese
// speech segments on hrREdNm7vB4 still produced English
// hallucinations even with the native-language anchor pinned). Turbo
// is a distilled / faster model — the speed savings aren't worth
// shipping nonsense English mid-Chinese-audio. `GROQ_MODEL` env var
// override is preserved for a future ops decision that wants the
// speed back; in that case bump `GROQ_TIMEOUT_MS` accordingly because
// large-v3 is roughly 2-3x slower than turbo per minute of audio
// and our default timeout was bumped to 180s on this PR to absorb
// that.
// 180s default (was 120s on turbo). large-v3 takes longer per
// minute of audio so a 14-18 min clip that previously completed in
// ~40-60s can now spend 90-120s — and a Groq queue spike pushes that
// over the prior 120s budget, surfacing as a "timeout" GroqTranscribeError
// the route then 503s when audioSeconds > GROQ_LOCAL_FALLBACK_MAX_SECONDS.
// Keeping the timeout flush with the prior turbo budget would shift
// some "drift hallucination" cases into "503 timeout" cases — the
// drift fix is the whole point of this change, don't undo it via
// timeout. Still well under the frontend's 240s VPS_TIMEOUT_MS
// default.
const RETRY_BACKOFF_MS = 2_000;

export function createGroqTranscriber(config: GroqConfig) {
  return (
    audioPath: string,
    lang?: PrimaryLanguageCode,
    signal?: AbortSignal,
  ) =>
    transcribeWithGroq(config, audioPath, lang, signal);
}

async function transcribeWithGroq(
  config: GroqConfig,
  audioPath: string,
  lang?: PrimaryLanguageCode,
  signal?: AbortSignal,
): Promise<{ segments: TimedTextSegment[]; language: string }> {
  const { apiKey, model, timeoutMs } = config;
  const workSignal = signal ?? new AbortController().signal;
  if (!apiKey) {
    // Defensive: the workflow is supposed to check this before calling us.
    // A thrown Error (not GroqTranscribeError) signals "programmer error,
    // not operational failure" so the route's discriminating catch will
    // re-throw rather than fall back.
    throw new Error("GROQ_API_KEY not set (call site should have checked)");
  }

  // `Number.isFinite && > 0` (not `||`) so an explicit `0` doesn't get
  // silently rewritten to the default — same convention the frontend's
  // MAX_TRANSCRIBE_DURATION_SECONDS parser uses.

  // Re-encode to 16 kHz mono 32 kbps mp3 before upload. yt-dlp's
  // `--audio-quality 0` mp3 produces ~245 kbps VBR, which blows past
  // Groq's 25 MB free-tier upload cap once audio crosses ~14 min.
  // Downsampling to Whisper's native 16 kHz mono is transcription-
  // neutral (Whisper resamples to that rate before inference anyway).
  let uploadPath: string;
  try {
    uploadPath = await compressForGroq(audioPath, workSignal);
  } catch (err) {
    workSignal.throwIfAborted();
    if (err instanceof AudioCompressError) {
      // Surface as a Groq-side failure so the workflow can apply
      // the same fallback rules — eligible for local Whisper iff the
      // the configured local fallback policy.
      // Detail string carries the AudioCompressError kind so the route
      // log distinguishes "missing-binary" (deploy regression) from
      // "ffmpeg-failed" (bad input) from "timeout" (host saturation).
      throw new GroqTranscribeError(
        "compress",
        `${err.kind}: ${err.detail}`,
        err.kind
      );
    }
    throw err;
  }

  try {
    const fileBytes = await readFile(uploadPath, { signal: workSignal });
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
      if (lang) {
        body.append("language", lang);
        // Native-language anchor biases the model toward the target
        // language even on non-speech audio (silence/music/B-roll
        // between sentences) where `language` alone isn't enough.
        // Without this, Groq's hosted Whisper hallucinates English
        // (and even other languages — French "même" was observed)
        // during low-speech segments and propagates the drift across
        // subsequent chunks. Captured on video hrREdNm7vB4 where ~46%
        // of a Chinese audio's segments came back as nonsense
        // non-Chinese despite `language=zh`. Groq's hosted Whisper
        // does not expose `condition_on_previous_text`, so `prompt` is
        // the only available lever for this drift.
        const anchor = getLanguageAnchorPrompt(lang);
        if (anchor) body.append("prompt", anchor);
      }
      return body;
    };

    const doFetch = () => {
      const providerTimeout = AbortSignal.timeout(timeoutMs);
      return fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildBody(),
        signal: AbortSignal.any([workSignal, providerTimeout]),
      });
    };

    let resp: Response;
    try {
      resp = await doFetch();
      // Single retry on 429. Free-tier rate limits are per-minute, so a
      // brief backoff usually clears. We deliberately do NOT retry 5xx —
      // Groq's incidents tend to last longer than 2s and we want to fail
      // through to the local fallback quickly.
      if (resp.status === 429) {
        await waitForRetryBackoff(workSignal);
        resp = await doFetch();
      }
    } catch (err) {
      workSignal.throwIfAborted();
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
    const segments: TimedTextSegment[] = [];
    for (const s of parsed.data.segments) {
      const text = s.text.trim();
      if (!text) continue;
      segments.push({
        text,
        start: s.start,
        duration: Math.max(0, s.end - s.start),
      });
    }
    // Return empty segments verbatim — the workflow's length check
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

function waitForRetryBackoff(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, RETRY_BACKOFF_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
