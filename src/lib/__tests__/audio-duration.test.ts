import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeAudioDurationSeconds } from "../audio-duration.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
const mockedExecFile = vi.mocked(execFile);

const mockExecStdout = (stdout: string) => {
  mockedExecFile.mockImplementation(
    // @ts-expect-error execFile overloads don't narrow cleanly in mock
    (_cmd, _args, _opts, cb) => {
      cb?.(null, stdout, "");
    }
  );
};

const mockExecFailure = (err: Error, stderr = "") => {
  mockedExecFile.mockImplementation(
    // @ts-expect-error execFile overloads don't narrow cleanly in mock
    (_cmd, _args, _opts, cb) => {
      cb?.(err, "", stderr);
    }
  );
};

describe("probeAudioDurationSeconds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Silence the new structured error logs from the function under
    // test — these tests assert on the return contract (null on every
    // failure), not on log shape. A separate test could pin log shape;
    // keeping the existing tests focused.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("parses ffprobe's format.duration into a number", async () => {
    mockExecStdout(JSON.stringify({ format: { duration: "139.32" } }));
    expect(await probeAudioDurationSeconds("/tmp/clip.mp3")).toBe(139.32);
  });

  it("returns null when ffprobe exits non-zero (caller fails closed)", async () => {
    // The route uses null → 'unknown, treat as too long for fallback'.
    // Throwing instead would promote a transient ffprobe blip into a 500.
    mockExecFailure(new Error("ffprobe failed"), "no such file");
    expect(await probeAudioDurationSeconds("/tmp/clip.mp3")).toBeNull();
  });

  it("returns null when ffprobe stdout is unparseable JSON", async () => {
    mockExecStdout("not json");
    expect(await probeAudioDurationSeconds("/tmp/clip.mp3")).toBeNull();
  });

  it("returns null when format.duration is missing or not numeric", async () => {
    mockExecStdout(JSON.stringify({ format: {} }));
    expect(await probeAudioDurationSeconds("/tmp/clip.mp3")).toBeNull();
    mockExecStdout(JSON.stringify({ format: { duration: "abc" } }));
    expect(await probeAudioDurationSeconds("/tmp/clip.mp3")).toBeNull();
  });

  it("logs distinct errorIds for each failure class so ops can disambiguate ffprobe bugs from missing audio", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // ffprobe exec failure → FFPROBE_EXEC_FAILED
    mockExecFailure(new Error("ffprobe failed"), "no such file");
    await probeAudioDurationSeconds("/tmp/clip.mp3");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("FFPROBE_EXEC_FAILED"),
      expect.objectContaining({ errorId: "FFPROBE_EXEC_FAILED" })
    );

    // unparseable JSON → FFPROBE_JSON_PARSE_FAILED
    errSpy.mockClear();
    mockExecStdout("not json");
    await probeAudioDurationSeconds("/tmp/clip.mp3");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("FFPROBE_JSON_PARSE_FAILED"),
      expect.objectContaining({ errorId: "FFPROBE_JSON_PARSE_FAILED" })
    );

    // missing format field → FFPROBE_SCHEMA_INVALID
    errSpy.mockClear();
    mockExecStdout(JSON.stringify({ not_format: {} }));
    await probeAudioDurationSeconds("/tmp/clip.mp3");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("FFPROBE_SCHEMA_INVALID"),
      expect.objectContaining({ errorId: "FFPROBE_SCHEMA_INVALID" })
    );

    // non-numeric duration → FFPROBE_DURATION_INVALID
    errSpy.mockClear();
    mockExecStdout(JSON.stringify({ format: { duration: "abc" } }));
    await probeAudioDurationSeconds("/tmp/clip.mp3");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("FFPROBE_DURATION_INVALID"),
      expect.objectContaining({ errorId: "FFPROBE_DURATION_INVALID" })
    );
  });
});
