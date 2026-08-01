import type { Context } from "hono";
import type { ServiceEnv } from "./request-id.js";

/**
 * Return the stable, bounded error envelope shared by every data endpoint.
 * Provider details belong in structured server logs, never in this body.
 */
export function jsonError(
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
