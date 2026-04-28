import { Hono } from "hono";
import { z } from "zod";
import { fetchYtdlpMetadata } from "../lib/ytdlp-metadata.js";
import {
  detectLanguage,
  extractAvailableCaptions,
} from "../lib/language-detect.js";
import { extractVideoId } from "../lib/captions.js";
import { youtubeUrlSchema } from "../lib/youtube-url.js";
import { authMiddleware } from "../middleware/auth.js";

const metadata = new Hono();

// Auth middleware attached inside the sub-router — same pattern as
// /captions and /transcribe. See those routes for the reasoning.
metadata.use("*", authMiddleware);

const requestSchema = z.object({
  youtube_url: youtubeUrlSchema,
});

metadata.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // Explicit 400 so malformed bodies are client errors, not 500s. Same
    // convention as /captions and /transcribe.
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      400
    );
  }

  const { youtube_url } = parsed.data;
  const videoId = extractVideoId(youtube_url) ?? "unknown";

  try {
    console.log(`Fetching metadata for video ${videoId}`);
    const ytdlpMeta = await fetchYtdlpMetadata(youtube_url);
    const detected = detectLanguage(ytdlpMeta);
    // The wire contract requires `language` to be a string (frontend
    // schema rejects null). Map null → "en" at the route boundary so
    // detectLanguage can honestly report "no signal" internally
    // without breaking the API. The structured warn lets ops track
    // fallback rate — a rising rate is a detection-quality regression
    // or a corpus of metadata-sparse videos worth investigating.
    let language: string;
    if (detected) {
      language = detected;
    } else {
      console.warn(`[metadata] LANGUAGE_DETECT_FALLBACK for video ${videoId}`, {
        errorId: "LANGUAGE_DETECT_FALLBACK",
        videoId,
        hasLanguageField: Boolean(ytdlpMeta.language),
        subtitleKeyCount: Object.keys(ytdlpMeta.subtitles).length,
        textLength:
          (ytdlpMeta.title?.length ?? 0) +
          (ytdlpMeta.description?.length ?? 0),
      });
      language = "en";
    }
    const availableCaptions = extractAvailableCaptions(ytdlpMeta);

    return c.json({
      language,
      title: ytdlpMeta.title,
      description: ytdlpMeta.description,
      // Surface duration so callers can fail fast on videos too long
      // for the no-captions Whisper fallback to finish inside their
      // /transcribe budget — without this signal a caller has no
      // pre-flight evidence and learns the video was too long only
      // after the full timeout. `null` means yt-dlp gave us no usable
      // value (live streams, schema gaps, or any non-finite/negative
      // sentinel rejected by the normalizer); the contract is "treat
      // null as unknown, never as 0" — coercing would silently pass
      // any too-long gate.
      duration: ytdlpMeta.duration,
      availableCaptions,
    });
  } catch (err) {
    // Generic client-facing message; full yt-dlp stderr stays in server
    // logs. Mirrors the /transcribe and /captions error-handling shape.
    const message = err instanceof Error ? err.message : "Metadata fetch failed";
    console.error(`Metadata fetch error for video ${videoId}: ${message}`);
    return c.json({ error: "Metadata fetch failed" }, 500);
  }
});

export { metadata };
