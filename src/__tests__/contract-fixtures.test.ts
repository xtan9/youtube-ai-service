import { beforeEach, describe, expect, it, vi } from "vitest";
import fixturesJson from "../../test-fixtures/transcription-contract/v1/cases.json";
import { createApp } from "../app.js";
import type { CaptionsRouteDependencies } from "../routes/captions.js";
import type { CaptionTrackAcquisition } from "../lib/captions.js";
import type { TimedTextSegment } from "../lib/timed-text.js";
import {
  detectLanguage,
  extractAvailableCaptions,
} from "../lib/language-detect.js";
import { normalizeYtdlpMetadata } from "../lib/ytdlp-metadata.js";
import type { TranscriptionWorkflow } from "../lib/transcription-workflow.js";
import type { VideoInformationWorkflow } from "../lib/video-information-workflow.js";
import { createTestRuntimeConfig } from "../test-support/runtime-config.js";
import { languageTag } from "../test-support/language-metadata.js";

type WireResponse = {
  status: number;
  body?: unknown;
  raw?: string;
};

type FixtureCase = {
  id: string;
  endpoint: string;
  request: {
    youtube_url?: string;
    lang?: string;
    raw?: string;
    langValues?: string[];
  };
  service?: {
    arrange?: { kind: string; value?: unknown };
    response: WireResponse;
  };
  frontend?: {
    response: WireResponse;
    legacyResponse?: WireResponse;
  };
};

type FixtureWithService = FixtureCase & {
  service: NonNullable<FixtureCase["service"]>;
};

type ContractFixtures = {
  contractVersion: string;
  owners: { producer: string; consumer: string };
  youtubeUrl: string;
  compatibilityWindow: {
    current: string;
    previous: string;
    policy: string;
    retirement: string;
  };
  cases: FixtureCase[];
};

const fixtures = fixturesJson as unknown as ContractFixtures;
const VALID_KEY = "fixture-key";
const testConfig = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });
const captionsDependencies: CaptionsRouteDependencies = {
  captionTrackAcquisition: vi.fn<CaptionTrackAcquisition>(),
};
const videoInformationWorkflow = vi.fn<VideoInformationWorkflow>();
const workflow = vi.fn<TranscriptionWorkflow>();
const app = createApp(testConfig, {
  captionTrackAcquisition: captionsDependencies.captionTrackAcquisition,
  videoInformationWorkflow,
  transcriptionWorkflow: workflow,
});

function getCase(id: string): FixtureWithService {
  const fixture = fixtures.cases.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing contract fixture: ${id}`);
  if (!fixture.service) throw new Error(`Fixture has no service arrangement: ${id}`);
  return fixture as FixtureWithService;
}

async function post(path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      "X-Request-ID": "fixture-request-id",
    },
    body: JSON.stringify(body),
  });
}

async function postRaw(path: string, body: string): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
      "X-Request-ID": "fixture-request-id",
    },
    body,
  });
}

async function expectWireResponse(
  response: Response,
  expected: WireResponse
): Promise<void> {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("X-Request-ID")).toBe("fixture-request-id");
  if (
    expected.body &&
    typeof expected.body === "object" &&
    "errorId" in expected.body &&
    typeof expected.body.errorId === "string"
  ) {
    expect(response.headers.get("X-Error-ID")).toBe(expected.body.errorId);
  }
  if (expected.raw !== undefined) {
    expect(await response.text()).toBe(expected.raw);
  } else {
    expect(await response.json()).toEqual(expected.body);
  }
}

describe("transcription-http/v1 fixture manifest", () => {
  it("declares the reviewed owner and compatibility window", () => {
    expect(fixtures.contractVersion).toBe("transcription-http/v1");
    expect(fixtures.owners).toEqual({
      producer: "xtan9/youtube-ai-service",
      consumer: "xtan9/youtubeai_chat_frontend",
    });
    expect(fixtures.compatibilityWindow.current).toBe("canonical-segments");
    expect(fixtures.compatibilityWindow.previous).toBe("transcript-only");
    expect(fixtures.compatibilityWindow.policy).toContain("Additive");
  });

  it("contains every required contract case", () => {
    const ids = new Set(fixtures.cases.map((fixture) => fixture.id));
    expect(ids).toEqual(
      new Set([
        "caption-success",
        "caption-404",
        "caption-video-unavailable",
        "caption-500",
        "transcription-success",
        "transcription-canonical-full-language-tag",
        "transcription-503",
        "metadata-known-duration",
        "metadata-unknown-duration",
        "multilingual-language-tags",
        "legacy-transcript-only",
        "empty-segments",
        "malformed-json",
        "invalid-language-sentinels",
      ])
    );
  });

  it("keeps the canonical and legacy wire variants together", () => {
    const fixture = getCase("legacy-transcript-only");
    expect(fixture.frontend?.response).toEqual(fixture.service.response);
    expect(fixture.frontend?.legacyResponse).toEqual({
      status: 200,
      body: {
        transcript: "Legacy compatibility fixture.",
        language: "auto",
        source: "whisper",
      },
    });
  });
});

describe("service routes against transcription-http/v1 fixtures", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(captionsDependencies.captionTrackAcquisition).mockReset();
    videoInformationWorkflow.mockReset();
    workflow.mockReset().mockResolvedValue({ ok: true, segments: [] });
  });

  it.each([
    "metadata-known-duration",
    "metadata-unknown-duration",
    "multilingual-language-tags",
  ])("serves the %s metadata fixture at the HTTP boundary", async (id) => {
    const fixture = getCase(id);
    const value = normalizeYtdlpMetadata(fixture.service?.arrange?.value);
    videoInformationWorkflow.mockResolvedValue({
      ok: true,
      videoInformation: {
        title: value.title,
        description: value.description,
        durationSeconds: value.duration,
        languageHint: detectLanguage(value) ?? languageTag("en"),
        availableCaptionLanguages: extractAvailableCaptions(value),
      },
    });

    const response = await post(
      "/metadata",
      { youtube_url: fixture.request.youtube_url ?? fixtures.youtubeUrl }
    );
    await expectWireResponse(response, fixture.service.response);
  });

  it.each([
    "caption-success",
    "caption-404",
    "caption-video-unavailable",
    "caption-500",
  ])(
    "serves the %s caption fixture at the HTTP boundary",
    async (id) => {
      const fixture = getCase(id);
      const arrangement = fixture.service?.arrange;
      if (arrangement?.kind === "captions") {
        const value = arrangement.value as {
          segments: readonly TimedTextSegment[];
          source: "auto_captions";
          language: "en" | "zh";
          title: string | null;
          channelName: string | null;
        };
        vi.mocked(captionsDependencies.captionTrackAcquisition).mockResolvedValue({
          kind: "acquired",
          segments: value.segments,
          source: value.source,
          promptLocale: value.language,
          title: value.title,
          channelName: value.channelName,
        });
      } else if (arrangement?.kind === "captions-null") {
        vi.mocked(captionsDependencies.captionTrackAcquisition).mockResolvedValue({
          kind: "absent",
          reason: "missing",
        });
      } else if (arrangement?.kind === "captions-video-unavailable") {
        vi.mocked(captionsDependencies.captionTrackAcquisition).mockResolvedValue({
          kind: "video-unavailable",
          reason: "provider-video-unavailable",
        });
      } else {
        vi.mocked(captionsDependencies.captionTrackAcquisition).mockRejectedValue(
          new Error("fixture provider failure")
        );
      }

      const response = await post(
        "/captions",
        fixture.request.youtube_url
          ? {
              youtube_url: fixture.request.youtube_url,
              ...(fixture.request.lang ? { lang: fixture.request.lang } : {}),
            }
          : fixture.request
      );
      await expectWireResponse(response, fixture.service.response);
    }
  );

  it("serves the malformed-json fixture as a 400 client error", async () => {
    const fixture = getCase("malformed-json");
    const response = await postRaw("/captions", fixture.request.raw ?? "");
    await expectWireResponse(response, fixture.service.response);
  });

  it("rejects every invalid language input on both data routes without provider work", async () => {
    const fixture = getCase("invalid-language-sentinels");
    const languageValues = fixture.request.langValues ?? [];

    for (const lang of languageValues) {
      const body = {
        youtube_url: fixtures.youtubeUrl,
        lang,
      };
      await expectWireResponse(
        await post("/captions", body),
        fixture.service.response
      );
      await expectWireResponse(
        await post("/transcribe", body),
        fixture.service.response
      );
    }

    expect(captionsDependencies.captionTrackAcquisition).not.toHaveBeenCalled();
    expect(workflow).not.toHaveBeenCalled();
  });

  it.each([
    "transcription-success",
    "transcription-canonical-full-language-tag",
    "legacy-transcript-only",
    "empty-segments",
  ])("serves the %s transcription fixture at the HTTP boundary", async (id) => {
    const fixture = getCase(id);
    const arrangement = fixture.service?.arrange;
    const segments = (arrangement?.value ?? []) as TimedTextSegment[];
    workflow.mockResolvedValue(
      segments.length > 0
        ? { ok: true, segments }
        : { ok: false, reason: "empty-result" }
    );

    const response = await post(
      "/transcribe",
      fixture.request.youtube_url
        ? {
            youtube_url: fixture.request.youtube_url,
            ...(fixture.request.lang ? { lang: fixture.request.lang } : {}),
          }
        : fixture.request
    );
    await expectWireResponse(response, fixture.service.response);

    const expectedPrimaryLanguage = fixture.request.lang
      ? languageTag(fixture.request.lang).primaryLanguageCode
      : undefined;
    expect(workflow).toHaveBeenCalledWith(
      expect.objectContaining({ language: expectedPrimaryLanguage }),
    );
  });

  it("serves the transcription-503 fixture without falling back to local Whisper", async () => {
    const fixture = getCase("transcription-503");
    workflow.mockResolvedValue({
      ok: false,
      reason: "temporarily-unavailable",
    });

    const response = await post("/transcribe", {
      youtube_url: fixture.request.youtube_url ?? fixtures.youtubeUrl,
    });
    await expectWireResponse(response, fixture.service.response);
  });
});
