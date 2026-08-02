import type { Hono } from "hono";
import { z } from "zod";
import { extractVideoId } from "../lib/captions.js";
import { respondWithOperationalOutcome } from "../lib/http-errors.js";
import { readBoundedJson } from "../lib/resource-limits.js";
import type { ResourceAdmission } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import {
  createProductionTranscriptionWorkflow,
  type TranscriptionWorkflow,
} from "../lib/transcription-workflow.js";
import type { RuntimeConfig } from "../lib/runtime-config.js";
import { languageCodeSchema, youtubeUrlSchema } from "../lib/youtube-url.js";
import { createDataRoute, type DataRouteConfig } from "./data-route.js";

type TranscribeRouteConfig = DataRouteConfig &
  Pick<RuntimeConfig, "transcription" | "mediaAcquisition">;

export function createTranscribeRoute(
  config: TranscribeRouteConfig,
  workflow: TranscriptionWorkflow = createProductionTranscriptionWorkflow(
    config,
  ),
  admission?: ResourceAdmission,
): Hono<ServiceEnv> {
  const transcribe = createDataRoute("transcribe", config, admission);

  const requestSchema = z.object({
    youtube_url: youtubeUrlSchema,
    // Optional ISO 639-1 code. The workflow forwards it to the selected
    // transcription backend after this boundary rejects CLI-shaped input.
    lang: languageCodeSchema.optional(),
  });

  transcribe.post("/", async (c) => {
    const bodyResult = await readBoundedJson(
      c.req.raw,
      c.get("resourceLimits").requestBodyMaxBytes,
      c.get("workSignal"),
    );
    if (!bodyResult.ok && bodyResult.reason === "too_large") {
      return respondWithOperationalOutcome(c, "request-body-too-large");
    }
    if (!bodyResult.ok) {
      return respondWithOperationalOutcome(c, "invalid-json");
    }

    const parsed = requestSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return respondWithOperationalOutcome(c, "invalid-request");
    }

    const { youtube_url: youtubeUrl, lang } = parsed.data;
    const videoId = extractVideoId(youtubeUrl) ?? "unknown";
    const limits = c.get("resourceLimits");

    try {
      const outcome = await workflow({
        youtubeUrl,
        language: lang,
        signal: c.get("workSignal"),
        limits: {
          mediaMaxBytes: limits.mediaMaxBytes,
          mediaMaxDurationSeconds: limits.mediaMaxDurationSeconds,
        },
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
        language: lang ?? "auto",
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
