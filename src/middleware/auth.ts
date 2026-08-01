import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { jsonError } from "../lib/http-errors.js";
import { fingerprintApiKey } from "../lib/resource-limits.js";
import type { ServiceEnv } from "../lib/request-id.js";

function configuredApiKeys(): string[] {
  const currentKey = process.env.VPS_API_KEY?.trim();
  if (!currentKey) return [];
  return [currentKey, process.env.VPS_API_KEY_PREVIOUS]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));
}

function matchesKey(candidate: string, configured: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const configuredBytes = Buffer.from(configured);
  return (
    candidateBytes.length === configuredBytes.length &&
    timingSafeEqual(candidateBytes, configuredBytes)
  );
}

export const authMiddleware: MiddlewareHandler<ServiceEnv> = async (c, next) => {
  const apiKeys = configuredApiKeys();
  if (apiKeys.length === 0) {
    return jsonError(c, 500, "Service unavailable", "SERVICE_MISCONFIGURED");
  }

  const authHeader = c.req.header("Authorization");
  const match = authHeader?.match(/^Bearer ([^\s]+)$/);
  if (!match) {
    return jsonError(c, 401, "Unauthorized", "AUTH_INVALID_FORMAT");
  }

  const token = match[1];
  if (!apiKeys.some((apiKey) => matchesKey(token, apiKey))) {
    return jsonError(c, 403, "Forbidden", "AUTH_INVALID_KEY");
  }

  c.set("apiKeyFingerprint", fingerprintApiKey(token));
  await next();
};
