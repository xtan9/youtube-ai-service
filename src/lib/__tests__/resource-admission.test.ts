import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createResourceAdmission,
  type ResourceAdmission,
} from "../resource-limits.js";
import type { ServiceEnv } from "../request-id.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { ManualClock } from "../../test-support/manual-clock.js";

function createAdmittedApp(admission: ResourceAdmission): Hono<ServiceEnv> {
  const app = new Hono<ServiceEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "resource-admission-test");
    c.set("apiKeyFingerprint", "authenticated-key");
    await next();
  });
  app.use("*", admission.middleware("captions"));
  app.get("/", (c) => c.text("ok"));
  return app;
}

describe("resource admission", () => {
  it("owns its rate-limit state", async () => {
    const config = createTestRuntimeConfig({
      admission: { rateLimitMaxRequests: 1 },
    }).admission;
    const firstApp = createAdmittedApp(createResourceAdmission(config));
    const secondApp = createAdmittedApp(createResourceAdmission(config));

    expect((await firstApp.request("/")).status).toBe(200);
    expect((await firstApp.request("/")).status).toBe(429);
    expect((await secondApp.request("/")).status).toBe(200);
  });

  it("cancels timed-out work and waits for its cleanup", async () => {
    const clock = new ManualClock();
    const config = createTestRuntimeConfig({
      admission: {
        endpointTimeoutMs: { transcribe: 10 },
        maxConcurrentJobs: 1,
        rateLimitMaxRequests: 100,
      },
    }).admission;
    const admission = createResourceAdmission(config, clock);
    const app = new Hono<ServiceEnv>();
    let workCancelled = false;
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    app.use("*", async (c, next) => {
      c.set("requestId", "resource-admission-timeout");
      c.set("apiKeyFingerprint", "authenticated-key");
      await next();
    });
    app.use("*", admission.middleware("transcribe"));
    app.get("/", async (c) => {
      const signal = c.get("workSignal");
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            workCancelled = true;
            resolve();
          },
          { once: true },
        );
      });
      await cleanup;
      return c.text("cancelled");
    });

    let requestSettled = false;
    const request = Promise.resolve(app.request("/")).then((response) => {
      requestSettled = true;
      return response;
    });
    await Promise.resolve();
    clock.advanceBy(10);
    await Promise.resolve();

    expect({ workCancelled, requestSettled }).toEqual({
      workCancelled: true,
      requestSettled: false,
    });
    expect((await app.request("/")).status).toBe(429);

    finishCleanup();
    const response = await request;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      errorId: "ENDPOINT_TIMEOUT",
    });
  });
});
