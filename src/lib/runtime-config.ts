export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface ServerConfig {
  readonly port: number;
}

export interface AuthConfig {
  readonly apiKeys: readonly string[];
}

export interface AdmissionConfig {
  readonly requestBodyMaxBytes: number;
  readonly mediaMaxBytes: number;
  readonly mediaMaxDurationSeconds: number;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMaxRequests: number;
  readonly maxConcurrentJobs: number;
  readonly endpointTimeoutMs: {
    readonly metadata: number;
    readonly captions: number;
    readonly transcribe: number;
  };
}

export interface GroqConfig {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface TranscriptionConfig {
  readonly groq: GroqConfig | null;
  readonly localFallbackMaxSeconds: number;
}

export interface MediaAcquisitionConfig {
  readonly potProviderUrl: string;
}

export interface RuntimeConfig {
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly admission: AdmissionConfig;
  readonly transcription: TranscriptionConfig;
  readonly mediaAcquisition: MediaAcquisitionConfig;
}

export interface RuntimeConfigInput {
  readonly auth: AuthConfig;
  readonly server?: Partial<ServerConfig>;
  readonly admission?: Partial<Omit<AdmissionConfig, "endpointTimeoutMs">> & {
    readonly endpointTimeoutMs?: Partial<AdmissionConfig["endpointTimeoutMs"]>;
  };
  readonly transcription?: Partial<TranscriptionConfig>;
  readonly mediaAcquisition?: Partial<MediaAcquisitionConfig>;
}

const DEFAULTS = {
  port: 3001,
  requestBodyMaxBytes: 65_536,
  mediaMaxBytes: 50_000_000,
  mediaMaxDurationSeconds: 5_400,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 60,
  maxConcurrentJobs: 2,
  metadataTimeoutMs: 30_000,
  captionsTimeoutMs: 30_000,
  transcribeTimeoutMs: 300_000,
  groqModel: "whisper-large-v3",
  groqApiUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
  groqTimeoutMs: 180_000,
  localFallbackMaxSeconds: 180,
  potProviderUrl: "http://127.0.0.1:4416",
} as const;

export class RuntimeConfigError extends Error {
  constructor(public readonly invalidSettings: readonly string[]) {
    super(`Invalid runtime configuration: ${invalidSettings.join(", ")}`);
    this.name = "RuntimeConfigError";
  }
}

function readNonBlankSetting(
  env: RuntimeEnvironment,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function positiveNumberSetting(
  env: RuntimeEnvironment,
  name: string,
  defaultValue: number,
  invalidSettings: string[],
  options: { integer?: boolean; maximum?: number } = {},
): number {
  const raw = readNonBlankSetting(env, name);
  if (raw === undefined) return defaultValue;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    invalidSettings.push(name);
    return defaultValue;
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (options.integer && !Number.isInteger(value)) ||
    (options.maximum !== undefined && value > options.maximum)
  ) {
    invalidSettings.push(name);
    return defaultValue;
  }
  return value;
}

function urlSetting(
  env: RuntimeEnvironment,
  name: string,
  defaultValue: string,
  invalidSettings: string[],
): string {
  const raw = readNonBlankSetting(env, name);
  if (raw === undefined) return defaultValue;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new Error("unsupported URL");
    }
    return raw;
  } catch {
    invalidSettings.push(name);
    return defaultValue;
  }
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

export function createRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  const endpointTimeoutMs = {
    metadata: DEFAULTS.metadataTimeoutMs,
    captions: DEFAULTS.captionsTimeoutMs,
    transcribe: DEFAULTS.transcribeTimeoutMs,
    ...input.admission?.endpointTimeoutMs,
  };

  return deepFreeze({
    server: {
      port: input.server?.port ?? DEFAULTS.port,
    },
    auth: {
      apiKeys: [...input.auth.apiKeys],
    },
    admission: {
      requestBodyMaxBytes: DEFAULTS.requestBodyMaxBytes,
      mediaMaxBytes: DEFAULTS.mediaMaxBytes,
      mediaMaxDurationSeconds: DEFAULTS.mediaMaxDurationSeconds,
      rateLimitWindowMs: DEFAULTS.rateLimitWindowMs,
      rateLimitMaxRequests: DEFAULTS.rateLimitMaxRequests,
      maxConcurrentJobs: DEFAULTS.maxConcurrentJobs,
      ...input.admission,
      endpointTimeoutMs,
    },
    transcription: {
      groq: input.transcription?.groq ? { ...input.transcription.groq } : null,
      localFallbackMaxSeconds:
        input.transcription?.localFallbackMaxSeconds ??
        DEFAULTS.localFallbackMaxSeconds,
    },
    mediaAcquisition: {
      potProviderUrl:
        input.mediaAcquisition?.potProviderUrl ?? DEFAULTS.potProviderUrl,
    },
  });
}

export function loadRuntimeConfig(env: RuntimeEnvironment): RuntimeConfig {
  const invalidSettings: string[] = [];
  const currentApiKey = readNonBlankSetting(env, "VPS_API_KEY");
  if (!currentApiKey) invalidSettings.push("VPS_API_KEY");
  const previousApiKey = readNonBlankSetting(env, "VPS_API_KEY_PREVIOUS");
  const groqApiKey = readNonBlankSetting(env, "GROQ_API_KEY");
  const port = positiveNumberSetting(
    env,
    "PORT",
    DEFAULTS.port,
    invalidSettings,
    {
      integer: true,
      maximum: 65_535,
    },
  );
  const requestBodyMaxBytes = positiveNumberSetting(
    env,
    "MAX_REQUEST_BODY_BYTES",
    DEFAULTS.requestBodyMaxBytes,
    invalidSettings,
    { integer: true },
  );
  const mediaMaxBytes = positiveNumberSetting(
    env,
    "MAX_MEDIA_SIZE_BYTES",
    DEFAULTS.mediaMaxBytes,
    invalidSettings,
    { integer: true },
  );
  const mediaMaxDurationSeconds = positiveNumberSetting(
    env,
    "MAX_MEDIA_DURATION_SECONDS",
    DEFAULTS.mediaMaxDurationSeconds,
    invalidSettings,
  );
  const rateLimitWindowMs = positiveNumberSetting(
    env,
    "RATE_LIMIT_WINDOW_MS",
    DEFAULTS.rateLimitWindowMs,
    invalidSettings,
    { integer: true },
  );
  const rateLimitMaxRequests = positiveNumberSetting(
    env,
    "RATE_LIMIT_MAX_REQUESTS",
    DEFAULTS.rateLimitMaxRequests,
    invalidSettings,
    { integer: true },
  );
  const maxConcurrentJobs = positiveNumberSetting(
    env,
    "MAX_CONCURRENT_JOBS",
    DEFAULTS.maxConcurrentJobs,
    invalidSettings,
    { integer: true },
  );
  const metadataTimeoutMs = positiveNumberSetting(
    env,
    "METADATA_TIMEOUT_MS",
    DEFAULTS.metadataTimeoutMs,
    invalidSettings,
    { integer: true },
  );
  const captionsTimeoutMs = positiveNumberSetting(
    env,
    "CAPTIONS_TIMEOUT_MS",
    DEFAULTS.captionsTimeoutMs,
    invalidSettings,
    { integer: true },
  );
  const transcribeTimeoutMs = positiveNumberSetting(
    env,
    "TRANSCRIBE_TIMEOUT_MS",
    DEFAULTS.transcribeTimeoutMs,
    invalidSettings,
    { integer: true },
  );
  const groqTimeoutMs = positiveNumberSetting(
    env,
    "GROQ_TIMEOUT_MS",
    DEFAULTS.groqTimeoutMs,
    invalidSettings,
    { integer: true },
  );
  const groqApiUrl = urlSetting(
    env,
    "GROQ_API_URL",
    DEFAULTS.groqApiUrl,
    invalidSettings,
  );
  const localFallbackMaxSeconds = positiveNumberSetting(
    env,
    "GROQ_LOCAL_FALLBACK_MAX_SECONDS",
    DEFAULTS.localFallbackMaxSeconds,
    invalidSettings,
  );
  const potProviderUrl = urlSetting(
    env,
    "POT_PROVIDER_URL",
    DEFAULTS.potProviderUrl,
    invalidSettings,
  );

  if (invalidSettings.length > 0) {
    throw new RuntimeConfigError(invalidSettings);
  }

  return createRuntimeConfig({
    server: { port },
    auth: {
      apiKeys: previousApiKey
        ? [currentApiKey!, previousApiKey]
        : [currentApiKey!],
    },
    admission: {
      requestBodyMaxBytes,
      mediaMaxBytes,
      mediaMaxDurationSeconds,
      rateLimitWindowMs,
      rateLimitMaxRequests,
      maxConcurrentJobs,
      endpointTimeoutMs: {
        metadata: metadataTimeoutMs,
        captions: captionsTimeoutMs,
        transcribe: transcribeTimeoutMs,
      },
    },
    transcription: {
      groq: groqApiKey
        ? {
            apiKey: groqApiKey,
            apiUrl: groqApiUrl,
            model: readNonBlankSetting(env, "GROQ_MODEL") ?? DEFAULTS.groqModel,
            timeoutMs: groqTimeoutMs,
          }
        : null,
      localFallbackMaxSeconds,
    },
    mediaAcquisition: {
      potProviderUrl,
    },
  });
}
