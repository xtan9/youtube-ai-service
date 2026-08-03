import { Hono, type Context } from "hono";
import { type z, type ZodType } from "zod";
import { respondWithOperationalOutcome } from "../lib/http-errors.js";
import {
  type ResourceAdmission,
  type ResourceLimitEndpoint,
} from "../lib/resource-limits.js";
import { requestIdMiddleware, type ServiceEnv } from "../lib/request-id.js";
import type { RuntimeConfig } from "../lib/runtime-config.js";
import { createAuthMiddleware } from "../middleware/auth.js";

export type DataRouteConfig = Pick<RuntimeConfig, "auth">;

export type DataRequestResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly response: Response };

type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too_large" | "invalid_json" };

async function readBoundedJson(
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BoundedJsonResult> {
  signal.throwIfAborted();
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
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelRead, { once: true });
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
    signal.throwIfAborted();
    return { ok: false, reason: "invalid_json" };
  } finally {
    signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }

  signal.throwIfAborted();

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

export async function readDataRequest<Schema extends ZodType>(
  c: Context<ServiceEnv>,
  schema: Schema,
): Promise<DataRequestResult<z.output<Schema>>> {
  const bodyResult = await readBoundedJson(
    c.req.raw,
    c.get("resourceLimits").requestBodyMaxBytes,
    c.get("workSignal"),
  );
  if (!bodyResult.ok && bodyResult.reason === "too_large") {
    return {
      ok: false,
      response: respondWithOperationalOutcome(c, "request-body-too-large"),
    };
  }
  if (!bodyResult.ok) {
    return {
      ok: false,
      response: respondWithOperationalOutcome(c, "invalid-json"),
    };
  }

  const parsed = schema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: respondWithOperationalOutcome(c, "invalid-request"),
    };
  }

  return { ok: true, data: parsed.data };
}

export function createDataRoute(
  endpoint: ResourceLimitEndpoint,
  config: DataRouteConfig,
  admission: ResourceAdmission,
): Hono<ServiceEnv> {
  const route = new Hono<ServiceEnv>();
  route.use("*", requestIdMiddleware);
  route.use("*", createAuthMiddleware(config.auth));
  route.use("*", admission.middleware(endpoint));
  return route;
}
