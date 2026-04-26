import { z } from "zod";
import type { TranscriptSegment } from "./captions.js";

// Subset of Groq's `verbose_json` response we consume. Groq's full shape
// includes word-level timestamps and per-segment confidence; ignoring them
// keeps the schema stable across Groq's minor format changes — `start`,
// `end`, and `text` per segment is the contract Whisper has held forever.
export const GroqResponseSchema = z.object({
  language: z.string().optional(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
    })
  ),
});

// Discriminated error shape so callers can branch on `status` to decide
// whether to fall back. `number` covers HTTP statuses; the string variants
// cover the network-layer failures `fetch` represents as thrown
// errors (and the synthetic "schema" we raise on Zod parse failures).
export class GroqTranscribeError extends Error {
  constructor(
    public readonly status: number | "network" | "timeout" | "schema",
    public readonly bodyExcerpt?: string
  ) {
    super(
      `Groq transcription failed (${status})${
        bodyExcerpt ? `: ${bodyExcerpt.slice(0, 200)}` : ""
      }`
    );
    this.name = "GroqTranscribeError";
  }
}

// Public function signature stub — implemented in Task 3. Declared here
// so the type can be imported by the route in later tasks even before
// the body lands. Throws at runtime if accidentally called pre-impl.
export async function transcribeViaGroq(
  _audioPath: string,
  _lang?: string
): Promise<{ segments: TranscriptSegment[]; language: string }> {
  throw new Error("transcribeViaGroq not implemented yet");
}
