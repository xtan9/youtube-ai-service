import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { jsonError } from "./http-errors.js";
import { logServiceEvent } from "./observability.js";
import type { ServiceEnv } from "./request-id.js";
import type { AdmissionConfig } from "./runtime-config.js";

export type ResourceLimitEndpoint = "metadata" | "captions" | "transcribe";
export type ResourceLimitConfig = AdmissionConfig;

export type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too_large" | "invalid_json" };

/**
 * Read and parse JSON without ever buffering more than the configured body
 * limit. Content-Length is only an early rejection; chunked requests are
 * bounded by the reader loop as well.
 */
export async function readBoundedJson(
  request: Request,
  maxBytes: number
): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxBytes
    ) {
      await request.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) return { ok: false, reason: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid_json" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

const rateBuckets = new Map<string, { startedAt: number; count: number }>();
let activeTranscriptionJobs = 0;

export function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function consumeRateLimit(
  key: string,
  config: ResourceLimitConfig,
  now = Date.now()
): boolean {
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= config.rateLimitWindowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= config.rateLimitMaxRequests) return false;
  current.count += 1;
  return true;
}

function tryAcquireTranscriptionJob(config: ResourceLimitConfig): (() => void) | null {
  if (activeTranscriptionJobs >= config.maxConcurrentJobs) return null;
  activeTranscriptionJobs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTranscriptionJobs -= 1;
  };
}

/** Test-only reset hook; production code never needs to clear process state. */
export function resetResourceLimitState(): void {
  rateBuckets.clear();
  activeTranscriptionJobs = 0;
}

export const resourceLimitMiddleware = (
  endpoint: ResourceLimitEndpoint,
  config: AdmissionConfig
): MiddlewareHandler<ServiceEnv> => async (c, next) => {
  c.set("resourceLimits", config);

  const keyFingerprint = c.get("apiKeyFingerprint");
  if (!keyFingerprint || !consumeRateLimit(keyFingerprint, config)) {
    logServiceEvent("warn", "resource_limits.rate_limited", {
      errorId: "RATE_LIMITED",
      requestId: c.get("requestId"),
      stage: endpoint,
    });
    return jsonError(c, 429, "Too many requests", "RATE_LIMITED");
  }

  const releaseJob =
    endpoint === "transcribe" ? tryAcquireTranscriptionJob(config) : null;
  if (endpoint === "transcribe" && !releaseJob) {
    logServiceEvent("warn", "resource_limits.concurrency_limited", {
      errorId: "TRANSCRIPTION_BUSY",
      requestId: c.get("requestId"),
      stage: endpoint,
    });
    return jsonError(c, 429, "Transcription busy", "TRANSCRIPTION_BUSY");
  }

  let timedOut = false;
  const downstream = next();
  const completion = downstream.then(
    () => {
      if (!timedOut) releaseJob?.();
    },
    (error) => {
      if (!timedOut) releaseJob?.();
      throw error;
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), config.endpointTimeoutMs[endpoint]);
  });
  const outcome = await Promise.race([
    completion.then(() => "complete" as const),
    timeout,
  ]);
  if (timer) clearTimeout(timer);

  if (outcome === "timeout") {
    timedOut = true;
    // Keep the concurrency slot occupied until the underlying work actually
    // stops. This prevents a timed-out child process from being replaced by
    // an unbounded stream of new jobs.
    void completion.then(
      () => releaseJob?.(),
      () => releaseJob?.()
    );
    logServiceEvent("warn", "resource_limits.endpoint_timeout", {
      errorId: "ENDPOINT_TIMEOUT",
      requestId: c.get("requestId"),
      stage: endpoint,
    });
    return jsonError(
      c,
      504,
      "Transcription service timed out",
      "ENDPOINT_TIMEOUT"
    );
  }
};
