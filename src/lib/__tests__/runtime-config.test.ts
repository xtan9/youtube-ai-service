import { describe, expect, it } from "vitest";
import {
  loadRuntimeConfig,
  RuntimeConfigError,
} from "../runtime-config.js";

describe("loadRuntimeConfig", () => {
  it("builds a normalized runtime snapshot with production defaults", () => {
    const config = loadRuntimeConfig({ VPS_API_KEY: "  current-key  " });

    expect(config).toEqual({
      server: { port: 3001 },
      auth: { apiKeys: ["current-key"] },
      admission: {
        requestBodyMaxBytes: 65_536,
        mediaMaxBytes: 50_000_000,
        mediaMaxDurationSeconds: 5_400,
        rateLimitWindowMs: 60_000,
        rateLimitMaxRequests: 60,
        maxConcurrentJobs: 2,
        endpointTimeoutMs: {
          metadata: 30_000,
          captions: 30_000,
          transcribe: 300_000,
        },
      },
      transcription: {
        groq: null,
        localFallbackMaxSeconds: 180,
      },
      mediaAcquisition: {
        potProviderUrl: "http://127.0.0.1:4416",
      },
    });
  });

  it("normalizes explicit settings into their consumer groups", () => {
    const config = loadRuntimeConfig({
      VPS_API_KEY: "current",
      VPS_API_KEY_PREVIOUS: " previous ",
      PORT: "4100",
      MAX_REQUEST_BODY_BYTES: "1024",
      MAX_MEDIA_SIZE_BYTES: "2048",
      MAX_MEDIA_DURATION_SECONDS: "12.5",
      RATE_LIMIT_WINDOW_MS: "3000",
      RATE_LIMIT_MAX_REQUESTS: "7",
      MAX_CONCURRENT_JOBS: "3",
      METADATA_TIMEOUT_MS: "4000",
      CAPTIONS_TIMEOUT_MS: "5000",
      TRANSCRIBE_TIMEOUT_MS: "6000",
      GROQ_API_KEY: " groq-secret ",
      GROQ_MODEL: " custom-model ",
      GROQ_TIMEOUT_MS: "7000",
      GROQ_LOCAL_FALLBACK_MAX_SECONDS: "45.5",
      POT_PROVIDER_URL: "http://pot-provider.internal:4416",
    });

    expect(config).toEqual({
      server: { port: 4100 },
      auth: { apiKeys: ["current", "previous"] },
      admission: {
        requestBodyMaxBytes: 1024,
        mediaMaxBytes: 2048,
        mediaMaxDurationSeconds: 12.5,
        rateLimitWindowMs: 3000,
        rateLimitMaxRequests: 7,
        maxConcurrentJobs: 3,
        endpointTimeoutMs: {
          metadata: 4000,
          captions: 5000,
          transcribe: 6000,
        },
      },
      transcription: {
        groq: {
          apiKey: "groq-secret",
          model: "custom-model",
          timeoutMs: 7000,
        },
        localFallbackMaxSeconds: 45.5,
      },
      mediaAcquisition: {
        potProviderUrl: "http://pot-provider.internal:4416",
      },
    });
  });

  it("rejects all invalid settings without exposing their values", () => {
    const invalidSecret = "do-not-print-this";

    let thrown: unknown;
    try {
      loadRuntimeConfig({
        VPS_API_KEY: " ",
        VPS_API_KEY_PREVIOUS: invalidSecret,
        PORT: "65536",
        MAX_REQUEST_BODY_BYTES: "1.5",
        MAX_MEDIA_DURATION_SECONDS: "-2",
        GROQ_TIMEOUT_MS: "later",
        POT_PROVIDER_URL: "ftp://not-supported.example",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeConfigError);
    expect((thrown as RuntimeConfigError).invalidSettings).toEqual([
      "VPS_API_KEY",
      "PORT",
      "MAX_REQUEST_BODY_BYTES",
      "MAX_MEDIA_DURATION_SECONDS",
      "GROQ_TIMEOUT_MS",
      "POT_PROVIDER_URL",
    ]);
    expect((thrown as Error).message).not.toContain(invalidSecret);
  });

  it("returns a deeply immutable snapshot", () => {
    const config = loadRuntimeConfig({
      VPS_API_KEY: "current",
      GROQ_API_KEY: "groq",
    });

    expect(() => {
      (config.server as { port: number }).port = 9999;
    }).toThrow(TypeError);
    expect(() => {
      (config.auth.apiKeys as string[]).push("unexpected");
    }).toThrow(TypeError);
    expect(() => {
      (config.transcription.groq as { model: string }).model = "unexpected";
    }).toThrow(TypeError);
  });
});
