import { Hono } from "hono";
import { z } from "zod";
import {
  AudioMediaLimitError,
  cleanupAudio,
  downloadAudio,
} from "../lib/ytdlp.js";
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
import { jsonError } from "../lib/http-errors.js";
import { logServiceEvent } from "../lib/observability.js";
import {
  readBoundedJson,
  resourceLimitMiddleware,
} from "../lib/resource-limits.js";
import { requestIdMiddleware, type ServiceEnv } from "../lib/request-id.js";

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

const transcribe = new Hono<ServiceEnv>();

// Attach auth inside the sub-router so every path served here is
// protected by default. Mounted at `app.route("/transcribe", transcribe)`
// in index.ts so `*` scopes to /transcribe only — mounting at `/` would
// make this middleware fire on /health and every other app path.
transcribe.use("*", requestIdMiddleware);
transcribe.use("*", authMiddleware);
transcribe.use("*", resourceLimitMiddleware("transcribe"));

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
  const bodyResult = await readBoundedJson(
    c.req.raw,
    c.get("resourceLimits").requestBodyMaxBytes
  );
  if (!bodyResult.ok && bodyResult.reason === "too_large") {
    return jsonError(c, 413, "Request body too large", "REQUEST_BODY_TOO_LARGE");
  }
  if (!bodyResult.ok) {
    // Explicit 400 so a malformed client body is classified as client
    // error rather than falling through to Hono's default 500 — the
    // frontend should not retry or alert on a body-parse failure.
    return jsonError(c, 400, "Invalid JSON body", "INVALID_JSON");
  }

  const parsed = requestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return jsonError(c, 400, "Invalid request", "INVALID_REQUEST");
  }

  const { youtube_url, lang } = parsed.data;
  const videoId = extractVideoId(youtube_url) ?? "unknown";
  let audioPath: string | null = null;

  try {
    logServiceEvent("info", "transcribe.start", {
      requestId: c.get("requestId"),
      videoId,
      lang,
    });

    audioPath = await downloadAudio(
      youtube_url,
      c.get("resourceLimits").mediaMaxBytes
    );
    logServiceEvent("info", "transcribe.audio_downloaded", {
      requestId: c.get("requestId"),
      videoId,
    });

    const audioSeconds = await probeAudioDurationSeconds(audioPath);
    if (audioSeconds === null) {
      logServiceEvent("warn", "transcribe.MEDIA_DURATION_UNKNOWN", {
        errorId: "MEDIA_DURATION_UNKNOWN",
        requestId: c.get("requestId"),
        videoId,
      });
      return jsonError(
        c,
        503,
        "Video duration could not be determined",
        "MEDIA_DURATION_UNKNOWN"
      );
    }
    if (audioSeconds > c.get("resourceLimits").mediaMaxDurationSeconds) {
      logServiceEvent("info", "transcribe.MEDIA_DURATION_EXCEEDED", {
        errorId: "MEDIA_DURATION_EXCEEDED",
        requestId: c.get("requestId"),
        videoId,
        audioSeconds,
      });
      return jsonError(
        c,
        413,
        "Video exceeds the processing limit",
        "MEDIA_DURATION_EXCEEDED"
      );
    }

    const hasGroqKey = Boolean(process.env.GROQ_API_KEY?.trim());

    let segments: TranscriptSegment[];

    if (!hasGroqKey) {
      if (!groqKeyMissingWarned) {
        groqKeyMissingWarned = true;
        logServiceEvent("error", "transcribe.GROQ_API_KEY_MISSING", {
          errorId: "GROQ_API_KEY_MISSING",
          requestId: c.get("requestId"),
          videoId,
        });
      }
      segments = await transcribeAudio(audioPath, lang);
    } else {
      try {
        segments = (await transcribeViaGroq(audioPath, lang)).segments;
      } catch (err) {
        if (!(err instanceof GroqTranscribeError)) throw err;

        // The duration safety preflight already ran before provider work;
        // reuse its result when deciding whether a local fallback is safe.
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
          logServiceEvent("warn", "transcribe.GROQ_FALLBACK", {
            errorId: "GROQ_FALLBACK",
            requestId: c.get("requestId"),
            videoId,
            audioSeconds,
            groqStatus: err.status,
            compressKind: err.compressKind,
          });
          segments = await transcribeAudio(audioPath, lang);
        } else {
          logServiceEvent("error", "transcribe.GROQ_FAILED_NO_FALLBACK", {
            errorId: "GROQ_FAILED_NO_FALLBACK",
            requestId: c.get("requestId"),
            videoId,
            audioSeconds,
            fallbackCap,
            groqStatus: err.status,
            compressKind: err.compressKind,
          });
          return jsonError(
            c,
            503,
            "Transcription temporarily unavailable",
            "TRANSCRIPTION_TEMPORARILY_UNAVAILABLE"
          );
        }
      }
    }
    logServiceEvent("info", "transcribe.complete", {
      requestId: c.get("requestId"),
      videoId,
      segmentCount: segments.length,
    });

    // Empty whisper output is the symmetric twin of the captions path's
    // CAPTION_EMPTY_TRANSCRIPT case — silently shipping `transcript: ""`
    // would let a VAD misconfiguration / yt-dlp encoding bug / model
    // upgrade artifact land as success-shaped 200, then produce a garbage
    // LLM summary downstream. Surface as 500 so the route's existing
    // "alert and skip cache" path classifies it correctly.
    if (segments.length === 0) {
      logServiceEvent("error", "transcribe.WHISPER_EMPTY_RESULT", {
        errorId: "WHISPER_EMPTY_RESULT",
        requestId: c.get("requestId"),
        videoId,
      });
      return jsonError(
        c,
        500,
        "Transcription produced no content",
        "TRANSCRIPTION_EMPTY_RESULT"
      );
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
    if (err instanceof AudioMediaLimitError) {
      logServiceEvent("info", "transcribe.MEDIA_SIZE_EXCEEDED", {
        errorId: "MEDIA_SIZE_EXCEEDED",
        requestId: c.get("requestId"),
        videoId,
      });
      return jsonError(
        c,
        413,
        "Video exceeds the processing limit",
        "MEDIA_SIZE_EXCEEDED"
      );
    }
    logServiceEvent("error", "transcribe.TRANSCRIBE_UNHANDLED", {
      errorId: "TRANSCRIBE_UNHANDLED",
      requestId: c.get("requestId"),
      videoId,
      errorName: err instanceof Error ? err.name : "unknown",
      // `message` carries yt-dlp / whisper / Groq-internal stderr —
      // stays out of the structured log and the user-visible body.
    });
    return jsonError(c, 500, "Transcription failed", "TRANSCRIPTION_FAILED");
  } finally {
    if (audioPath) {
      await cleanupAudio(audioPath);
    }
  }
});

export { transcribe };
