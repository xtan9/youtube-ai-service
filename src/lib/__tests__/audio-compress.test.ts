import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import {
  compressForGroq,
  AudioCompressError,
} from "../audio-compress.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// Cast through unknown — node's execFile overloads make the precise
// callback type intractable to mock-impl directly, but the runtime
// shape (4 args, 4th is the callback) is what we need.
const mockedExecFile = childProcess.execFile as unknown as {
  mockImplementation: (
    fn: (
      file: string,
      args: readonly string[] | null | undefined,
      opts: object | null | undefined,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => unknown
  ) => void;
  mockReset: () => void;
  mock: { calls: unknown[][] };
};

function mockExecFileOk(): void {
  mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
    cb(null, "", "");
    return {};
  });
}

function mockExecFileFail(stderr: string): void {
  mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
    const err = new Error("ffmpeg exit 1");
    cb(err, "", stderr);
    return {};
  });
}

describe("compressForGroq", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes ffmpeg with 16kHz mono 32kbps mp3 args and returns the output path", async () => {
    mockExecFileOk();

    const out = await compressForGroq("/tmp/src.mp3");

    expect(out).toMatch(/^.+\/groq-[0-9a-f-]+\.mp3$/);
    expect(mockedExecFile.mock.calls).toHaveLength(1);
    const [cmd, args] = mockedExecFile.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(cmd).toBe("ffmpeg");
    expect(args).toEqual([
      "-y",
      "-i",
      "/tmp/src.mp3",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "32k",
      "-f",
      "mp3",
      out,
    ]);
  });

  it("throws AudioCompressError carrying the ffmpeg stderr when re-encode fails", async () => {
    mockExecFileFail("Invalid data found when processing input");

    await expect(compressForGroq("/tmp/src.mp3")).rejects.toBeInstanceOf(
      AudioCompressError
    );
    await expect(compressForGroq("/tmp/src.mp3")).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid data"),
    });
  });

  it("falls back to error.message when ffmpeg's stderr is empty", async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const err = new Error("ENOENT: ffmpeg not found");
      cb(err, "", "");
      return {};
    });

    await expect(compressForGroq("/tmp/src.mp3")).rejects.toMatchObject({
      stderr: expect.stringContaining("ENOENT"),
    });
  });
});
