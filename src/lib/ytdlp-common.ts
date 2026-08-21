import type { MediaAcquisitionConfig } from "./runtime-config.js";

// Flags and constants shared between yt-dlp invocations (audio download,
// metadata dump). Extracted so `buildYtdlpArgs` and `buildYtdlpMetadataArgs`
// can't drift out of sync — a player_client or PO Token change made in one
// call path must apply to the other.

// Datacenter IPs frequently hit YouTube's "Sign in to confirm you're not a
// bot" wall when yt-dlp uses the default `web` player client. Keep one
// PO-Token-capable client here: the provider issues a client-bound GVS token,
// so listing multiple clients can issue a web_safari token and then select an
// mweb media URL, which the CDN rejects with HTTP 403.
export const YOUTUBE_PLAYER_CLIENTS = "mweb";

// Pair the client list with a browser UA so the request profile matches.
export const SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// Proof-of-Origin Token provider. `pot-provider` is the sibling container
// (see docker-compose.yml) that shares our network namespace, so it's
// reachable on localhost. YouTube enforces PO Tokens across multiple
// extraction paths — without this, requests fail regardless of IP
// reputation or cookie state. Override via env for local dev or if the
// sidecar's bind address changes.

/**
 * Common flags every yt-dlp invocation shares: playlist guard, YouTube
 * extractor tweaks (player_client + PO Token), and the matched User-Agent.
 */
export function buildYtdlpCommonArgs(
  config: MediaAcquisitionConfig
): string[] {
  return [
    "--no-playlist",
    // yt-dlp no longer ships an internal YouTube challenge interpreter.
    // Keep the runtime explicit so a PATH/image regression fails visibly
    // instead of degrading into signed media URLs that return HTTP 403.
    "--js-runtimes",
    "deno",
    "--extractor-args",
    `youtube:player_client=${YOUTUBE_PLAYER_CLIENTS}`,
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`,
    "--user-agent",
    SAFARI_USER_AGENT,
  ];
}
