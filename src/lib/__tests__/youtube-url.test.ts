import { describe, it, expect } from "vitest";
import {
  parseYouTubeVideoReference,
  youtubeVideoReferenceSchema,
} from "../youtube-url.js";

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
    "https://attacker.example/steal?token=secret",
    "http://user:pass@evil.com/",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%20",
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://youtu.be/short",
    "https://youtu.be/dQw4w9WgXc/too-many-path-segments",
    "https://youtube.com/watch?v=short&v=dQw4w9WgXcQ",
    "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://phishing-youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.phish.example/watch?v=dQw4w9WgXcQ",
    "https://youtub.com/watch?v=dQw4w9WgXcQ",
    "https://youtube-com.net/watch?v=dQw4w9WgXcQ",
    "not-a-url",
    "",
  ])("rejects %s", (url) => {
    expect(youtubeVideoReferenceSchema.safeParse(url).success).toBe(false);
  });

  it("exposes direct parsing through the same canonical policy", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

    expect(parseYouTubeVideoReference(url)).toEqual({
      url,
      videoId: "dQw4w9WgXcQ",
    });
    expect(parseYouTubeVideoReference("https://example.com/video")).toBeNull();
  });
});
