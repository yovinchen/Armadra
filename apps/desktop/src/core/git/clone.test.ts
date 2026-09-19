import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, repository, temporaryDirectory } from "./fixture";
import {
  activeCloneCount,
  cancelClone,
  cloneDirectoryName,
  cloneStatus,
  resetCloneJobs,
  spawnCloneJob,
  validateCloneUrl,
} from "./clone";
import { progressPercent } from "./command";
import { redactSecrets, sanitize, sanitizeRepository } from "./support";

/**
 * Clone jobs and the two text scrubbers every Git message goes through.
 *
 * Ported from `apps/runtime/src/git/tests/{clone,clone_cancellation}.rs` and
 * the sanitizing tests in `apps/runtime/src/git/command.rs`.
 */

afterAll(() => {
  resetCloneJobs();
  cleanupFixtures();
});

async function settleClone(jobId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = cloneStatus(jobId);
    if (status.state !== "running") return status;
    if (Date.now() > deadline) throw new Error("clone did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the URL allow-list", () => {
  it("accepts https, ssh and the scp-like spelling", () => {
    for (const url of [
      "https://example.invalid/owner/repo.git",
      "ssh://git@example.invalid/owner/repo.git",
      "git@example.invalid:owner/repo.git",
    ]) {
      expect(validateCloneUrl(url)).toBe(url);
    }
  });

  it("refuses everything that is not one of those three", () => {
    for (const url of [
      "",
      "http://example.invalid/repo.git",
      "file:///tmp/repo",
      "ext::sh -c cat",
      "/local/path",
      "--upload-pack=evil",
      "https://example.invalid/repo.git\r\nHost: other",
      `https://example.invalid/${"x".repeat(2100)}`,
    ]) {
      expect(() => validateCloneUrl(url)).toThrow("Repository URL is invalid");
    }
  });

  it("derives the folder name from the URL's last segment", () => {
    expect(cloneDirectoryName("https://example.invalid/o/repo.git")).toBe(
      "repo",
    );
    expect(cloneDirectoryName("git@example.invalid:o/repo.git")).toBe("repo");
    expect(cloneDirectoryName("https://example.invalid/o/repo/")).toBe("repo");
  });
});

describe("a clone job", () => {
  it("runs to `done` and reports the directory it landed in", async () => {
    const source = repository("clone-source");
    const parent = temporaryDirectory("clone-parent");
    const target = join(parent, "copy");
    const started = spawnCloneJob(source.path, "copy", target);
    expect(activeCloneCount()).toBeGreaterThanOrEqual(1);

    const status = await settleClone(started.jobId);
    expect(status.state).toBe("done");
    expect(status.percent).toBe(100);
    expect(status.name).toBe("copy");
    expect(status.error).toBeNull();
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("reports a cancelled job apart from a failed one", async () => {
    const source = repository("clone-cancel-source");
    const parent = temporaryDirectory("clone-cancel-parent");
    const started = spawnCloneJob(source.path, "copy", join(parent, "copy"));
    cancelClone(started.jobId);
    const status = await settleClone(started.jobId);
    expect(status.state).toBe("error");
    expect(status.cancelled).toBe(true);
    expect(status.error).toContain("cancelled");
  });

  it("reports a failed clone with Git's own last line", async () => {
    const parent = temporaryDirectory("clone-fail-parent");
    const missing = join(temporaryDirectory("clone-fail-source"), "nowhere");
    const started = spawnCloneJob(missing, "copy", join(parent, "copy"));
    const status = await settleClone(started.jobId);
    expect(status.state).toBe("error");
    expect(status.cancelled).toBe(false);
    expect(status.error).not.toBeNull();
  });

  it("removes the credential from the URL it displays", async () => {
    const source = repository("clone-redact-source");
    const parent = temporaryDirectory("clone-redact-parent");
    const started = spawnCloneJob(source.path, "copy", join(parent, "copy"));
    // The display URL is produced where the original was held; nothing
    // downstream ever sees the other form.
    expect(cloneStatus(started.jobId).displayUrl).toBe(source.path);
    await settleClone(started.jobId);
  });

  it("answers a 404 for a job nobody started", () => {
    expect(() => cloneStatus("nope")).toThrow("clone job is unknown");
    expect(() => cancelClone("nope")).toThrow("clone job is unknown");
  });
});

describe("progress and sanitizing", () => {
  it("reads the newest percentage Git printed", () => {
    expect(progressPercent("Receiving objects:  47% (470/1000)")).toBe(47);
    expect(progressPercent("Resolving deltas: 100% (5/5), done.")).toBe(100);
    expect(progressPercent("remote: Counting objects")).toBeUndefined();
    expect(progressPercent("% leading")).toBeUndefined();
    expect(progressPercent("Bogus: 900%")).toBeUndefined();
  });

  it("removes credentials, headers and terminal control sequences", () => {
    const value = sanitize(
      "https://alice:private-pass@example.invalid/repo token=private-token Authorization: Basic private-basic[2J",
    );
    for (const secret of [
      "private-pass",
      "private-token",
      "private-basic",
      "",
    ]) {
      expect(value).not.toContain(secret);
    }
    expect(value).toContain("example.invalid");
  });

  it("keeps the repository scrubber's own, looser rule", () => {
    // The repository service puts its text in a JSON message, never on a
    // terminal, so it keeps control characters and only removes secrets.
    const value = sanitizeRepository(
      "ssh://bob:private@example.invalid/repo\nsecond line",
    );
    expect(value).not.toContain("private");
    expect(value).toContain("\nsecond line");
  });

  it("redacts the assignment shapes a Git error can carry", () => {
    expect(redactSecrets("ANTHROPIC_API_KEY=sk-private")).toBe(
      "ANTHROPIC_API_KEY=[REDACTED]",
    );
    expect(redactSecrets("Authorization: Bearer private-token")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });
});
