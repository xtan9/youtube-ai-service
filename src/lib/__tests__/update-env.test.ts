import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, cpSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const exec = promisify(execFile);

// update-env.sh resolves the target .env from `$(cd "$(dirname "$0")/..")` — it
// assumes the script sits in a `scripts/` subdir of the repo. To exercise it
// in isolation we copy the script into scripts/ under a throwaway dir and
// treat that dir as the repo root. Gives us a real `.env` at a real path
// without any risk of touching the real project .env.
function makeFakeRepo(): { repo: string; script: string; envPath: string } {
  const repo = mkdtempSync(join(tmpdir(), "update-env-test-"));
  const scriptsDir = join(repo, "scripts");
  mkdirSync(scriptsDir);
  const script = join(scriptsDir, "update-env.sh");
  cpSync(
    join(__dirname, "..", "..", "..", "scripts", "update-env.sh"),
    script
  );
  return { repo, script, envPath: join(repo, ".env") };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// This script deploys only to Linux. Git Bash on Windows does not reliably
// release flock-backed file handles before the process exits, which makes
// cleanup fail and can expose different empty-file behavior. Linux CI still
// runs every case; Windows developers can run the rest of the suite cleanly.
describe.skipIf(process.platform === "win32")("update-env.sh", () => {
  let repo: string;
  let script: string;
  let envPath: string;

  beforeEach(() => {
    const fake = makeFakeRepo();
    repo = fake.repo;
    script = fake.script;
    envPath = fake.envPath;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("appends a new KEY=VALUE when absent", async () => {
    writeFileSync(envPath, "VPS_API_KEY=secret\n");
    await exec("bash", [script, "TS_AUTHKEY=tskey-abc"]);
    expect(read(envPath)).toBe("VPS_API_KEY=secret\nTS_AUTHKEY=tskey-abc\n");
  });

  it("rotates an existing key in place without touching siblings", async () => {
    writeFileSync(envPath, "VPS_API_KEY=secret\nTS_AUTHKEY=old\nUNRELATED=keep\n");
    await exec("bash", [script, "TS_AUTHKEY=rotated"]);
    expect(read(envPath)).toBe(
      "VPS_API_KEY=secret\nTS_AUTHKEY=rotated\nUNRELATED=keep\n"
    );
  });

  it("skips empty RHS so an unset GitHub secret doesn't wipe the existing value", async () => {
    writeFileSync(envPath, "TS_AUTHKEY=still-valid\n");
    await exec("bash", [script, "TS_AUTHKEY=", "TS_EXIT_NODE_HOSTNAME=mac"]);
    expect(read(envPath)).toBe("TS_AUTHKEY=still-valid\nTS_EXIT_NODE_HOSTNAME=mac\n");
  });

  it("preserves `=` characters inside values (base64 padding, URLs with query strings)", async () => {
    // Values may contain `=` — base64 padding, URL query strings, JWTs.
    // They must round-trip unchanged.
    writeFileSync(envPath, "");
    await exec("bash", [script, "TOKEN=abc=def==", "URL=http://x.y/?a=1&b=2"]);
    expect(read(envPath)).toBe("TOKEN=abc=def==\nURL=http://x.y/?a=1&b=2\n");
  });

  it("rejects keys with regex metacharacters to prevent match overreach", async () => {
    writeFileSync(envPath, "");
    await expect(
      exec("bash", [script, "TS.AUTHKEY=wildcard-risk"])
    ).rejects.toThrow(/invalid key/);
  });

  it("handles an empty .env file (first-run bootstrap)", async () => {
    writeFileSync(envPath, "");
    await exec("bash", [script, "TS_AUTHKEY=first"]);
    expect(read(envPath)).toBe("TS_AUTHKEY=first\n");
  });

  it("does not require a trailing newline on existing content", async () => {
    // Some text editors save without a trailing newline. The script should
    // not lose the last line or silently corrupt it.
    writeFileSync(envPath, "VPS_API_KEY=secret");
    await exec("bash", [script, "TS_AUTHKEY=new"]);
    expect(read(envPath)).toBe("VPS_API_KEY=secret\nTS_AUTHKEY=new\n");
  });

  it("is idempotent — running twice with the same args yields the same file", async () => {
    writeFileSync(envPath, "VPS_API_KEY=secret\n");
    await exec("bash", [script, "TS_AUTHKEY=abc"]);
    const afterFirst = read(envPath);
    await exec("bash", [script, "TS_AUTHKEY=abc"]);
    expect(read(envPath)).toBe(afterFirst);
  });
});
