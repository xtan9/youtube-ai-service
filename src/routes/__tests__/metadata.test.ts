import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked at module scope so the end-to-end test below exercises the
// real `fetchYtdlpMetadata` → `normalizeYtdlpJson` path. A vi.spyOn on
// the imported namespace would bypass the normalizer and let the route
// emit whatever the mock returns — defeating the regression-detection
// purpose of the e2e check.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import {
  createMetadataRoute,
  type MetadataRouteDependencies,
} from "../metadata.js";
import { createYtdlpMetadataFetcher } from "../../lib/ytdlp-metadata.js";
import { createResourceAdmission } from "../../lib/resource-limits.js";
import { createTestRuntimeConfig } from "../../test-support/runtime-config.js";

const mockedExecFile = vi.mocked(execFile);
const mockExecStdout = (stdout: string) => {
  mockedExecFile.mockImplementation(
    // @ts-expect-error execFile overloads don't narrow cleanly in mock
    (_cmd, _args, _opts, cb) => {
      cb?.(null, stdout, "");
    }
  );
};

const VALID_KEY = "test-key";
const metadataConfig = createTestRuntimeConfig({ apiKeys: [VALID_KEY] });
const metadataDependencies: MetadataRouteDependencies = {
  fetchMetadata: createYtdlpMetadataFetcher(metadataConfig.mediaAcquisition),
};
const metadata = createMetadataRoute(
  metadataConfig,
  createResourceAdmission(metadataConfig.admission),
  metadataDependencies,
);

function post(body: unknown) {
  return metadata.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /metadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-YouTube URLs with 400", async () => {
    const res = await post({ youtube_url: "https://example.com/video" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with language, title, description, duration, availableCaptions on happy path", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(metadataDependencies, "fetchMetadata").mockResolvedValue({
      title: "Comment apprendre",
      description: "Une vidéo en français",
      language: "fr",
      duration: 893,
      subtitles: {},
      automatic_captions: { fr: [{ url: "x", ext: "vtt" }], en: [{ url: "x", ext: "vtt" }] },
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.language).toBe("fr");
    expect(body.title).toBe("Comment apprendre");
    expect(body.description).toBe("Une vidéo en français");
    expect(body.duration).toBe(893);
    expect(body.availableCaptions).toEqual(expect.arrayContaining(["fr", "en"]));
    // The fallback warn must NOT fire on the happy path — a refactor
    // that always logs (e.g. moves the warn outside the null branch)
    // would silently flood ops dashboards with false-positive miss
    // signals and make the dashboards useless for real regressions.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("LANGUAGE_DETECT_FALLBACK"),
      expect.anything()
    );
  });

  it("passes the request work signal to metadata acquisition", async () => {
    const fetchMetadata = vi
      .spyOn(metadataDependencies, "fetchMetadata")
      .mockResolvedValue({
        title: "Example",
        description: "",
        language: "en",
        duration: 1,
        subtitles: {},
        automatic_captions: {},
      });

    const response = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(response.status).toBe(200);
    expect(fetchMetadata).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      expect.any(AbortSignal),
    );
  });

  it("forwards duration=null (live streams) without coercing to 0", async () => {
    // `null` must be forwarded verbatim — coercing to 0 here would break
    // any "video too long?" gate by silently passing it. Live streams
    // emit duration=null; same shape applies to schema gaps.
    vi.spyOn(metadataDependencies, "fetchMetadata").mockResolvedValue({
      title: "Live",
      description: "",
      language: "en",
      duration: null,
      subtitles: {},
      automatic_captions: {},
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duration).toBeNull();
  });

  it("maps detectLanguage null → 'en' with structured LANGUAGE_DETECT_FALLBACK warn", async () => {
    // Wire-contract back-compat: the frontend's VPS metadata schema
    // rejects `language: null`, so the route must emit a string. The
    // fallback log lets ops track miss rate without breaking
    // deserialization. Capture the structured warn so a future
    // refactor that drops the log fails this test instead of silently
    // hiding a rising fallback rate.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(metadataDependencies, "fetchMetadata").mockResolvedValue({
      title: "", // no title and no description = no detection signal at all
      description: "",
      language: null,
      duration: null,
      subtitles: {},
      automatic_captions: {},
    });
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.language).toBe("en");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("LANGUAGE_DETECT_FALLBACK"),
      expect.objectContaining({
        errorId: "LANGUAGE_DETECT_FALLBACK",
        hasLanguageField: false,
        subtitleKeyCount: 0,
      })
    );
  });

  it("returns 500 with a generic message when yt-dlp throws", async () => {
    // Internal stderr (paths, binary names, extractor internals) must not
    // leak to the client — same contract as /captions and /transcribe.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(metadataDependencies, "fetchMetadata").mockRejectedValue(
      new Error("yt-dlp metadata failed: /opt/tmp/internal/path/leaked")
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "Metadata fetch failed",
      errorId: "METADATA_FAILED",
      requestId: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("/opt/tmp");
  });
});

describe("POST /metadata — normalizer is on the route's code path", () => {
  // These tests deliberately do NOT spy on `fetchYtdlpMetadata` — they
  // mock the underlying `execFile` so a refactor that bypasses the
  // normalizer (e.g. the route adds its own `Number(obj.duration)`
  // parsing) breaks here. Without this, the unit-level normalizer
  // tests and the route-level happy-path tests pass independently
  // even when nothing connects them.
  beforeEach(() => {
    // restoreAllMocks (not just clearAllMocks) — the previous describe
    // block leaves a `vi.spyOn(metadataDependencies, "fetchMetadata")`
    // in place that would shadow the real call path these tests are
    // designed to exercise.
    vi.restoreAllMocks();
  });

  it("collapses negative duration to null on the wire", async () => {
    mockExecStdout(
      JSON.stringify({ id: "abc", title: "t", duration: -1 })
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duration).toBeNull();
  });

  it("collapses string duration to null on the wire", async () => {
    // Defends specifically against future `Number(obj.duration)` creep —
    // a numeric string from a yt-dlp schema regression must not be
    // accepted as a length signal.
    mockExecStdout(
      JSON.stringify({ id: "abc", title: "t", duration: "213" })
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duration).toBeNull();
  });

  it("forwards a valid finite non-negative duration unchanged", async () => {
    mockExecStdout(
      JSON.stringify({ id: "abc", title: "t", duration: 213 })
    );
    const res = await post({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duration).toBe(213);
  });
});

describe("POST /metadata — auth enforcement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await metadata.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 on a wrong bearer token", async () => {
    const res = await metadata.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(403);
  });
});
