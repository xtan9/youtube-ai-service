import { Hono } from "hono";
import { logger } from "hono/logger";
import type { RuntimeConfig } from "./lib/runtime-config.js";
import { createResourceAdmission } from "./lib/resource-limits.js";
import type { ServiceEnv } from "./lib/request-id.js";
import { createCaptionsRoute } from "./routes/captions.js";
import { health } from "./routes/health.js";
import { createMetadataRoute } from "./routes/metadata.js";
import { createTranscribeRoute } from "./routes/transcribe.js";

export function createApp(config: RuntimeConfig): Hono<ServiceEnv> {
  const app = new Hono<ServiceEnv>();
  const admission = createResourceAdmission(config.admission);

  app.use("*", logger());
  app.route("/", health);
  app.route("/transcribe", createTranscribeRoute(config, admission));
  app.route("/captions", createCaptionsRoute(config, admission));
  app.route("/metadata", createMetadataRoute(config, admission));

  return app;
}
