import { describe, expect, it, vi } from "vitest";
import {
  createVideoInformationWorkflow,
  type VideoInformationWorkflowDependencies,
} from "../video-information-workflow.js";
import {
  detectLanguage,
  extractAvailableCaptions,
} from "../language-detect.js";
import {
  YtdlpAcquisitionError,
  type YtdlpMetadata,
} from "../ytdlp-metadata.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const CORRELATION = {
  requestId: "workflow-request-id",
  videoId: "dQw4w9WgXcQ",
};

const baseMetadata: YtdlpMetadata = {
  title: "",
  description: "",
  language: null,
  duration: null,
  subtitles: {},
  automatic_captions: {},
};

function createDependencies(
  metadata: YtdlpMetadata,
  overrides: Partial<VideoInformationWorkflowDependencies> = {},
): VideoInformationWorkflowDependencies {
  return {
    fetchMetadata: vi.fn().mockResolvedValue(metadata),
    detectLanguage,
    extractAvailableCaptions,
    logEvent: vi.fn(),
    ...overrides,
  };
}

describe("video information workflow", () => {
  it("returns curated video information with the existing language priority", async () => {
    const dependencies = createDependencies({
      ...baseMetadata,
      title: "English title",
      description: "English description",
      language: "fr-FR",
      duration: 893,
      subtitles: {
        fr: [{ url: "manual-fr", ext: "vtt" }],
      },
      automatic_captions: {
        "en-US": [{ url: "automatic-en", ext: "vtt" }],
      },
    });
    const workflow = createVideoInformationWorkflow(dependencies);

    const result = await workflow({
      youtubeUrl: VIDEO_URL,
      signal: new AbortController().signal,
      correlation: CORRELATION,
    });

    expect(result).toEqual({
      ok: true,
      videoInformation: {
        title: "English title",
        description: "English description",
        durationSeconds: 893,
        languageHint: "fr",
        availableCaptionLanguages: expect.arrayContaining(["fr", "en"]),
      },
    });
    expect(result.ok && result.videoInformation.availableCaptionLanguages).toHaveLength(2);
    expect(result.ok && result.videoInformation).not.toHaveProperty("language");
    expect(result.ok && result.videoInformation).not.toHaveProperty("subtitles");
    expect(dependencies.fetchMetadata).toHaveBeenCalledWith(
      VIDEO_URL,
      expect.any(AbortSignal),
    );
  });

  it("guarantees the English language hint when no language evidence exists", async () => {
    const logEvent = vi.fn();
    const dependencies = createDependencies(baseMetadata, { logEvent });
    const workflow = createVideoInformationWorkflow(dependencies);

    const result = await workflow({
      youtubeUrl: VIDEO_URL,
      signal: new AbortController().signal,
      correlation: CORRELATION,
    });

    expect(result).toEqual({
      ok: true,
      videoInformation: {
        title: "",
        description: "",
        durationSeconds: null,
        languageHint: "en",
        availableCaptionLanguages: [],
      },
    });
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "metadata.LANGUAGE_DETECT_FALLBACK",
      expect.objectContaining({
        ...CORRELATION,
        errorId: "LANGUAGE_DETECT_FALLBACK",
        hasLanguageField: false,
        subtitleKeyCount: 0,
        textLength: 0,
      }),
    );
  });

  it("combines and deduplicates normalized Caption Track languages", async () => {
    const dependencies = createDependencies({
      ...baseMetadata,
      subtitles: {
        "fr-FR": [{ url: "manual-fr", ext: "vtt" }],
        en: [{ url: "manual-en", ext: "vtt" }],
      },
      automatic_captions: {
        fr: [{ url: "automatic-fr", ext: "vtt" }],
        "zh-Hans": [{ url: "automatic-zh", ext: "vtt" }],
      },
    });
    const workflow = createVideoInformationWorkflow(dependencies);

    const result = await workflow({
      youtubeUrl: VIDEO_URL,
      signal: new AbortController().signal,
      correlation: CORRELATION,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videoInformation.availableCaptionLanguages).toEqual(
        expect.arrayContaining(["fr", "en", "zh"]),
      );
      expect(
        new Set(result.videoInformation.availableCaptionLanguages).size,
      ).toBe(3);
    }
  });

  it("classifies expected acquisition failures without exposing provider details", async () => {
    const logEvent = vi.fn();
    const acquisitionFailure = new YtdlpAcquisitionError({
      cause: new Error("provider stderr must remain private"),
    });
    const dependencies = createDependencies(baseMetadata, {
      fetchMetadata: vi.fn().mockRejectedValue(acquisitionFailure),
      logEvent,
    });
    const workflow = createVideoInformationWorkflow(dependencies);

    const result = await workflow({
      youtubeUrl: VIDEO_URL,
      signal: new AbortController().signal,
      correlation: CORRELATION,
    });

    expect(result).toEqual({ ok: false, reason: "temporarily-unavailable" });
    expect(JSON.stringify(result)).not.toContain("provider stderr");
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      "metadata.failed",
      expect.objectContaining({
        ...CORRELATION,
        errorId: "METADATA_FAILED",
        errorName: "YtdlpAcquisitionError",
        stage: "acquisition",
      }),
    );
  });

  it("propagates cancellation and leaves unexpected defects visible", async () => {
    const cancellation = new DOMException("request stopped", "AbortError");
    const controller = new AbortController();
    controller.abort(cancellation);
    const fetchMetadata = vi.fn();
    const dependencies = createDependencies(baseMetadata, { fetchMetadata });
    const workflow = createVideoInformationWorkflow(dependencies);

    await expect(
      workflow({
        youtubeUrl: VIDEO_URL,
        signal: controller.signal,
        correlation: CORRELATION,
      }),
    ).rejects.toBe(cancellation);
    expect(fetchMetadata).not.toHaveBeenCalled();

    const defect = new Error("workflow defect");
    const defectLogEvent = vi.fn();
    const defectiveWorkflow = createVideoInformationWorkflow(
      createDependencies(baseMetadata, {
        fetchMetadata: vi.fn().mockRejectedValue(defect),
        logEvent: defectLogEvent,
      }),
    );

    await expect(
      defectiveWorkflow({
        youtubeUrl: VIDEO_URL,
        signal: new AbortController().signal,
        correlation: CORRELATION,
      }),
    ).rejects.toBe(defect);
    expect(defectLogEvent).toHaveBeenCalledWith(
      "error",
      "metadata.WORKFLOW_UNHANDLED",
      expect.objectContaining({
        ...CORRELATION,
        errorId: "METADATA_WORKFLOW_UNHANDLED",
        errorName: "Error",
      }),
    );
  });
});
