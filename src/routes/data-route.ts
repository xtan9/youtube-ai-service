import { Hono } from "hono";
import {
  resourceLimitMiddleware,
  type ResourceLimitEndpoint,
} from "../lib/resource-limits.js";
import { requestIdMiddleware, type ServiceEnv } from "../lib/request-id.js";
import type { RuntimeConfig } from "../lib/runtime-config.js";
import { createAuthMiddleware } from "../middleware/auth.js";

export type DataRouteConfig = Pick<RuntimeConfig, "auth" | "admission">;

export function createDataRoute(
  endpoint: ResourceLimitEndpoint,
  config: DataRouteConfig,
): Hono<ServiceEnv> {
  const route = new Hono<ServiceEnv>();
  route.use("*", requestIdMiddleware);
  route.use("*", createAuthMiddleware(config.auth));
  route.use("*", resourceLimitMiddleware(endpoint, config.admission));
  return route;
}
