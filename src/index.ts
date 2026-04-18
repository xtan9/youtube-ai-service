import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { health } from "./routes/health.js";
import { transcribe } from "./routes/transcribe.js";
import { captions } from "./routes/captions.js";
import { authMiddleware } from "./middleware/auth.js";

const app = new Hono();

app.use("*", logger());

// Health check — no auth required
app.route("/", health);

// Both caption and transcribe egress through the Tailscale exit node, so
// YouTube sees a residential IP and doesn't strip caption tracks or flag
// yt-dlp as a bot. Both require auth.
app.use("/transcribe", authMiddleware);
app.use("/captions", authMiddleware);
app.route("/", transcribe);
app.route("/", captions);

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`youtube-ai-service starting on port ${port}`);

serve({ fetch: app.fetch, port });
