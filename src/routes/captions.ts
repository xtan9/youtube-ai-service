import { Hono } from "hono";
import { z } from "zod";
import { fetchCaptions } from "../lib/captions.js";
import { authMiddleware } from "../middleware/auth.js";

const captions = new Hono();

// Attach auth inside the sub-router so every path served by this router
// — current and future — is protected by default. Wiring auth by path
// prefix at the app level would silently bypass auth on a future
// sub-route like /captions/languages.
captions.use("*", authMiddleware);

const requestSchema = z.object({
  youtube_url: z.string().url(),
});

captions.post("/captions", async (c) => {
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

  try {
    console.log(`Fetching captions: ${youtube_url}`);
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
    // Real err.message stays in logs above; client sees a generic string
    // so raw library internals aren't echoed back to the browser.
    const message =
      err instanceof Error ? err.message : "Caption fetch failed";
    console.error(`Caption fetch error: ${message}`);
    return c.json({ error: "Internal error" }, 500);
  }
});

export { captions };
