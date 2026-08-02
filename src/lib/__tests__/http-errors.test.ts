import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  respondWithOperationalOutcome,
  type OperationalOutcome,
} from "../http-errors.js";
import {
  requestIdMiddleware,
  type ServiceEnv,
} from "../request-id.js";

const expected = {
  "auth-invalid-format": {
    status: 401,
    message: "Unauthorized",
    errorId: "AUTH_INVALID_FORMAT",
  },
  "auth-invalid-key": {
    status: 403,
    message: "Forbidden",
    errorId: "AUTH_INVALID_KEY",
  },
  "request-body-too-large": {
    status: 413,
    message: "Request body too large",
    errorId: "REQUEST_BODY_TOO_LARGE",
  },
  "invalid-json": {
    status: 400,
    message: "Invalid JSON body",
    errorId: "INVALID_JSON",
  },
  "invalid-request": {
    status: 400,
    message: "Invalid request",
    errorId: "INVALID_REQUEST",
  },
  "captions-not-found": {
    status: 404,
    message: "no_captions",
    errorId: "CAPTIONS_NOT_FOUND",
  },
  "captions-failed": {
    status: 500,
    message: "Internal error",
    errorId: "CAPTIONS_FAILED",
  },
  "metadata-failed": {
    status: 500,
    message: "Metadata fetch failed",
    errorId: "METADATA_FAILED",
  },
  "media-size-exceeded": {
    status: 413,
    message: "Video exceeds the processing limit",
    errorId: "MEDIA_SIZE_EXCEEDED",
  },
  "media-duration-unknown": {
    status: 503,
    message: "Video duration could not be determined",
    errorId: "MEDIA_DURATION_UNKNOWN",
  },
  "media-duration-exceeded": {
    status: 413,
    message: "Video exceeds the processing limit",
    errorId: "MEDIA_DURATION_EXCEEDED",
  },
  "temporarily-unavailable": {
    status: 503,
    message: "Transcription temporarily unavailable",
    errorId: "TRANSCRIPTION_TEMPORARILY_UNAVAILABLE",
  },
  "empty-result": {
    status: 500,
    message: "Transcription produced no content",
    errorId: "TRANSCRIPTION_EMPTY_RESULT",
  },
  "transcription-failed": {
    status: 500,
    message: "Transcription failed",
    errorId: "TRANSCRIPTION_FAILED",
  },
  "rate-limited": {
    status: 429,
    message: "Too many requests",
    errorId: "RATE_LIMITED",
  },
  "transcription-busy": {
    status: 429,
    message: "Transcription busy",
    errorId: "TRANSCRIPTION_BUSY",
  },
  "endpoint-timeout": {
    status: 504,
    message: "Transcription service timed out",
    errorId: "ENDPOINT_TIMEOUT",
  },
} satisfies Record<OperationalOutcome, {
  status: number;
  message: string;
  errorId: string;
}>;

describe("operational outcomes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(Object.entries(expected))(
    "maps %s to its complete HTTP contract",
    async (outcome, contract) => {
      const catalogTestContext = {
        videoId: "catalog-test",
        errorName: "CatalogTest",
        stage: "transcribe" as const,
      };
      const app = new Hono<ServiceEnv>();
      app.use("*", requestIdMiddleware);
      app.get("/", (c) =>
        respondWithOperationalOutcome(
          c,
          outcome as OperationalOutcome,
          catalogTestContext,
        ),
      );

      const response = await app.request("/", {
        headers: { "X-Request-ID": "outcome-request-id" },
      });

      expect(response.status).toBe(contract.status);
      expect(await response.json()).toEqual({
        error: contract.message,
        errorId: contract.errorId,
        requestId: "outcome-request-id",
      });
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("X-Error-ID")).toBe(contract.errorId);
      expect(response.headers.get("X-Request-ID")).toBe("outcome-request-id");
    },
  );

  it("emits the catalogued safe log for a failed caption request", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hostileContext = {
      videoId: "dQw4w9WgXcQ",
      errorName: "ProviderError",
      errorId: "CALLER_OVERRIDE",
      status: 999,
      secret: "must-not-be-logged",
    };
    const app = new Hono<ServiceEnv>();
    app.use("*", requestIdMiddleware);
    app.get("/", (c) =>
      respondWithOperationalOutcome(c, "captions-failed", hostileContext),
    );

    await app.request("/", {
      headers: { "X-Request-ID": "outcome-request-id" },
    });

    expect(errorSpy).toHaveBeenCalledWith("[captions.failed]", {
      requestId: "outcome-request-id",
      errorId: "CAPTIONS_FAILED",
      status: 500,
      videoId: "dQw4w9WgXcQ",
      errorName: "ProviderError",
    });
  });

  it("emits the catalogued safe log for a failed metadata request", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono<ServiceEnv>();
    app.use("*", requestIdMiddleware);
    app.get("/", (c) =>
      respondWithOperationalOutcome(c, "metadata-failed", {
        videoId: "dQw4w9WgXcQ",
        errorName: "ProviderError",
      }),
    );

    await app.request("/", {
      headers: { "X-Request-ID": "outcome-request-id" },
    });

    expect(errorSpy).toHaveBeenCalledWith("[metadata.failed]", {
      videoId: "dQw4w9WgXcQ",
      errorName: "ProviderError",
      requestId: "outcome-request-id",
      errorId: "METADATA_FAILED",
      status: 500,
    });
  });

  it.each([
    {
      outcome: "rate-limited" as const,
      level: "warn" as const,
      event: "resource_limits.rate_limited",
      status: 429,
      errorId: "RATE_LIMITED",
    },
    {
      outcome: "transcription-busy" as const,
      level: "warn" as const,
      event: "resource_limits.concurrency_limited",
      status: 429,
      errorId: "TRANSCRIPTION_BUSY",
    },
    {
      outcome: "endpoint-timeout" as const,
      level: "warn" as const,
      event: "resource_limits.endpoint_timeout",
      status: 504,
      errorId: "ENDPOINT_TIMEOUT",
    },
  ])("emits the catalogued safe log for $outcome", async (entry) => {
    const logSpy = vi
      .spyOn(console, entry.level)
      .mockImplementation(() => {});
    const app = new Hono<ServiceEnv>();
    app.use("*", requestIdMiddleware);
    app.get("/", (c) =>
      respondWithOperationalOutcome(c, entry.outcome, {
        stage: "transcribe",
      }),
    );

    await app.request("/", {
      headers: { "X-Request-ID": "outcome-request-id" },
    });

    expect(logSpy).toHaveBeenCalledWith(`[${entry.event}]`, {
      requestId: "outcome-request-id",
      errorId: entry.errorId,
      status: entry.status,
      stage: "transcribe",
    });
  });
});
