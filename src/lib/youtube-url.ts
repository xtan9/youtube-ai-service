import { z } from "zod";

// Zod's built-in `.url()` accepts any WHATWG-parsable URL — `ftp://...`,
// `https://phisher.example/?token=...`, `http://user:pass@host/`. Accepting
// those would let an authed caller smuggle arbitrary strings that we then
// hand to yt-dlp / the caption library / error logs. Restrict at the
// schema boundary so downstream code never sees a non-YouTube URL.
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

function hasVideoId(url: URL): boolean {
  const pathSegments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "youtu.be") {
    return VIDEO_ID_PATTERN.test(pathSegments[0] ?? "");
  }

  const queryVideoId = url.searchParams.get("v");
  if (queryVideoId && VIDEO_ID_PATTERN.test(queryVideoId)) return true;

  return (
    (pathSegments[0] === "shorts" || pathSegments[0] === "embed") &&
    VIDEO_ID_PATTERN.test(pathSegments[1] ?? "")
  );
}

export function isYoutubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Reject non-http(s) schemes even if the host is right — `ftp://`,
    // `javascript:`, `data:` URLs with a youtube host are still not
    // valid YouTube videos and shouldn't be forwarded downstream.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return YOUTUBE_HOSTS.has(parsed.hostname) && hasVideoId(parsed);
  } catch {
    return false;
  }
}

export const youtubeUrlSchema = z
  .url()
  .refine(isYoutubeUrl, {
    message: "URL must be a YouTube URL",
  });

// BCP-47 primary subtag + optional region/script (e.g. "en", "fra", "en-US",
// "zh-Hans", "zh-Hant-TW"). Pinned at the schema boundary so arbitrary
// strings ("--model", " ; rm -rf /", emoji) never reach child_process.
// execFile with an argv array already blocks shell injection — this
// regex blocks the narrower class of "lang that looks like a CLI flag"
// that would produce confusing whisper errors instead of clean rejection.
const LANGUAGE_SENTINELS = new Set(["und", "zxx", "mul", "mis"]);

export const languageCodeSchema = z
  .string()
  .regex(
    /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
    "lang must be a BCP-47 tag (e.g. en, fr, zh-Hans)"
  )
  .refine(
    (value) => !LANGUAGE_SENTINELS.has(value.toLowerCase().split("-")[0]),
    "lang must not be an undetermined or non-linguistic sentinel"
  );
