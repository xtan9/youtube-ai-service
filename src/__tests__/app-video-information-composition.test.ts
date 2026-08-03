import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { createApp } from "../app.js";
import { createTestRuntimeConfig } from "../test-support/runtime-config.js";

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
});
