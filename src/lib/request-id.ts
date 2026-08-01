import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ResourceLimitConfig } from "./resource-limits.js";

export const REQUEST_ID_HEADER = "X-Request-ID";

// Keep caller-supplied IDs opaque and bounded. IDs with whitespace, control
// characters, or encoded content are replaced rather than echoed into logs
// and response bodies. UUIDs generated here are the normal production shape.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

export type ServiceEnv = {
  Variables: {
    requestId: string;
    apiKeyFingerprint: string;
    resourceLimits: ResourceLimitConfig;
  };
};

export function resolveRequestId(candidate: string | undefined): string {
  return candidate && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

export const requestIdMiddleware: MiddlewareHandler<ServiceEnv> = async (
  c,
  next
) => {
  const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  c.set("requestId", requestId);
  c.header(REQUEST_ID_HEADER, requestId);
  await next();
  // Re-apply after downstream handlers so returned responses retain the
  // header even when a handler creates its own Response instance.
  c.header(REQUEST_ID_HEADER, requestId);
};
