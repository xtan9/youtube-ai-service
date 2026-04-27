import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";
import * as os from "os";
import {
  compressForGroq,
  cleanupCompressed,
  AudioCompressError,
} from "../audio-compress.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return { ...actual, unlink: vi.fn() };
});

// Cast through unknown — node's execFile overloads make the precise
// callback type intractable to mock-impl directly, but the runtime
// shape (4 args, 4th is the callback) is what we need.
const mockedExecFile = childProcess.execFile as unknown as {
  mockImplementation: (
    fn: (
      file: string,
      args: readonly string[] | null | undefined,
      opts: { timeout?: number } | null | undefined,
      cb: (
        err:
          | (Error & { code?: string; killed?: boolean; signal?: string })
          | null,
        stdout: string,
        stderr: string
      ) => void
    ) => unknown
  ) => void;
  mockReset: () => void;
  mock: { calls: unknown[][] };
};

const mockedUnlink = vi.mocked(fsPromises.unlink);
let warnSpy: ReturnType<typeof vi.spyOn>;

function mockExecFileOk(): void {
  mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
    cb(null, "", "");
    return {};
  });
}

function mockExecFileFail(stderr: string, code?: string): void {
  mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
    const err = Object.assign(new Error("ffmpeg exit 1"), code ? { code } : {});
    cb(err, "", stderr);
    return {};
  });
}

function mockExecFileTimeoutKill(): void {
  mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
    const err = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
    });
    cb(err, "", "size=  500kB time=00:00:30");
    return {};
  });
}

describe("compressForGroq", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    mockedUnlink.mockReset();
    mockedUnlink.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes ffmpeg with -loglevel error, 16kHz mono 32kbps mp3 args + 120s timeout, and returns the output path under tmpdir", async () => {
    mockExecFileOk();

    const out = await compressForGroq("/tmp/src.mp3");

    expect(out).toMatch(/^.+\/groq-[0-9a-f-]+\.mp3$/);
    expect(out.startsWith(os.tmpdir())).toBe(true);
    expect(mockedExecFile.mock.calls).toHaveLength(1);
    const [cmd, args, opts] = mockedExecFile.mock.calls[0] as unknown as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(cmd).toBe("ffmpeg");
    // Encoder flags asserted positionally because ffmpeg parses ordered
    // pairs; the test will surface a real arg-order regression.
    expect(args).toEqual([
      "-y",
      "-loglevel",
      "error",
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
    expect(opts.timeout).toBe(120_000);
  });

  it("classifies execFile timeout-kill as kind='timeout' regardless of stderr content", async () => {
    mockExecFileTimeoutKill();

    const err = await compressForGroq("/tmp/src.mp3").catch((e) => e);

    expect(err).toBeInstanceOf(AudioCompressError);
    expect(err.kind).toBe("timeout");
    // Detail mentions the timeout budget so an operator reading logs
    // can correlate against runtime configuration.
    expect(err.detail).toMatch(/120000ms/);
    // Original Error preserved for stack-chain debugging.
    expect(err.cause).toBeDefined();
  });

  it("classifies missing ffmpeg binary (ENOENT) as kind='missing-binary'", async () => {
    mockExecFileFail("", "ENOENT");

    const err = await compressForGroq("/tmp/src.mp3").catch((e) => e);

    expect(err).toBeInstanceOf(AudioCompressError);
    expect(err.kind).toBe("missing-binary");
    expect(err.cause).toMatchObject({ code: "ENOENT" });
  });

  it("classifies generic ffmpeg failure as kind='ffmpeg-failed' carrying stderr", async () => {
    mockExecFileFail("Invalid data found when processing input");

    const err = await compressForGroq("/tmp/src.mp3").catch((e) => e);

    expect(err).toBeInstanceOf(AudioCompressError);
    expect(err.kind).toBe("ffmpeg-failed");
    expect(err.detail).toContain("Invalid data");
  });

  it("falls back to error.message when ffmpeg's stderr is empty (kind='ffmpeg-failed')", async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(new Error("EPIPE"), "", "");
      return {};
    });

    const err = await compressForGroq("/tmp/src.mp3").catch((e) => e);

    expect(err.kind).toBe("ffmpeg-failed");
    expect(err.detail).toContain("EPIPE");
  });

  it("unlinks the partial dst file when ffmpeg fails (so a SIGTERM-killed mp3 doesn't leak to /tmp)", async () => {
    mockExecFileTimeoutKill();

    await compressForGroq("/tmp/src.mp3").catch(() => undefined);

    expect(mockedUnlink).toHaveBeenCalledTimes(1);
    expect(mockedUnlink.mock.calls[0]?.[0]).toMatch(
      /^.+\/groq-[0-9a-f-]+\.mp3$/
    );
  });

  it("survives unlink-of-partial-file failure on the failure path (still rejects with AudioCompressError)", async () => {
    mockExecFileTimeoutKill();
    // ENOENT here means ffmpeg never wrote anything — fine, swallow.
    mockedUnlink.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    const err = await compressForGroq("/tmp/src.mp3").catch((e) => e);

    expect(err).toBeInstanceOf(AudioCompressError);
    expect(err.kind).toBe("timeout");
  });
});

describe("cleanupCompressed", () => {
  beforeEach(() => {
    mockedUnlink.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds silently when unlink succeeds", async () => {
    mockedUnlink.mockResolvedValue(undefined);

    await expect(cleanupCompressed("/tmp/groq-x.mp3")).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats ENOENT as benign — no warn (caller may have cleaned up already)", async () => {
    mockedUnlink.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    await expect(cleanupCompressed("/tmp/groq-x.mp3")).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns with CLEANUP_COMPRESSED_FAILED on non-ENOENT errors (leak/observability signal)", async () => {
    mockedUnlink.mockRejectedValueOnce(
      Object.assign(new Error("EACCES"), { code: "EACCES" })
    );

    await expect(cleanupCompressed("/tmp/groq-x.mp3")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, ctx] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("CLEANUP_COMPRESSED_FAILED");
    expect(ctx.errorId).toBe("CLEANUP_COMPRESSED_FAILED");
    expect(ctx.path).toBe("/tmp/groq-x.mp3");
    expect(ctx.error).toContain("EACCES");
  });
});
