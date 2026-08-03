import type { Hono } from "hono";
import { z } from "zod";
import type { CaptionTrackAcquisition } from "../lib/captions.js";
import {
  parseLanguageTag,
  type LanguageTag,
} from "../lib/language-tag.js";
import {
  youtubeVideoReferenceSchema,
} from "../lib/youtube-url.js";
import {
  respondWithOperationalOutcome,
  respondWithOperationalOutcomeWithoutLog,
} from "../lib/http-errors.js";
import type { ResourceAdmission } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import {
  createDataRoute,
  readDataRequest,
  type DataRouteConfig,
} from "./data-route.js";

type CaptionsRouteConfig = DataRouteConfig;

export interface CaptionsRouteDependencies {
  captionTrackAcquisition: CaptionTrackAcquisition;
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

    try {
      const request = Object.freeze({
        videoReference,
        requestedLanguage: languageTag,
        requestId: c.get("requestId"),
        signal: c.get("workSignal"),
      });
      const outcome = await dependencies.captionTrackAcquisition(request);

      // Status contract this route owes its consumers:
      //   200 — captions extracted, fallback path not needed
      //   400 — client-side input error (no retry)
      //   404 — no captions available (fallback to /transcribe, no alert)
      //   422 — valid Video Reference cannot be retrieved (terminal)
      //   500 — unexpected library/network failure (alert, do not fall back
      //         silently since that masks real problems behind compute bills)
      switch (outcome.kind) {
        case "acquired":
          // Wire response carries `segments` (the canonical shape consumed
          // by the new frontend) and the transitional derived `transcript`
          // field. Internal outcome discriminants and Prompt Locale naming
          // do not cross the HTTP boundary.
          return c.json({
            segments: outcome.segments,
            transcript: outcome.segments
              .map((segment) => segment.text)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim(),
            source: outcome.source,
            language: outcome.promptLocale,
            title: outcome.title,
            channelName: outcome.channelName,
          });
        case "absent":
          return respondWithOperationalOutcome(c, "captions-not-found");
        case "video-unavailable":
          return respondWithOperationalOutcome(c, "video-unavailable");
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
          throw new Error(
            "Caption Track acquisition returned an unknown outcome",
          );
        }
      }
    } catch {
      c.get("workSignal").throwIfAborted();
      return respondWithOperationalOutcomeWithoutLog(c, "captions-failed");
    }
  });

  return captions;
}
