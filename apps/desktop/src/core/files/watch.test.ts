import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "../bus";
import { DomainError } from "../workspaces/support";
import { type Temporary, temporary } from "./workspace.fixture";
import {
  fileVersion,
  register,
  releaseWorkspace,
  unregister,
  watchedPaths,
} from "./watch";
import { writeTextFile } from "./write";

/**
 * Ported from the test module of `apps/runtime/src/file_watch.rs`.
 *
 * Filesystem notifications are asynchronous on every platform, so the two
 * helpers are the same ones the Rust suite uses: poll up to a generous
 * ceiling for an event, and wait a fixed quiet period to assert that none
 * arrives. The registry is process-global there and here, so each test takes
 * a workspace id of its own.
 */

let counter = 0;
const workspaceId = (): string => `ws-watch-${(counter += 1)}`;

interface Fixture {
  readonly id: string;
  readonly root: string;
  readonly path: string;
  readonly events: WorkspaceEvent[];
  publish(id: string, event: WorkspaceEvent): void;
}

/**
 * How long to let the OS watcher arm before the test changes anything.
 *
 * `fs.watch` returns before FSEvents has registered the directory, and a
 * change made inside that window is simply never reported — on a loaded
 * machine the window is wide enough to lose a test. The Rust suite has the
 * same race and hides it behind a ten-second poll for the event; polling does
 * not help when the event was never generated, so this waits on the arming
 * instead of on the notification.
 */
const ARM_MS = 250;

const open = async (root: Temporary, content: string): Promise<Fixture> => {
  const id = workspaceId();
  const events: WorkspaceEvent[] = [];
  const publish = (_id: string, event: WorkspaceEvent): void => {
    events.push(event);
  };
  writeFileSync(join(root.path, "note.txt"), content);
  const registration = register(id, root.path, "note.txt", "node-1", publish);
  expect(registration.status).toBe("watching");
  expect(registration.version.exists).toBe(true);
  await delay(ARM_MS);
  return {
    id,
    root: root.path,
    path: join(root.path, "note.txt"),
    events,
    publish,
  };
};

/** The next event, or `undefined` once the ceiling is reached. */
async function next(fixture: Fixture): Promise<WorkspaceEvent | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const event = fixture.events.shift();
    if (event !== undefined) return event;
    await delay(20);
  }
  return undefined;
}

async function quiet(fixture: Fixture): Promise<boolean> {
  await delay(900);
  return fixture.events.length === 0;
}

describe("watching open editor files", () => {
  const roots: Temporary[] = [];
  const opened: string[] = [];
  const workspace = (): Temporary => {
    const one = temporary("armadra-watch-");
    roots.push(one);
    return one;
  };
  afterEach(() => {
    for (const id of opened.splice(0)) releaseWorkspace(id);
    for (const one of roots.splice(0)) one.remove();
  });

  it("reaches the workspace channel on an external write", async () => {
    const fixture = await open(workspace(), "one\n");
    opened.push(fixture.id);
    writeFileSync(fixture.path, "one\ntwo\n");
    const event = await next(fixture);
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: "file.changed",
      workspaceId: fixture.id,
      path: "note.txt",
      kind: "modified",
      sha256: createHash("sha256").update("one\ntwo\n").digest("hex"),
      size: 8,
    });
    expect((event as { mtime: string | null }).mtime).toMatch(/\+00:00$/);
  });

  it("does not report a save made through the core", async () => {
    const fixture = await open(workspace(), "one\n");
    opened.push(fixture.id);
    const version = createHash("sha256").update("one\n").digest("hex");
    writeTextFile(fixture.root, "note.txt", "mine\n", version, false);
    expect(await quiet(fixture)).toBe(true);
    // …and the node still learns about a real edit afterwards.
    writeFileSync(fixture.path, "theirs\n");
    expect(await next(fixture)).toBeDefined();
  });

  it("classifies deletions and recreations", async () => {
    const fixture = await open(workspace(), "one\n");
    opened.push(fixture.id);
    rmSync(fixture.path);
    const removal = await next(fixture);
    expect(removal).toMatchObject({
      kind: "removed",
      sha256: null,
      size: null,
    });
    // A file that comes back after the editor was told it was gone is a
    // replacement, not an edit of the same file.
    writeFileSync(fixture.path, "back again\n");
    expect(await next(fixture)).toMatchObject({ kind: "replaced" });
  });

  it("reports an atomic replace by another tool as replaced", async () => {
    const root = workspace();
    const fixture = await open(root, "one\n");
    opened.push(fixture.id);
    const staged = join(root.path, "their-tmp");
    writeFileSync(staged, "theirs\n");
    renameSync(staged, fixture.path);
    expect(await next(fixture)).toMatchObject({
      path: "note.txt",
      kind: "replaced",
    });
  });

  it("stops pushing once the workspace is released", async () => {
    const fixture = await open(workspace(), "one\n");
    opened.push(fixture.id);
    releaseWorkspace(fixture.id);
    writeFileSync(fixture.path, "after revocation\n");
    expect(await quiet(fixture)).toBe(true);
    // Re-registering is what a re-granted permission does, and it works.
    register(fixture.id, fixture.root, "note.txt", "node-1", fixture.publish);
    await delay(ARM_MS);
    writeFileSync(fixture.path, "after regrant\n");
    expect(await next(fixture)).toBeDefined();
  });

  it("releases the watch when the last viewer leaves", async () => {
    const fixture = await open(workspace(), "one\n");
    opened.push(fixture.id);
    register(fixture.id, fixture.root, "note.txt", "node-2", fixture.publish);
    await delay(ARM_MS);
    expect(watchedPaths(fixture.id)).toEqual(["note.txt"]);
    unregister(fixture.id, "note.txt", "node-1");
    writeFileSync(fixture.path, "still watched\n");
    expect(await next(fixture)).toBeDefined();
    unregister(fixture.id, "note.txt", "node-2");
    expect(watchedPaths(fixture.id)).toEqual([]);
    writeFileSync(fixture.path, "no longer watched\n");
    expect(await quiet(fixture)).toBe(true);
  });

  it("degrades to on-demand versions when no backend is available", () => {
    const root = workspace();
    writeFileSync(join(root.path, "note.txt"), "one\n");
    const id = workspaceId();
    opened.push(id);
    const registration = register(
      id,
      root.path,
      "note.txt",
      "node-1",
      () => {},
      {
        backendAvailable: false,
      },
    );
    expect(registration.status).toBe("unsupported");
    expect(registration.reason).toBeDefined();
    expect(registration.version.sha256).toBe(
      createHash("sha256").update("one\n").digest("hex"),
    );
    // The fallback answers the same question without a watcher.
    writeFileSync(join(root.path, "note.txt"), "two\n");
    const version = fileVersion(root.path, "note.txt");
    expect(version.exists).toBe(true);
    expect(version.sha256).toBe(
      createHash("sha256").update("two\n").digest("hex"),
    );
  });

  it("answers for missing files and refuses escapes", () => {
    const root = workspace();
    const missing = fileVersion(root.path, "gone.txt");
    expect(missing.exists).toBe(false);
    expect(missing.path).toBe("gone.txt");
    expect(missing.sha256).toBeNull();
    for (const bad of ["../escape.txt", "/etc/hosts"]) {
      let refusal: unknown;
      try {
        fileVersion(root.path, bad);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, bad).toBeInstanceOf(DomainError);
      expect((refusal as DomainError).status, bad).toBe(400);
    }
  });

  it("refuses a registration without a usable node id", () => {
    const root = workspace();
    writeFileSync(join(root.path, "note.txt"), "one\n");
    const id = workspaceId();
    opened.push(id);
    let refusal: unknown;
    try {
      register(id, root.path, "note.txt", "", () => {});
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DomainError);
    expect((refusal as DomainError).status).toBe(400);
  });
});
