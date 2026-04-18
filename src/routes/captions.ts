import { Hono } from "hono";
import { z } from "zod";
import { fetchCaptions, extractVideoId } from "../lib/captions.js";
import { youtubeUrlSchema } from "../lib/youtube-url.js";
import { authMiddleware } from "../middleware/auth.js";

const captions = new Hono();

// Attach auth inside the sub-router so every path served by this router
// — current and future — is protected by default. For the scope to work
// correctly, this sub-router is mounted at `app.route("/captions", captions)`
// in index.ts (NOT at `/`), so `*` only matches paths under /captions.
// Mounting at `/` would make this middleware fire on /health and every
// other app path.
captions.use("*", authMiddleware);

const requestSchema = z.object({
  youtube_url: youtubeUrlSchema,
});

captions.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // Hono returns 500 by default on malformed JSON; explicit 400
    // signals "client error" so the frontend doesn't trigger retry or
    // alerting.
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

  // Log only the videoId, never the full URL. YouTube URLs are unlikely
  // to contain secrets in practice, but the zod schema above only
  // constrains the host — tracker/analytics query strings the frontend
  // might append would still land in the log aggregator verbatim.
  const videoId = extractVideoId(youtube_url) ?? "unknown";

  try {
    console.log(`Fetching captions for video ${videoId}`);
    const result = await fetchCaptions(youtube_url);

    // Status contract this route owes its consumers:
    //   200 — captions extracted, fallback path not needed
    //   400 — client-side input error (no retry)
    //   404 — no captions available (fallback to /transcribe, no alert)
    //   500 — unexpected library/network failure (alert, do not fall back
    //         silently since that masks real problems behind compute bills)
    if (!result) return c.json({ error: "no_captions" }, 404);

    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Caption fetch failed";
    console.error(`Caption fetch error for video ${videoId}: ${message}`);
    return c.json({ error: "Internal error" }, 500);
  }
});

export { captions };
