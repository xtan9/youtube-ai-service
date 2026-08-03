import type { Hono } from "hono";
import { z } from "zod";
import { extractVideoId } from "../lib/captions.js";
import { respondWithOperationalOutcome } from "../lib/http-errors.js";
import {
  parseLanguageTag,
  type LanguageTag,
} from "../lib/language-tag.js";
import type { ResourceAdmission } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import type { TranscriptionWorkflow } from "../lib/transcription-workflow.js";
import { youtubeUrlSchema } from "../lib/youtube-url.js";
import {
  createDataRoute,
  readDataRequest,
  type DataRouteConfig,
} from "./data-route.js";

type TranscribeRouteConfig = DataRouteConfig;

export function createTranscribeRoute(
  config: TranscribeRouteConfig,
  admission: ResourceAdmission,
  workflow: TranscriptionWorkflow,
): Hono<ServiceEnv> {
  const transcribe = createDataRoute("transcribe", config, admission);

  const requestSchema = z.object({
    youtube_url: youtubeUrlSchema,
    // The language policy below owns canonicalization and rejection. Keeping
    // this intake field as text means aliases and script/region tags reach
    // that one policy before any provider work begins.
    lang: z.string().optional(),
  });

  transcribe.post("/", async (c) => {
    const intake = await readDataRequest(c, requestSchema);
    if (!intake.ok) return intake.response;

    const { youtube_url: youtubeUrl, lang } = intake.data;
    let languageTag: LanguageTag | undefined;
    if (lang !== undefined) {
      const parsedLanguageTag = parseLanguageTag(lang);
      if (!parsedLanguageTag.ok) {
        return respondWithOperationalOutcome(c, "invalid-request");
      }
      languageTag = parsedLanguageTag.languageTag;
    }
    const videoId = extractVideoId(youtubeUrl) ?? "unknown";

    try {
      const outcome = await workflow({
        youtubeUrl,
        language: languageTag?.primaryLanguageCode,
        signal: c.get("workSignal"),
        correlation: {
          requestId: c.get("requestId"),
          videoId,
        },
      });

      if (!outcome.ok) {
        return respondWithOperationalOutcome(c, outcome.reason);
      }

      const { segments } = outcome;
      return c.json({
        segments,
        transcript: segments
          .map((segment) => segment.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        language: languageTag?.tag ?? "auto",
        // Compatibility field: this identifies the Whisper transcription
        // family, not whether Groq or local execution handled the workflow.
        source: "whisper" as const,
      });
    } catch {
      c.get("workSignal").throwIfAborted();
      // The workflow has already emitted a safe failure event with correlation
      // data. The HTTP boundary deliberately exposes no implementation detail.
      return respondWithOperationalOutcome(c, "transcription-failed");
    }
  });

  return transcribe;
}
