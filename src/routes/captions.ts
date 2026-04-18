import { Hono } from "hono";
import { z } from "zod";
import { fetchCaptions } from "../lib/captions.js";

const captions = new Hono();

const requestSchema = z.object({
  youtube_url: z.string().url(),
});

captions.post("/captions", async (c) => {
  const body = await c.req.json();
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

    // 404 means "captions not available" — a normal, expected outcome for
    // videos without captions or with them disabled. Distinct from 500
    // (library/network failure) so the frontend can fall back to /transcribe
    // without treating it as an error.
    if (!result) {
      return c.json({ error: "no_captions" }, 404);
    }

    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Caption fetch failed";
    console.error(`Caption fetch error: ${message}`);
    return c.json({ error: message }, 500);
  }
});

export { captions };
