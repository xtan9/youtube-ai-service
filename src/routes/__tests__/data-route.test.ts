import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";
import { createDataRoute, readDataRequest } from "../data-route.js";

const VALID_KEY = "data-route-test-key";

function createRoute(requestBodyMaxBytes = 65_536) {
  const config = createTestRuntimeConfig({
    apiKeys: [VALID_KEY],
    admission: { requestBodyMaxBytes },
  });
  const route = createDataRoute(
    "metadata",
    config,
    createResourceAdmission(config.admission),
  );
  const schema = z.object({ name: z.string().min(1) });

  route.post("/", async (c) => {
    const intake = await readDataRequest(c, schema);
    if (!intake.ok) return intake.response;
    return c.json({ greeting: `Hello, ${intake.data.name}` });
  });

  return route;
}

function request(body: BodyInit) {
  return createRoute().request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body,
  });
}

describe("data-route request intake", () => {
  it("returns schema-validated data to endpoint behavior", async () => {
    const response = await request(JSON.stringify({ name: "Ada" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ greeting: "Hello, Ada" });
  });

  it("returns the stable oversized-body outcome", async () => {
    const response = await createRoute(32).request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body: JSON.stringify({ name: "x".repeat(100) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "Request body too large",
      errorId: "REQUEST_BODY_TOO_LARGE",
      requestId: expect.any(String),
    });
  });

  it("returns the stable malformed-JSON outcome", async () => {
    const response = await request("{");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid JSON body",
      errorId: "INVALID_JSON",
      requestId: expect.any(String),
    });
  });

  it("returns the stable schema-rejection outcome", async () => {
    const response = await request(JSON.stringify({ name: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid request",
      errorId: "INVALID_REQUEST",
      requestId: expect.any(String),
    });
  });

  it("propagates cancellation instead of returning invalid JSON", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Client disconnected", "AbortError");
    let streamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        setTimeout(() => {
          if (streamCancelled) return;
          stream.enqueue(new TextEncoder().encode('{"name":"late"}'));
          stream.close();
        }, 10);
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const rawRequest = new Request("http://service.test/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const route = createRoute();
    route.onError((error) => {
      throw error;
    });

    const response = route.fetch(rawRequest);
    await Promise.resolve();
    controller.abort(reason);

    await expect(response).rejects.toBe(reason);
    expect(streamCancelled).toBe(true);
  });
});
