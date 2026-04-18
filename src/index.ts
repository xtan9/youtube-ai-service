import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { health } from "./routes/health.js";
import { transcribe } from "./routes/transcribe.js";
import { captions } from "./routes/captions.js";

const app = new Hono();

app.use("*", logger());

// Health check — no auth required
app.route("/", health);

// Both data endpoints egress through the Tailscale exit node so YouTube
// sees a residential IP. Auth middleware is attached inside each router
// (not here) so future sub-routes can't bypass it.
app.route("/", transcribe);
app.route("/", captions);

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`youtube-ai-service starting on port ${port}`);

serve({ fetch: app.fetch, port });
