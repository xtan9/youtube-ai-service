import { Hono } from "hono";
import { z } from "zod";
import { downloadAudio, cleanupAudio } from "../lib/ytdlp.js";
import { transcribeAudio } from "../lib/whisper.js";
import { extractVideoId } from "../lib/captions.js";
import { languageCodeSchema, youtubeUrlSchema } from "../lib/youtube-url.js";
import { authMiddleware } from "../middleware/auth.js";

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

    const segments = await transcribeAudio(audioPath, lang);
    console.log(`Transcription complete: ${segments.length} segments`);

    // Wire response carries `segments` (the canonical shape consumed by
    // the new frontend) AND a derived `transcript` string (kept for one
    // rollout window so a frontend that hasn't deployed yet keeps
    // working). The follow-up cleanup PR drops `transcript` once the
    // frontend is fully migrated.
    return c.json({
      segments,
      transcript: segments.map((s) => s.text).join(" "),
      // Echo back what we pinned so callers know which language we
      // instructed whisper to produce. "auto" preserves the prior contract
      // when no hint was provided.
      language: lang ?? "auto",
      source: "whisper" as const,
    });
  } catch (err) {
    // Real err.message (which embeds yt-dlp / whisper-ctranslate2 stderr
    // — tmp paths, binary names, verbose extractor output) stays in the
    // server log. Client sees a generic string so child-process internals
    // aren't echoed to the browser.
    const message = err instanceof Error ? err.message : "Transcription failed";
    console.error(`Transcription error for video ${videoId}: ${message}`);
    return c.json({ error: "Transcription failed" }, 500);
  } finally {
    if (audioPath) {
      await cleanupAudio(audioPath);
    }
  }
});

export { transcribe };
