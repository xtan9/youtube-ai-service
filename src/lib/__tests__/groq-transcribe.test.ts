import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "fs/promises";
import {
  transcribeViaGroq,
  GroqTranscribeError,
} from "../groq-transcribe.js";

// Mock fs to avoid real disk reads; Groq receives whatever bytes we hand it.
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const validGroqBody = {
  language: "en",
  segments: [
    { start: 0, end: 1.5, text: " hello" },
    { start: 1.5, end: 3.0, text: "world " },
  ],
};

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("transcribeViaGroq", () => {
  beforeEach(() => {
    vi.stubEnv("GROQ_API_KEY", "test-key");
    mockedReadFile.mockResolvedValue(Buffer.from("fake-audio-bytes"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the audio file and parses Groq's verbose_json into our segment shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(validGroqBody)));

    const result = await transcribeViaGroq("/tmp/clip.mp3");

    expect(result.segments).toEqual([
      { text: "hello", start: 0, duration: 1.5 },
      { text: "world", start: 1.5, duration: 1.5 },
    ]);
    expect(result.language).toBe("en");
  });

  it("forwards lang as the `language` form field when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3", "fr");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("language")).toBe("fr");
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
    expect(formData.get("response_format")).toBe("verbose_json");
  });

  it("omits `language` from the form when no lang arg is provided", async () => {
    // Sending `language: undefined` would be rejected by Groq's strict
    // multipart parser (some shapes return 400, some silently ignore).
    // Omitting the field entirely lets Groq's auto-detect run.
    const fetchMock = vi.fn().mockResolvedValue(okResponse(validGroqBody));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeViaGroq("/tmp/clip.mp3");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("language")).toBeNull();
  });
});
