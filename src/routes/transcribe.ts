import { Hono } from "hono";
import { z } from "zod";
import { downloadAudio, cleanupAudio } from "../lib/ytdlp.js";
import { transcribeAudio } from "../lib/whisper.js";
import { authMiddleware } from "../middleware/auth.js";

const transcribe = new Hono();

// Attach auth inside the sub-router so every path served here is
// protected by default. Mounted at `app.route("/transcribe", transcribe)`
// in index.ts so `*` scopes to /transcribe only — mounting at `/` would
// make this middleware fire on /health and every other app path.
transcribe.use("*", authMiddleware);

const requestSchema = z.object({
  youtube_url: z.string().url(),
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

  const { youtube_url } = parsed.data;
  let audioPath: string | null = null;

  try {
    console.log(`Transcribing: ${youtube_url}`);

    audioPath = await downloadAudio(youtube_url);
    console.log(`Audio downloaded to: ${audioPath}`);

    const transcript = await transcribeAudio(audioPath);
    console.log(`Transcription complete: ${transcript.length} characters`);

    return c.json({
      transcript,
      language: "auto",
      source: "whisper" as const,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    console.error(`Transcription error for ${youtube_url}: ${message}`);
    return c.json({ error: message }, 500);
  } finally {
    if (audioPath) {
      await cleanupAudio(audioPath);
    }
  }
});

export { transcribe };
