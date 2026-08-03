import type { Context } from "hono";
import { logServiceEvent } from "./observability.js";
import type { ServiceEnv } from "./request-id.js";

type AdmissionStage = "metadata" | "captions" | "transcribe";

function selectProviderFailureContext(context: {
  readonly videoId: string;
  readonly errorName: string;
}): { videoId: string; errorName: string } {
  return {
    videoId: context.videoId,
    errorName: context.errorName,
  };
}

function selectStageContext<Stage extends AdmissionStage>(context: {
  readonly stage: Stage;
}): { stage: Stage } {
  return { stage: context.stage };
}

const selectAdmissionStageContext = selectStageContext<AdmissionStage>;
const selectTranscriptionStageContext = selectStageContext<"transcribe">;

const operationalOutcomes = {
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
    log: {
      level: "error",
      event: "captions.failed",
      selectContext: selectProviderFailureContext,
    },
  },
  "metadata-failed": {
    status: 500,
    message: "Metadata fetch failed",
    errorId: "METADATA_FAILED",
    log: {
      level: "error",
      event: "metadata.failed",
      selectContext: selectProviderFailureContext,
    },
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
    log: {
      level: "warn",
      event: "resource_limits.rate_limited",
      selectContext: selectAdmissionStageContext,
    },
  },
  "transcription-busy": {
    status: 429,
    message: "Transcription busy",
    errorId: "TRANSCRIPTION_BUSY",
    log: {
      level: "warn",
      event: "resource_limits.concurrency_limited",
      selectContext: selectTranscriptionStageContext,
    },
  },
  "endpoint-timeout": {
    status: 504,
    message: "Transcription service timed out",
    errorId: "ENDPOINT_TIMEOUT",
    log: {
      level: "warn",
      event: "resource_limits.endpoint_timeout",
      selectContext: selectAdmissionStageContext,
    },
  },
} as const;

export type OperationalOutcome = keyof typeof operationalOutcomes;

type OperationalOutcomeCatalog = typeof operationalOutcomes;
type LoggedOperationalOutcome = {
  [Outcome in OperationalOutcome]: OperationalOutcomeCatalog[Outcome] extends {
    readonly log: unknown;
  }
    ? Outcome
    : never;
}[OperationalOutcome];
type OperationalLogContext<Outcome extends LoggedOperationalOutcome> =
  OperationalOutcomeCatalog[Outcome] extends {
    readonly log: {
      readonly selectContext: (context: infer Context) => unknown;
    };
  }
    ? Context
    : never;
type OperationalContextArguments<Outcome extends OperationalOutcome> =
  Outcome extends LoggedOperationalOutcome
    ? [context: OperationalLogContext<Outcome>]
    : [];

export function respondWithOperationalOutcome<
  Outcome extends OperationalOutcome,
>(
  c: Context<ServiceEnv>,
  outcome: Outcome,
  ...contextArguments: OperationalContextArguments<Outcome>
): Response {
  const contract = operationalOutcomes[outcome];
  if ("log" in contract) {
    const context = contextArguments[0] as never;
    logServiceEvent(contract.log.level, contract.log.event, {
      ...contract.log.selectContext(context),
      requestId: c.get("requestId"),
      errorId: contract.errorId,
      status: contract.status,
    });
  }
  return createOperationalResponse(
    c,
    contract.status,
    contract.message,
    contract.errorId,
  );
}

/**
 * Map an already-classified workflow outcome without emitting a second
 * provider-failure event. The workflow owns diagnostics for failures that it
 * has observed; the route only owns the stable HTTP envelope.
 */
export function respondWithOperationalOutcomeWithoutLog(
  c: Context<ServiceEnv>,
  outcome: "captions-failed" | "metadata-failed",
): Response {
  const contract = operationalOutcomes[outcome];
  return createOperationalResponse(
    c,
    contract.status,
    contract.message,
    contract.errorId,
  );
}

/**
 * Return the stable, bounded error envelope shared by every data endpoint.
 * Provider details belong in structured server logs, never in this body.
 */
function createOperationalResponse(
  c: Context<ServiceEnv>,
  status: number,
  error: string,
  errorId: string
): Response {
  const requestId = c.get("requestId");
  return new Response(
    JSON.stringify({
      error,
      errorId,
      requestId,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Error-ID": errorId,
        "X-Request-ID": requestId,
      },
    }
  );
}
