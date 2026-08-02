import type {
  AdmissionConfig,
  TranscriptionConfig,
} from "../lib/runtime-config.js";
import {
  createRuntimeConfig,
  type RuntimeConfig,
} from "../lib/runtime-config.js";

interface TestRuntimeConfigOptions {
  readonly apiKeys?: readonly string[];
  readonly admission?: Partial<Omit<AdmissionConfig, "endpointTimeoutMs">> & {
    readonly endpointTimeoutMs?: Partial<AdmissionConfig["endpointTimeoutMs"]>;
  };
  readonly transcription?: Partial<TranscriptionConfig>;
}

export function createTestRuntimeConfig(
  options: TestRuntimeConfigOptions = {},
): RuntimeConfig {
  return createRuntimeConfig({
    auth: { apiKeys: options.apiKeys ?? ["test-key"] },
    admission: {
      // Deliberately generous test-only capacity; all other defaults come
      // from the same typed adapter production uses after environment parsing.
      rateLimitMaxRequests: 1_000,
      maxConcurrentJobs: 8,
      ...options.admission,
    },
    transcription: options.transcription,
  });
}
