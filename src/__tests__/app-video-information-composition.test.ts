import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { createApp, type AppAdapters } from "../app.js";
import { createTestRuntimeConfig } from "../test-support/runtime-config.js";
import { languageTag } from "../test-support/language-metadata.js";
import type { VideoInformationWorkflow } from "../lib/video-information-workflow.js";

const mockedExecFile = vi.mocked(execFile);
const VALID_KEY = "composition-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function metadataRequest(app: ReturnType<typeof createApp>) {
  return app.request("/metadata", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VALID_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ youtube_url: VIDEO_URL }),
  });
}

describe("production Video Information composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the real yt-dlp parsing and normalizer before returning Video Information", async () => {
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads do not narrow cleanly in mocks
      (_command, args, _options, callback) => {
        expect(args).toContain("--dump-json");
        callback?.(
          null,
          JSON.stringify({
            id: "dQw4w9WgXcQ",
            title: "Comment apprendre",
            description: "x".repeat(2_500),
            language: "fr-FR",
            duration: "213",
            subtitles: {
              "fr-FR": [{ url: "manual-fr", ext: "vtt" }],
            },
            automatic_captions: {
              fr: [{ url: "automatic-fr", ext: "vtt" }],
              "en-US": [{ url: "automatic-en", ext: "vtt" }],
            },
          }),
          "",
        );
      },
    );

    const app = createApp(createTestRuntimeConfig({ apiKeys: [VALID_KEY] }));
    const response = await metadataRequest(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      language: "fr",
      title: "Comment apprendre",
      description: "x".repeat(2_000),
      duration: null,
      availableCaptions: ["fr", "en"],
    });
    expect(mockedExecFile).toHaveBeenCalledOnce();
  });

  it("routes metadata through the injected workflow without exposing a raw fetch seam", async () => {
    const videoInformationWorkflow = vi
      .fn<VideoInformationWorkflow>()
      .mockResolvedValue({
        ok: true,
        videoInformation: {
          title: "Workflow-owned title",
          description: "Workflow-owned description",
          durationSeconds: null,
          languageHint: languageTag("en"),
          availableCaptionLanguages: [languageTag("en").primaryLanguageCode],
        },
      });
    const adapters = {
      fetchCaptions: vi.fn(),
      videoInformationWorkflow,
      transcriptionWorkflow: vi.fn(),
    } satisfies AppAdapters;

    const app = createApp(
      createTestRuntimeConfig({ apiKeys: [VALID_KEY] }),
      adapters,
    );
    const response = await metadataRequest(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      language: "en",
      title: "Workflow-owned title",
      description: "Workflow-owned description",
      duration: null,
      availableCaptions: ["en"],
    });
    expect(videoInformationWorkflow).toHaveBeenCalledOnce();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("emits one safe acquisition failure diagnostic for the mapped unavailable outcome", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedExecFile.mockImplementation(
      // @ts-expect-error execFile overloads do not narrow cleanly in mocks
      (_command, _args, _options, callback) => {
        callback?.(
          new Error("provider stderr and command output must remain private"),
          "",
          "provider details must remain private",
        );
      },
    );

    try {
      const app = createApp(createTestRuntimeConfig({ apiKeys: [VALID_KEY] }));
      const response = await metadataRequest(app);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: "Metadata fetch failed",
        errorId: "METADATA_FAILED",
      });

      const failureLogs = errorSpy.mock.calls.filter(
        ([event]) => event === "[metadata.failed]",
      );
      expect(failureLogs).toHaveLength(1);
      expect(failureLogs[0]?.[1]).toEqual(
        expect.objectContaining({
          errorId: "METADATA_FAILED",
          requestId: expect.any(String),
          videoId: "dQw4w9WgXcQ",
          errorName: "YtdlpAcquisitionError",
          stage: "acquisition",
        }),
      );
      const logText = JSON.stringify(failureLogs);
      expect(logText).not.toContain("provider stderr");
      expect(logText).not.toContain("provider details");
      expect(logText).not.toContain("command output");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
