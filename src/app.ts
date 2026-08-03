import { Hono } from "hono";
import { logger } from "hono/logger";
import {
  createProductionCaptionTrackAcquisition,
  type CaptionTrackAcquisition,
} from "./lib/captions.js";
import type { RuntimeConfig } from "./lib/runtime-config.js";
import { createResourceAdmission } from "./lib/resource-limits.js";
import type { ServiceEnv } from "./lib/request-id.js";
import {
  createProductionTranscriptionWorkflow,
  type TranscriptionWorkflow,
} from "./lib/transcription-workflow.js";
import {
  createProductionVideoInformationWorkflow,
  type VideoInformationWorkflow,
} from "./lib/video-information-workflow.js";
import {
  createCaptionsRoute,
} from "./routes/captions.js";
import { health } from "./routes/health.js";
import {
  createMetadataRoute,
} from "./routes/metadata.js";
import { createTranscribeRoute } from "./routes/transcribe.js";

export interface AppAdapters {
  captionTrackAcquisition: CaptionTrackAcquisition;
  videoInformationWorkflow: VideoInformationWorkflow;
  transcriptionWorkflow: TranscriptionWorkflow;
}

function createProductionAppAdapters(config: RuntimeConfig): AppAdapters {
  return {
    captionTrackAcquisition: createProductionCaptionTrackAcquisition(),
    videoInformationWorkflow: createProductionVideoInformationWorkflow(config),
    transcriptionWorkflow: createProductionTranscriptionWorkflow(config),
  };
}

export function createApp(
  config: RuntimeConfig,
  adapters: AppAdapters = createProductionAppAdapters(config),
): Hono<ServiceEnv> {
  const app = new Hono<ServiceEnv>();
  const admission = createResourceAdmission(config.admission);

  app.use("*", logger());
  app.route("/", health);
  app.route(
    "/transcribe",
    createTranscribeRoute(config, admission, adapters.transcriptionWorkflow),
  );
  app.route(
    "/captions",
    createCaptionsRoute(config, admission, {
      captionTrackAcquisition: adapters.captionTrackAcquisition,
    }),
  );
  app.route(
    "/metadata",
    createMetadataRoute(config, admission, adapters.videoInformationWorkflow),
  );

  return app;
}
