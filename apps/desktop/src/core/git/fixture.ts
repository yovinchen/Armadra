import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalize } from "../workspaces/roots";
import { RepositoryService } from "./repository/service";
import type { ExpectedState } from "./repository/types";

/**
 * Real Git repositories in a temporary directory, for the Git domain's tests.
 *
 * The Rust suite these are ported from runs against real repositories too, and
 * for the same reason: almost everything the domain does is a statement about
 * `git`'s own machine-readable output, and a fake would only prove that the
 * fake matches the parser.
 *
 * The identity and the config isolation are what make the runs reproducible —
 * `GIT_CONFIG_GLOBAL=/dev/null` keeps a developer's own `init.defaultBranch`,
 * `commit.gpgsign` or `user.email` out of the assertions.
 */

export interface Repo {
  readonly path: string;
  git(...args: string[]): string;
  write(file: string, contents: string): void;
  commit(message: string): string;
  head(): string;
}

const ENVIRONMENT = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

const roots: string[] = [];

/** A temporary directory removed by {@link cleanupFixtures}. */
export function temporaryDirectory(name: string): string {
  const root = canonicalize(mkdtempSync(join(tmpdir(), `armadra-${name}-`)));
  roots.push(root);
  return root;
}

export function cleanupFixtures(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function run(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...ENVIRONMENT },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

/** An initialised repository on `main` with one seed commit. */
export function repository(name: string, seed = true): Repo {
  const path = temporaryDirectory(name);
  return initialize(path, seed);
}

/** The same, at a path the caller chose (a nested checkout, say). */
export function repositoryAt(path: string, seed = true): Repo {
  mkdirSync(path, { recursive: true });
  return initialize(canonicalize(path), seed);
}

function initialize(path: string, seed: boolean): Repo {
  run(path, "init", "-q", "-b", "main");
  const repo: Repo = {
    path,
    git: (...args) => run(path, ...args),
    write: (file, contents) => {
      const target = join(path, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    },
    commit: (message) => {
      run(path, "add", "-A");
      run(path, "commit", "-q", "-m", message);
      return repo.head();
    },
    head: () => run(path, "rev-parse", "HEAD").trim(),
  };
  if (seed) {
    repo.write("README.md", "seed\n");
    repo.commit("seed");
  }
  return repo;
}

/** A bare repository other checkouts can push to and fetch from. */
export function bareRemote(name: string): string {
  const path = temporaryDirectory(name);
  run(path, "init", "-q", "--bare", "-b", "main");
  return path;
}

/** A service that may run helpers, as a workspace with the grant would have. */
export function service(): RepositoryService {
  return new RepositoryService({ commandTimeoutMs: 30_000 });
}

/** `HEAD` as the queue's `expected` wants it. */
export async function expected(
  repositoryService: RepositoryService,
  repo: Repo,
): Promise<ExpectedState> {
  return repositoryService.head(repo.path);
}

/** Polls an operation until it settles, then answers its final snapshot. */
export async function settle(
  repositoryService: RepositoryService,
  id: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = repositoryService.operationSnapshot(id);
    if (snapshot.state !== "queued" && snapshot.state !== "running") {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(`operation ${id} did not settle: ${snapshot.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
