import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { health } from "./routes/health.js";
import { transcribe } from "./routes/transcribe.js";
import { authMiddleware } from "./middleware/auth.js";

const app = new Hono();

app.use("*", logger());

// Health check — no auth required
app.route("/", health);

// Transcription — requires auth
app.use("/transcribe", authMiddleware);
app.route("/", transcribe);

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`youtube-ai-service starting on port ${port}`);

serve({ fetch: app.fetch, port });
