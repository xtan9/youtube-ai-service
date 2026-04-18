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

export function isYoutubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Reject non-http(s) schemes even if the host is right — `ftp://`,
    // `javascript:`, `data:` URLs with a youtube host are still not
    // valid YouTube videos and shouldn't be forwarded downstream.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return YOUTUBE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export const youtubeUrlSchema = z
  .string()
  .url()
  .refine(isYoutubeUrl, {
    message: "URL must be a YouTube URL",
  });
