import { z } from "zod";

// This module owns the complete YouTube Video Reference policy. Keep URL
// recognition and Video ID extraction together: a route must not be able to
// accept one definition of a YouTube URL and hand a downstream workflow a
// Video ID derived by a different parser.
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

declare const youtubeVideoReferenceBrand: unique symbol;

/** The validated identity of one YouTube video request. */
export type YouTubeVideoReference = Readonly<{
  readonly url: string;
  readonly videoId: string;
  readonly [youtubeVideoReferenceBrand]: "YouTubeVideoReference";
}>;

function extractVideoIdFromUrl(url: URL): string | null {
  const pathSegments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "youtu.be") {
    const videoId = pathSegments[0] ?? "";
    return VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
  }

  const queryVideoId = url.searchParams.get("v");
  if (queryVideoId && VIDEO_ID_PATTERN.test(queryVideoId)) {
    return queryVideoId;
  }

  const pathVideoId =
    (pathSegments[0] === "shorts" || pathSegments[0] === "embed") &&
    VIDEO_ID_PATTERN.test(pathSegments[1] ?? "")
      ? pathSegments[1]
      : null;
  return pathVideoId ?? null;
}

/**
 * Parse untrusted input into the service's one canonical YouTube identity.
 *
 * The returned object is frozen at runtime as well as readonly in TypeScript;
 * downstream code can safely pass it across workflow and provider seams.
 */
export function parseYouTubeVideoReference(
  input: unknown,
): YouTubeVideoReference | null {
  if (typeof input !== "string") return null;

  try {
    const parsed = new URL(input);
    // Reject non-http(s) schemes even if the host is right — `ftp://`,
    // `javascript:`, and `data:` URLs are not valid YouTube videos.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // Credentials are not part of a YouTube Video Reference. Passing them to
    // yt-dlp or recording them in a provider error would create a credential
    // forwarding and logging hazard.
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;

    const videoId = extractVideoIdFromUrl(parsed);
    if (!videoId) return null;

    return Object.freeze({ url: input, videoId }) as YouTubeVideoReference;
  } catch {
    return null;
  }
}

/**
 * Request-boundary schema. Its output is the immutable reference, not a raw
 * URL string, so all downstream consumers share one validated identity.
 */
export const youtubeVideoReferenceSchema = z.url().transform((url, ctx) => {
  const reference = parseYouTubeVideoReference(url);
  if (!reference) {
    ctx.addIssue({
      code: "custom",
      message: "URL must be a YouTube URL",
    });
    return z.NEVER;
  }
  return reference;
});
