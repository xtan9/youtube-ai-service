import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { health } from "../health.js";
import {
  createMetadataRoute,
  type MetadataRouteDependencies,
} from "../metadata.js";
import { createYtdlpMetadataFetcher } from "../../lib/ytdlp-metadata.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";

const CURRENT_KEY = "current-key";
const PREVIOUS_KEY = "previous-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const REQUEST_ID = "req-148-example";
const metadataConfig = createTestRuntimeConfig({ apiKeys: [CURRENT_KEY] });
const metadataDependencies: MetadataRouteDependencies = {
  fetchMetadata: createYtdlpMetadataFetcher(metadataConfig.mediaAcquisition),
};
const metadata = createMetadataRoute(
  metadataConfig,
  createResourceAdmission(metadataConfig.admission),
  metadataDependencies,
);

const mockedExecFile = vi.mocked(execFile);

function metadataRequest(
  headers: Record<string, string> = {},
  body: unknown = { youtube_url: VIDEO_URL }
) {
  return metadata.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CURRENT_KEY}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("transcription HTTP operational contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads do not narrow cleanly in mocks
      (_command, _args, _options, callback) => {
        callback?.(
          null,
          JSON.stringify({
            id: "dQw4w9WgXcQ",
            title: "Example",
            description: "A description",
            language: "en",
            duration: 42,
          }),
          ""
        );
      }
    );
  });

  it("keeps health unauthenticated and returns only minimal status", async () => {
    const response = await health.request("/health", {
      headers: { "X-Request-ID": REQUEST_ID },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("X-Request-ID")).toBe(REQUEST_ID);
  });

  it("replaces malformed request IDs with a bounded generated ID", async () => {
    const response = await health.request("/health", {
      headers: { "X-Request-ID": "contains spaces and secrets" },
    });

    const requestId = response.headers.get("X-Request-ID");
    expect(requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);
    expect(requestId).not.toBe("contains spaces and secrets");
  });

  it.each([undefined, "Basic credentials", "Bearer", "Bearer ", "Bearer key extra"])(
    "returns a generic 401 for malformed authentication: %s",
    async (authorization) => {
      const headers: Record<string, string> = {};
      headers.Authorization = authorization ?? "";

      const response = await metadataRequest(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: "Unauthorized",
        errorId: "AUTH_INVALID_FORMAT",
      });
    expect(response.headers.get("X-Request-ID")).toBeTruthy();
    expect(response.headers.get("X-Error-ID")).toBe("AUTH_INVALID_FORMAT");
    expect(response.headers.get("X-Request-ID")).not.toContain(CURRENT_KEY);
    }
  );

  it("accepts the previous key during the documented rotation overlap", async () => {
    const rotatingConfig = createTestRuntimeConfig({
      apiKeys: [CURRENT_KEY, PREVIOUS_KEY],
    });
    const rotatingMetadata = createMetadataRoute(
      rotatingConfig,
      createResourceAdmission(rotatingConfig.admission),
      metadataDependencies,
    );
    vi.spyOn(metadataDependencies, "fetchMetadata").mockResolvedValue({
      title: "Example",
      description: "A description",
      language: "en",
      duration: 42,
      subtitles: {},
      automatic_captions: {},
    });

    const response = await rotatingMetadata.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PREVIOUS_KEY}`,
        "X-Request-ID": REQUEST_ID,
      },
      body: JSON.stringify({ youtube_url: VIDEO_URL }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe(REQUEST_ID);
  });

  it("returns bounded generic errors with stable IDs and the request ID", async () => {
    const response = await metadataRequest(
      { "X-Request-ID": REQUEST_ID },
      "{not valid json"
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: "Invalid JSON body",
      errorId: "INVALID_JSON",
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(body)).not.toContain("not valid json");
    expect(response.headers.get("X-Request-ID")).toBe(REQUEST_ID);
    expect(response.headers.get("X-Error-ID")).toBe("INVALID_JSON");
  });

  it("does not log full YouTube URLs or content when a provider fails", async () => {
    const errorMessage =
      `provider failed for ${VIDEO_URL}?token=secret Transcript: private text`;
    vi.spyOn(metadataDependencies, "fetchMetadata").mockRejectedValue(
      new Error(errorMessage)
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await metadataRequest({ "X-Request-ID": REQUEST_ID });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
      requestId: REQUEST_ID,
    });
    const logText = JSON.stringify(errorSpy.mock.calls);
    expect(logText).not.toContain(VIDEO_URL);
    expect(logText).not.toContain("private text");
    expect(logText).not.toContain(CURRENT_KEY);
    expect(logText).toContain(REQUEST_ID);
  });
});
