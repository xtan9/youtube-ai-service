import { describe, it, expect } from "vitest";
import {
  extractVideoId,
  isExpectedNoCaptions,
} from "../captions.js";
import {
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
} from "youtube-transcript-plus";

describe("extractVideoId", () => {
  // Spec is "whatever yt-dlp accepts" — keep this aligned with the forms
  // the frontend is known to send.
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=2",
      "dQw4w9WgXcQ",
    ],
  ])("extracts from %s", (url, expected) => {
    expect(extractVideoId(url)).toBe(expected);
  });

  it.each([
    "https://example.com/not-youtube",
    "https://www.youtube.com/",
    "not-a-url-at-all",
    "",
  ])("returns null for %s", (url) => {
    expect(extractVideoId(url)).toBeNull();
  });

  it("rejects strings that merely contain a valid-looking ID without the URL structure", () => {
    // Defense against callers that pass bare IDs — the library expects a
    // URL, so we should not silently accept half-URLs.
    expect(extractVideoId("dQw4w9WgXcQ")).toBeNull();
  });
});

describe("isExpectedNoCaptions", () => {
  // The distinction between expected (return null, fallback to Whisper)
  // and unexpected (log + alert) is what gates the fallback path, so a
  // mis-classification here causes either silent Whisper bills or
  // spurious alerts. Pin the classification behavior.
  it("classifies library-defined no-captions errors as expected", () => {
    expect(
      isExpectedNoCaptions(new YoutubeTranscriptDisabledError("x"))
    ).toBe(true);
    expect(
      isExpectedNoCaptions(new YoutubeTranscriptNotAvailableError("x"))
    ).toBe(true);
  });

  it("treats arbitrary errors as unexpected (alertable)", () => {
    expect(isExpectedNoCaptions(new Error("network timeout"))).toBe(false);
    expect(isExpectedNoCaptions(new TypeError("x"))).toBe(false);
    expect(isExpectedNoCaptions("string-error")).toBe(false);
    expect(isExpectedNoCaptions(null)).toBe(false);
  });
});
