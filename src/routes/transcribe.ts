import { Hono } from "hono";
import { z } from "zod";
import { downloadAudio, cleanupAudio } from "../lib/ytdlp.js";
import { transcribeAudio } from "../lib/whisper.js";
import { extractVideoId } from "../lib/captions.js";
import type { TranscriptSegment } from "../lib/captions.js";
import { languageCodeSchema, youtubeUrlSchema } from "../lib/youtube-url.js";
import { authMiddleware } from "../middleware/auth.js";
import { probeAudioDurationSeconds } from "../lib/audio-duration.js";
import {
  GroqTranscribeError,
  transcribeViaGroq,
} from "../lib/groq-transcribe.js";
import type { AudioCompressKind } from "../lib/audio-compress.js";

// Exhaustive switch ensures any new AudioCompressKind requires an
// explicit decision — TypeScript will error on the `never` assignment
// in default if a kind is added to the union without being handled.
function isOperationalCompressKind(kind: AudioCompressKind): boolean {
  switch (kind) {
    case "missing-binary":
    case "timeout":
      return true;
    case "ffmpeg-failed":
      return false;
    default: {
      const _exhaustive: never = kind;
      return false;
    }
  }
}

// Module-scoped so the GROQ_API_KEY_MISSING warning fires once per
// process rather than once per request. Logs flooding stderr don't
// escalate to ops any faster than a single line, and they make
// real diagnostics harder to find.
let groqKeyMissingWarned = false;

const transcribe = new Hono();

// Attach auth inside the sub-router so every path served here is
// protected by default. Mounted at `app.route("/transcribe", transcribe)`
// in index.ts so `*` scopes to /transcribe only — mounting at `/` would
// make this middleware fire on /health and every other app path.
transcribe.use("*", authMiddleware);

const requestSchema = z.object({
  youtube_url: youtubeUrlSchema,
  // Optional ISO 639-1 code. When present, forwarded to whisper as
  // `--language <code>` so the model transcribes into the named language
  // instead of auto-detecting (which misfires on short/noisy clips).
  // Regex-constrained at the schema boundary so values like `--model` or
  // `"; rm -rf /"` are rejected here instead of polluting whisper's argv.
  lang: languageCodeSchema.optional(),
});

transcribe.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // Explicit 400 so a malformed client body is classified as client
    // error rather than falling through to Hono's default 500 — the
    // frontend should not retry or alert on a body-parse failure.
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      400
    );
  }

  const { youtube_url, lang } = parsed.data;
  const videoId = extractVideoId(youtube_url) ?? "unknown";
  let audioPath: string | null = null;

  try {
    console.log(
      `Transcribing video ${videoId}${lang ? ` (lang=${lang})` : ""}`
    );

    audioPath = await downloadAudio(youtube_url);
    console.log(`Audio downloaded to: ${audioPath}`);

    const hasGroqKey = Boolean(process.env.GROQ_API_KEY?.trim());

    let segments: TranscriptSegment[];

    if (!hasGroqKey) {
      if (!groqKeyMissingWarned) {
        groqKeyMissingWarned = true;
        console.error(
          "[transcribe] GROQ_API_KEY_MISSING — falling back to local Whisper at any audio length until the secret is set",
          { errorId: "GROQ_API_KEY_MISSING" }
        );
      }
      segments = await transcribeAudio(audioPath, lang);
    } else {
      try {
        segments = (await transcribeViaGroq(audioPath, lang)).segments;
      } catch (err) {
        if (!(err instanceof GroqTranscribeError)) throw err;

        // Probe duration only on the fallback path — the happy path
        // (Groq succeeds) shouldn't pay the extra ffprobe cost.
        const audioSeconds = await probeAudioDurationSeconds(audioPath);
        const fallbackCap =
          Number(process.env.GROQ_LOCAL_FALLBACK_MAX_SECONDS) || 180;
        // Fatal upstream failures we deliberately surface as errors rather
        // than mask with local Whisper:
        //   - 429: Groq quota exhausted (in-process retry already absorbed
        //     transient blips, so reaching here means quota is genuinely out).
        //   - compress: missing-binary: ffmpeg not on PATH inside the
        //     container — a deploy regression, not a transient or input-shaped
        //     failure.
        //   - compress: timeout: ffmpeg killed at the 120s compress timeout —
        //     host saturation, and local Whisper runs on the same host so
        //     falling back makes the saturation worse.
        // compress: ffmpeg-failed (bad input) is intentionally fallback-eligible
        // — local Whisper may handle the audio differently and the user still
        // gets a result.
        //
        // Discrimination is by typed compressKind (not bodyExcerpt prefix) so
        // the route doesn't depend on the private message format that
        // groq-transcribe.ts uses for log fidelity. Adding a new
        // AudioCompressKind triggers a TypeScript exhaustiveness error in
        // isOperationalCompressKind above — every union variant must be
        // assigned a fallback decision.
        //
        // Fail-closed default: an unknown or missing compressKind is treated
        // as operational (no fallback). The GroqTranscribeError class still
        // declares compressKind as optional for back-compat, so a future
        // throw site that forgets to pass it must surface the error rather
        // than silently fall back to local Whisper. This mirrors the
        // fail-closed pattern below for audioSeconds === null.
        const isRateLimited = err.status === 429;
        const isOperationalCompressFailure =
          err.status === "compress" &&
          (err.compressKind === undefined ||
            isOperationalCompressKind(err.compressKind));
        const isFatalUpstream = isRateLimited || isOperationalCompressFailure;
        // audioSeconds === null means ffprobe failed; fail closed (treat
        // as "too long for fallback") so a noisy probe doesn't promote
        // a routine Groq blip into a multi-minute local-Whisper attempt
        // for a video we can't bound.
        const eligibleForFallback =
          !isFatalUpstream &&
          audioSeconds !== null &&
          audioSeconds <= fallbackCap;

        if (eligibleForFallback) {
          console.warn(
            `[transcribe] GROQ_FALLBACK for video ${videoId}`,
            {
              errorId: "GROQ_FALLBACK",
              videoId,
              audioSeconds,
              groqStatus: err.status,
              compressKind: err.compressKind,
            }
          );
          segments = await transcribeAudio(audioPath, lang);
        } else {
          console.error(
            `[transcribe] GROQ_FAILED_NO_FALLBACK for video ${videoId}`,
            {
              errorId: "GROQ_FAILED_NO_FALLBACK",
              videoId,
              audioSeconds,
              fallbackCap,
              groqStatus: err.status,
              compressKind: err.compressKind,
            }
          );
          return c.json(
            {
              error:
                "Transcription service is temporarily unavailable. Please try again in a few minutes.",
            },
            503
          );
        }
      }
    }
    console.log(`Transcription complete: ${segments.length} segments`);

    // Empty whisper output is the symmetric twin of the captions path's
    // CAPTION_EMPTY_TRANSCRIPT case — silently shipping `transcript: ""`
    // would let a VAD misconfiguration / yt-dlp encoding bug / model
    // upgrade artifact land as success-shaped 200, then produce a garbage
    // LLM summary downstream. Surface as 500 so the route's existing
    // "alert and skip cache" path classifies it correctly.
    if (segments.length === 0) {
      console.error(`[transcribe] WHISPER_EMPTY_RESULT for video ${videoId}`, {
        errorId: "WHISPER_EMPTY_RESULT",
        videoId,
      });
      return c.json({ error: "Transcription produced no content" }, 500);
    }

    // Wire response carries `segments` (the canonical shape consumed by
    // the new frontend) AND a derived `transcript` string (kept for one
    // rollout window so a frontend that hasn't deployed yet keeps
    // working). The follow-up cleanup PR drops `transcript` once the
    // frontend is fully migrated.
    //
    // The derived string preserves the pre-PR whitespace normalization
    // (`join(" ").replace(/\s+/g, " ").trim()`) so an old frontend's
    // text-hash / dedupe behaviour matches what it saw before.
    return c.json({
      segments,
      transcript: segments
        .map((s) => s.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      // Echo back what we pinned so callers know which language we
      // instructed whisper to produce. "auto" preserves the prior contract
      // when no hint was provided.
      language: lang ?? "auto",
      source: "whisper" as const,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    console.error(
      `[transcribe] TRANSCRIBE_UNHANDLED for video ${videoId}`,
      {
        errorId: "TRANSCRIBE_UNHANDLED",
        videoId,
        errorName: err instanceof Error ? err.name : "unknown",
        // `message` carries yt-dlp / whisper / Groq-internal stderr —
        // stays in the log, never in the user-visible body.
        message: message.slice(0, 500),
      }
    );
    return c.json({ error: "Transcription failed" }, 500);
  } finally {
    if (audioPath) {
      await cleanupAudio(audioPath);
    }
  }
});

export { transcribe };
