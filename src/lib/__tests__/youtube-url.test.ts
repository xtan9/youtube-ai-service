import { describe, it, expect } from "vitest";
import {
  extractVideoId,
  isYoutubeUrl,
  parseYouTubeVideoReference,
  youtubeUrlSchema,
  youtubeVideoReferenceSchema,
} from "../youtube-url.js";

describe("isYoutubeUrl", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  ])("accepts %s", (url) => {
    expect(isYoutubeUrl(url)).toBe(true);
  });

  it.each([
    // Arbitrary-host URLs z.string().url() would accept but that must
    // not reach Caption Track acquisition / audio download. This is the core guard:
    // an authed caller can't smuggle non-YouTube targets through.
    "https://attacker.example/steal?token=secret",
    "http://user:pass@evil.com/",
    "ftp://youtube.com/file",
    "https://phishing-youtube.com/watch?v=x",
    "https://youtube.com.phish.example/",
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://youtu.be/short",
    // typosquats
    "https://youtub.com/watch?v=x",
    "https://youtube-com.net/",
  ])("rejects %s", (url) => {
    expect(isYoutubeUrl(url)).toBe(false);
  });

  it.each(["not-a-url-at-all", "", "just-text"])(
    "rejects garbage %s",
    (url) => {
      expect(isYoutubeUrl(url)).toBe(false);
    }
  );
});

describe("youtubeUrlSchema", () => {
  // The schema is what routes use; test it end-to-end so a refactor
  // that drops `.url()` or `.refine()` fails these tests.
  it("parses a valid YouTube URL", () => {
    const result = youtubeUrlSchema.safeParse(
      "https://youtu.be/dQw4w9WgXcQ"
    );
    expect(result.success).toBe(true);
  });

  it("rejects non-YouTube URLs at the schema boundary", () => {
    const result = youtubeUrlSchema.safeParse(
      "https://attacker.example/?token=secret"
    );
    expect(result.success).toBe(false);
  });

  it("rejects plain strings (not URL-parseable at all)", () => {
    const result = youtubeUrlSchema.safeParse("not-a-url");
    expect(result.success).toBe(false);
  });
});

describe("youtubeVideoReferenceSchema", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["http://youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=tracking", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=2",
      "dQw4w9WgXcQ",
    ],
  ])("constructs a reference for %s", (url, videoId) => {
    const result = youtubeVideoReferenceSchema.safeParse(url);

    expect(result).toEqual({
      success: true,
      data: { url, videoId },
    });
    if (result.success) expect(Object.isFrozen(result.data)).toBe(true);
  });

  it.each([
    "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%20",
    "https://youtu.be/dQw4w9WgXc/too-many-path-segments",
    "https://youtube.com/watch?v=short&v=dQw4w9WgXcQ",
    "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.phish.example/watch?v=dQw4w9WgXcQ",
    "not-a-url",
  ])("rejects %s", (url) => {
    expect(youtubeVideoReferenceSchema.safeParse(url).success).toBe(false);
  });

  it("uses the same policy for boolean recognition and direct parsing", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

    expect(isYoutubeUrl(url)).toBe(true);
    expect(parseYouTubeVideoReference(url)).toEqual({
      url,
      videoId: "dQw4w9WgXcQ",
    });
    expect(parseYouTubeVideoReference("https://example.com/video")).toBeNull();
  });

  it("extracts a canonical Video ID only through the shared policy", () => {
    expect(
      extractVideoId(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx",
      ),
    ).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("dQw4w9WgXcQ")).toBeNull();
  });
});
