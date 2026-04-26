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
});
