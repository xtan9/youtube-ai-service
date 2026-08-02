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
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedJsonResult> {
  signal?.throwIfAborted();
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
  const cancelRead = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelRead, { once: true });
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
    signal?.removeEventListener("abort", cancelRead);
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

export function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export interface ResourceAdmission {
  middleware(endpoint: ResourceLimitEndpoint): MiddlewareHandler<ServiceEnv>;
}

export interface AdmissionClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}

const productionClock: AdmissionClock = {
  now: Date.now,
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export function createResourceAdmission(
  config: ResourceLimitConfig,
  clock: AdmissionClock = productionClock,
): ResourceAdmission {
  const rateBuckets = new Map<
    string,
    { startedAt: number; count: number }
  >();
  let activeTranscriptionJobs = 0;

  function consumeRateLimit(key: string): boolean {
    const now = clock.now();
    const current = rateBuckets.get(key);
    if (!current || now - current.startedAt >= config.rateLimitWindowMs) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= config.rateLimitMaxRequests) return false;
    current.count += 1;
    return true;
  }

  function tryAcquireTranscriptionJob(): (() => void) | null {
    if (activeTranscriptionJobs >= config.maxConcurrentJobs) return null;
    activeTranscriptionJobs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeTranscriptionJobs -= 1;
    };
  }

  return {
    middleware: (endpoint) => async (c, next) => {
      c.set("resourceLimits", config);

      const keyFingerprint = c.get("apiKeyFingerprint");
      if (!keyFingerprint || !consumeRateLimit(keyFingerprint)) {
        logServiceEvent("warn", "resource_limits.rate_limited", {
          errorId: "RATE_LIMITED",
          requestId: c.get("requestId"),
          stage: endpoint,
        });
        return jsonError(c, 429, "Too many requests", "RATE_LIMITED");
      }

      const releaseJob =
        endpoint === "transcribe" ? tryAcquireTranscriptionJob() : null;
      if (endpoint === "transcribe" && !releaseJob) {
        logServiceEvent("warn", "resource_limits.concurrency_limited", {
          errorId: "TRANSCRIPTION_BUSY",
          requestId: c.get("requestId"),
          stage: endpoint,
        });
        return jsonError(c, 429, "Transcription busy", "TRANSCRIPTION_BUSY");
      }

      const deadlineController = new AbortController();
      c.set(
        "workSignal",
        AbortSignal.any([c.req.raw.signal, deadlineController.signal]),
      );
      let cancelDeadline = () => {};
      const timeout = new Promise<"timeout">((resolve) => {
        cancelDeadline = clock.schedule(
          config.endpointTimeoutMs[endpoint],
          () => {
            deadlineController.abort(
              new DOMException("Endpoint deadline exceeded", "TimeoutError"),
            );
            resolve("timeout");
          },
        );
      });
      const completion = next();
      let outcome: "complete" | "timeout";
      try {
        outcome = await Promise.race([
          completion.then(() => "complete" as const),
          timeout,
        ]);
      } catch (error) {
        cancelDeadline();
        releaseJob?.();
        throw error;
      }
      cancelDeadline();

      if (outcome === "timeout") {
        await completion.catch(() => undefined);
        releaseJob?.();
        logServiceEvent("warn", "resource_limits.endpoint_timeout", {
          errorId: "ENDPOINT_TIMEOUT",
          requestId: c.get("requestId"),
          stage: endpoint,
        });
        const response = jsonError(
          c,
          504,
          "Transcription service timed out",
          "ENDPOINT_TIMEOUT",
        );
        c.res = response;
        return response;
      }
      releaseJob?.();
    },
  };
}
