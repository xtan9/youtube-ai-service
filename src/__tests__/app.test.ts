import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadRuntimeConfig } from "../lib/runtime-config.js";

describe("createApp", () => {
  it("authenticates requests from the explicit runtime snapshot", async () => {
    const app = createApp(
      loadRuntimeConfig({
        VPS_API_KEY: "snapshot-key",
      })
    );

    const rejected = await app.request("/metadata", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ambient-key",
      },
      body: JSON.stringify({}),
    });
    const accepted = await app.request("/metadata", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer snapshot-key",
      },
      body: JSON.stringify({}),
    });

    expect(rejected.status).toBe(403);
    expect(accepted.status).toBe(400);
  });

  it("shares one authenticated-key rate budget across data endpoints", async () => {
    const app = createApp(
      loadRuntimeConfig({
        VPS_API_KEY: "shared-budget-key",
        RATE_LIMIT_MAX_REQUESTS: "1",
      }),
    );
    const request = (path: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer shared-budget-key",
        },
        body: JSON.stringify({}),
      });

    expect((await request("/captions")).status).toBe(400);
    const response = await request("/metadata");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorId: "RATE_LIMITED" });
  });
});
