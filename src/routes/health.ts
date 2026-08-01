import { Hono } from "hono";
import { requestIdMiddleware, type ServiceEnv } from "../lib/request-id.js";

const health = new Hono<ServiceEnv>();

health.use("*", requestIdMiddleware);

health.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export { health };
