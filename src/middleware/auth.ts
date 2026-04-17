import type { MiddlewareHandler } from "hono";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const apiKey = process.env.VPS_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Server misconfigured: VPS_API_KEY not set" }, 500);
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== apiKey) {
    return c.json({ error: "Invalid API key" }, 403);
  }

  await next();
};
