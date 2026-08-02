import type { Hono } from "hono";
import { z } from "zod";
import { fetchCaptions, extractVideoId } from "../lib/captions.js";
import { languageCodeSchema, youtubeUrlSchema } from "../lib/youtube-url.js";
import { jsonError } from "../lib/http-errors.js";
import { logServiceEvent } from "../lib/observability.js";
import { readBoundedJson } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";
import { createDataRoute, type DataRouteConfig } from "./data-route.js";

type CaptionsRouteConfig = DataRouteConfig;

export function createCaptionsRoute(
  config: CaptionsRouteConfig,
): Hono<ServiceEnv> {
  const captions = createDataRoute("captions", config);

  const requestSchema = z.object({
    youtube_url: youtubeUrlSchema,
    // Optional ISO 639-1 or BCP-47 code. Passed through to
    // `youtube-transcript-plus` so the library selects a specific caption
    // track instead of the arbitrarily-ordered `tracks[0]`. Regex-constrained
    // at the schema boundary so values like `--help` or `"; rm -rf /"` are
    // rejected here instead of producing confusing downstream CLI errors.
    lang: languageCodeSchema.optional(),
  });

  captions.post("/", async (c) => {
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
      // Hono returns 500 by default on malformed JSON; explicit 400
      // signals "client error" so the frontend doesn't trigger retry or
      // alerting.
      return jsonError(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const parsed = requestSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return jsonError(c, 400, "Invalid request", "INVALID_REQUEST");
    }

    const { youtube_url, lang } = parsed.data;

    // Log only the videoId, never the full URL. YouTube URLs are unlikely
    // to contain secrets in practice, but the zod schema above only
    // constrains the host — tracker/analytics query strings the frontend
    // might append would still land in the log aggregator verbatim.
    const videoId = extractVideoId(youtube_url) ?? "unknown";

    try {
      logServiceEvent("info", "captions.fetch", {
        requestId: c.get("requestId"),
        videoId,
        lang,
      });
      const result = await fetchCaptions(youtube_url, lang, c.get("requestId"));

      // Status contract this route owes its consumers:
      //   200 — captions extracted, fallback path not needed
      //   400 — client-side input error (no retry)
      //   404 — no captions available (fallback to /transcribe, no alert)
      //   500 — unexpected library/network failure (alert, do not fall back
      //         silently since that masks real problems behind compute bills)
      if (!result) {
        return jsonError(c, 404, "no_captions", "CAPTIONS_NOT_FOUND");
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
      logServiceEvent("error", "captions.failed", {
        requestId: c.get("requestId"),
        errorId: "CAPTIONS_FAILED",
        videoId,
        errorName: err instanceof Error ? err.name : "unknown",
      });
      return jsonError(c, 500, "Internal error", "CAPTIONS_FAILED");
    }
  });

  return captions;
}
