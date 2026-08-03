import type { Hono } from "hono";
import { z } from "zod";
import type { CaptionResult } from "../lib/captions.js";
import {
  parseLanguageTag,
  type LanguageTag,
} from "../lib/language-tag.js";
import {
  type YouTubeVideoReference,
  youtubeVideoReferenceSchema,
} from "../lib/youtube-url.js";
import { respondWithOperationalOutcome } from "../lib/http-errors.js";
import { logServiceEvent } from "../lib/observability.js";
import type { ResourceAdmission } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import {
  createDataRoute,
  readDataRequest,
  type DataRouteConfig,
} from "./data-route.js";

type CaptionsRouteConfig = DataRouteConfig;

export interface CaptionsRouteDependencies {
  fetchCaptions(
    videoReference: YouTubeVideoReference,
    lang: LanguageTag | undefined,
    requestId: string,
    signal: AbortSignal,
  ): Promise<CaptionResult | null>;
}

export function createCaptionsRoute(
  config: CaptionsRouteConfig,
  admission: ResourceAdmission,
  dependencies: CaptionsRouteDependencies,
): Hono<ServiceEnv> {
  const captions = createDataRoute("captions", config, admission);

  const requestSchema = z.object({
    youtube_url: youtubeVideoReferenceSchema,
    // Keep text intake separate from the canonical language policy. This
    // lets the policy classify malformed, sentinel, and unsupported-primary
    // values into the same bounded 400 response before provider work.
    lang: z.string().optional(),
  });

  captions.post("/", async (c) => {
    const intake = await readDataRequest(c, requestSchema);
    if (!intake.ok) return intake.response;

    const { youtube_url: videoReference, lang } = intake.data;
    let languageTag: LanguageTag | undefined;
    if (lang !== undefined) {
      const parsedLanguageTag = parseLanguageTag(lang);
      if (!parsedLanguageTag.ok) {
        return respondWithOperationalOutcome(c, "invalid-request");
      }
      languageTag = parsedLanguageTag.languageTag;
    }

    // Log only the Video ID, never the full URL. Tracker/analytics query
    // strings the frontend might append must not reach the log aggregator.
    const videoId = videoReference.videoId;

    try {
      logServiceEvent("info", "captions.fetch", {
        requestId: c.get("requestId"),
        videoId,
        lang: languageTag?.tag,
      });
      const result = await dependencies.fetchCaptions(
        videoReference,
        languageTag,
        c.get("requestId"),
        c.get("workSignal"),
      );

      // Status contract this route owes its consumers:
      //   200 — captions extracted, fallback path not needed
      //   400 — client-side input error (no retry)
      //   404 — no captions available (fallback to /transcribe, no alert)
      //   500 — unexpected library/network failure (alert, do not fall back
      //         silently since that masks real problems behind compute bills)
      if (!result) {
        return respondWithOperationalOutcome(c, "captions-not-found");
      }

      // Wire response carries `segments` (the canonical shape consumed by
      // the new frontend) AND a derived `transcript` string (kept for one
      // rollout window so a frontend that hasn't deployed yet keeps
      // working). The follow-up cleanup PR drops `transcript` once the
      // frontend is fully migrated.
      //
      // The derived string preserves the pre-PR whitespace normalization
      // (`join(" ").replace(/\s+/g, " ").trim()`). An old frontend that
      // hashed/length-gated the transcript would otherwise see a
      // different value for the same video during the rollout window.
      return c.json({
        ...result,
        transcript: result.segments
          .map((s) => s.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      });
    } catch (err) {
      c.get("workSignal").throwIfAborted();
      return respondWithOperationalOutcome(c, "captions-failed", {
        videoId,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  });

  return captions;
}
