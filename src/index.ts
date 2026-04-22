// Must run before any HTTP client is created — see prefer-ipv4.ts for why.
import "./lib/prefer-ipv4.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { health } from "./routes/health.js";
import { transcribe } from "./routes/transcribe.js";
import { captions } from "./routes/captions.js";
import { metadata } from "./routes/metadata.js";

const app = new Hono();

app.use("*", logger());

// Health check — no auth required
app.route("/", health);

// Both data endpoints egress through the Tailscale exit node so YouTube
// sees a residential IP. Auth middleware is attached inside each router
// with `use("*", authMiddleware)` — mounting at the prefixed path (not
// at `/`) is required for that `*` to actually scope to the sub-router's
// path. Mounting at `/` would make auth fire on /health too.
app.route("/transcribe", transcribe);
app.route("/captions", captions);
app.route("/metadata", metadata);

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`youtube-ai-service starting on port ${port}`);

serve({ fetch: app.fetch, port });
