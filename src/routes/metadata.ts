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
    const language = detectLanguage(ytdlpMeta);
    const availableCaptions = extractAvailableCaptions(ytdlpMeta);

    return c.json({
      language,
      title: ytdlpMeta.title,
      description: ytdlpMeta.description,
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
