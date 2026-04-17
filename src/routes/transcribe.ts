import { Hono } from "hono";
import { z } from "zod";
import { downloadAudio, cleanupAudio } from "../lib/ytdlp.js";
import { transcribeAudio } from "../lib/whisper.js";

const transcribe = new Hono();

const requestSchema = z.object({
  youtube_url: z.string().url(),
});

transcribe.post("/transcribe", async (c) => {
  const body = await c.req.json();
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

    // Download audio
    audioPath = await downloadAudio(youtube_url);
    console.log(`Audio downloaded to: ${audioPath}`);

    // Transcribe
    const transcript = await transcribeAudio(audioPath);
    console.log(`Transcription complete: ${transcript.length} characters`);

    return c.json({
      transcript,
      language: "auto",
      source: "whisper" as const,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    console.error(`Transcription error: ${message}`);
    return c.json({ error: message }, 500);
  } finally {
    if (audioPath) {
      await cleanupAudio(audioPath);
    }
  }
});

export { transcribe };
