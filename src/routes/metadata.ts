import type { Hono } from "hono";
import { z } from "zod";
import { extractVideoId } from "../lib/captions.js";
import {
  respondWithOperationalOutcomeWithoutLog,
} from "../lib/http-errors.js";
import type { ResourceAdmission } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import type { VideoInformationWorkflow } from "../lib/video-information-workflow.js";
import { youtubeUrlSchema } from "../lib/youtube-url.js";
import {
  createDataRoute,
  readDataRequest,
  type DataRouteConfig,
} from "./data-route.js";

type MetadataRouteConfig = DataRouteConfig;

export interface MetadataRouteDependencies {
  readonly videoInformationWorkflow: VideoInformationWorkflow;
}

export function createMetadataRoute(
  config: MetadataRouteConfig,
  admission: ResourceAdmission,
  dependencies: MetadataRouteDependencies,
): Hono<ServiceEnv> {
  const metadata = createDataRoute("metadata", config, admission);

  const requestSchema = z.object({
    youtube_url: youtubeUrlSchema,
  });

  metadata.post("/", async (c) => {
    const intake = await readDataRequest(c, requestSchema);
    if (!intake.ok) return intake.response;

    const { youtube_url } = intake.data;
    const videoId = extractVideoId(youtube_url) ?? "unknown";

    try {
      const outcome = await dependencies.videoInformationWorkflow({
        youtubeUrl: youtube_url,
        signal: c.get("workSignal"),
        correlation: {
          requestId: c.get("requestId"),
          videoId,
        },
      });

      if (!outcome.ok) {
        return respondWithOperationalOutcomeWithoutLog(c, "metadata-failed");
      }

      const { videoInformation } = outcome;
      return c.json({
        language: videoInformation.languageHint,
        title: videoInformation.title,
        description: videoInformation.description,
        duration: videoInformation.durationSeconds,
        availableCaptions: videoInformation.availableCaptionLanguages,
      });
    } catch {
      c.get("workSignal").throwIfAborted();
      // The production workflow emits safe correlated diagnostics for
      // expected failures and unexpected defects. The route maps those
      // outcomes to the stable generic client-facing envelope only.
      return respondWithOperationalOutcomeWithoutLog(c, "metadata-failed");
    }
  });

  return metadata;
}
