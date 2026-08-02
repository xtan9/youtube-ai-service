import type { Hono } from "hono";
import { z } from "zod";
import { createYtdlpMetadataFetcher } from "../lib/ytdlp-metadata.js";
import type { YtdlpMetadata } from "../lib/language-detect.js";
import {
  detectLanguage,
  extractAvailableCaptions,
} from "../lib/language-detect.js";
import { extractVideoId } from "../lib/captions.js";
import { youtubeUrlSchema } from "../lib/youtube-url.js";
import { jsonError } from "../lib/http-errors.js";
import { logServiceEvent } from "../lib/observability.js";
import { readBoundedJson } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import type { RuntimeConfig } from "../lib/runtime-config.js";
import { createDataRoute, type DataRouteConfig } from "./data-route.js";

type MetadataRouteConfig = DataRouteConfig &
  Pick<RuntimeConfig, "mediaAcquisition">;

export interface MetadataRouteDependencies {
  fetchMetadata(url: string): Promise<YtdlpMetadata>;
}

export function createMetadataRoute(
  config: MetadataRouteConfig,
  dependencies: MetadataRouteDependencies = {
    fetchMetadata: createYtdlpMetadataFetcher(config.mediaAcquisition),
  },
): Hono<ServiceEnv> {
  const metadata = createDataRoute("metadata", config);

  const requestSchema = z.object({
    youtube_url: youtubeUrlSchema,
  });

  metadata.post("/", async (c) => {
    const bodyResult = await readBoundedJson(
      c.req.raw,
      c.get("resourceLimits").requestBodyMaxBytes,
    );
    if (!bodyResult.ok && bodyResult.reason === "too_large") {
      return jsonError(
        c,
        413,
        "Request body too large",
        "REQUEST_BODY_TOO_LARGE",
      );
    }
    if (!bodyResult.ok) {
      // Explicit 400 so malformed bodies are client errors, not 500s. Same
      // convention as /captions and /transcribe.
      return jsonError(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const parsed = requestSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return jsonError(c, 400, "Invalid request", "INVALID_REQUEST");
    }

    const { youtube_url } = parsed.data;
    const videoId = extractVideoId(youtube_url) ?? "unknown";

    try {
      logServiceEvent("info", "metadata.fetch", {
        requestId: c.get("requestId"),
        videoId,
      });
      const ytdlpMeta = await dependencies.fetchMetadata(youtube_url);
      const detected = detectLanguage(ytdlpMeta);
      // The wire contract requires `language` to be a string (frontend
      // schema rejects null). Map null → "en" at the route boundary so
      // detectLanguage can honestly report "no signal" internally
      // without breaking the API. The structured warn lets ops track
      // fallback rate — a rising rate is a detection-quality regression
      // or a corpus of metadata-sparse videos worth investigating.
      let language: string;
      if (detected) {
        language = detected;
      } else {
        logServiceEvent("warn", "metadata.LANGUAGE_DETECT_FALLBACK", {
          requestId: c.get("requestId"),
          errorId: "LANGUAGE_DETECT_FALLBACK",
          videoId,
          hasLanguageField: Boolean(ytdlpMeta.language),
          subtitleKeyCount: Object.keys(ytdlpMeta.subtitles).length,
          textLength:
            (ytdlpMeta.title?.length ?? 0) +
            (ytdlpMeta.description?.length ?? 0),
        });
        language = "en";
      }
      const availableCaptions = extractAvailableCaptions(ytdlpMeta);

      return c.json({
        language,
        title: ytdlpMeta.title,
        description: ytdlpMeta.description,
        // Surface duration so callers can fail fast on videos too long
        // for the no-captions Whisper fallback to finish inside their
        // /transcribe budget — without this signal a caller has no
        // pre-flight evidence and learns the video was too long only
        // after the full timeout. `null` means yt-dlp gave us no usable
        // value (live streams, schema gaps, or any non-finite/negative
        // sentinel rejected by the normalizer); the contract is "treat
        // null as unknown, never as 0" — coercing would silently pass
        // any too-long gate.
        duration: ytdlpMeta.duration,
        availableCaptions,
      });
    } catch (err) {
      // Generic client-facing message; full yt-dlp stderr stays in server
      // logs. Mirrors the /transcribe and /captions error-handling shape.
      logServiceEvent("error", "metadata.failed", {
        requestId: c.get("requestId"),
        errorId: "METADATA_FAILED",
        videoId,
        errorName: err instanceof Error ? err.name : "unknown",
      });
      return jsonError(c, 500, "Metadata fetch failed", "METADATA_FAILED");
    }
  });

  return metadata;
}
