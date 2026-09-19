import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "electron";

import { STAGING_MAX_AGE_MS } from "../../shell-core/browser/downloads";
import {
  configureStaging,
  resetTransfers,
  stagedDownloads,
  sweepStaging,
  watchDownloads,
} from "./transfers";

/**
 * Where a download ends up, decided by who started it.
 *
 * The regression this pins: every download used to be staged, and the only
 * thing that can accept a staged download is an agent's `download --accept`.
 * So a person who clicked a link in a browser node got a file in a private
 * directory with a name they never chose, and no way to reach it.
 *
 * Electron itself is not mocked — `transfers.ts` imports only TYPES from it.
 * The session and the download item below are the two objects the listener
 * touches, written out because their behaviour is the whole subject: setting a
 * save path is what suppresses the Save dialog.
 */

/* ------------------------------- stand-ins -------------------------------- */

class FakeItem {
  savePath: string | null = null;
  cancelled = false;
  private done: ((event: unknown, state: string) => void) | null = null;

  constructor(private readonly filename: string) {}

  getFilename() {
    return this.filename;
  }
  getURL() {
    return `https://example.test/${this.filename}`;
  }
  getMimeType() {
    return "application/octet-stream";
  }
  getTotalBytes() {
    return 7;
  }
  setSavePath(path: string) {
    this.savePath = path;
  }
  cancel() {
    this.cancelled = true;
  }
  once(event: string, listener: (event: unknown, state: string) => void) {
    if (event === "done") this.done = listener;
  }
  finish(state = "completed") {
    this.done?.({}, state);
  }
}

class FakeSession {
  private listener:
    | ((event: unknown, item: FakeItem, contents: { id: number }) => void)
    | null = null;

  on(
    event: string,
    listener: (event: unknown, item: FakeItem, contents: { id: number }) => void,
  ) {
    if (event === "will-download") this.listener = listener;
    return this;
  }

  start(item: FakeItem, webContentsId: number) {
    this.listener?.({}, item, { id: webContentsId });
  }
}

/* --------------------------------- fixture -------------------------------- */

let root = "";
let dataDir = "";
let downloads = "";
const announced: { id: string; state: string }[] = [];

/** webContents 1 is driven by an agent; 2 is a person's own tab. */
const AGENT_CONTENTS = 1;
const HUMAN_CONTENTS = 2;

function watch(session: FakeSession): void {
  watchDownloads(
    session as unknown as Session,
    () => "node-1",
    (id) => id === AGENT_CONTENTS,
    (record) => announced.push({ id: record.id, state: record.state }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "armadra-transfers-"));
  dataDir = join(root, "data");
  downloads = join(root, "Downloads");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  announced.length = 0;
  configureStaging(dataDir, downloads);
});

afterEach(() => {
  resetTransfers();
  rmSync(root, { recursive: true, force: true });
});

/* ---------------------------------- tests --------------------------------- */

describe("a download a person started", () => {
  it("is saved into the system downloads directory, with no dialog", () => {
    const session = new FakeSession();
    watch(session);
    const item = new FakeItem("report.pdf");
    session.start(item, HUMAN_CONTENTS);

    // A save path was set: that, and only that, is what stops Electron from
    // opening a Save dialog.
    expect(item.savePath).toBe(join(downloads, "report.pdf"));
    expect(item.cancelled).toBe(false);
  });

  it("is numbered rather than overwriting a file already there", () => {
    writeFileSync(join(downloads, "report.pdf"), "older");
    const session = new FakeSession();
    watch(session);
    const item = new FakeItem("report.pdf");
    session.start(item, HUMAN_CONTENTS);

    expect(item.savePath).toBe(join(downloads, "report (1).pdf"));
    expect(existsSync(join(downloads, "report.pdf"))).toBe(true);
  });

  it("never enters the agent's queue", () => {
    const session = new FakeSession();
    watch(session);
    session.start(new FakeItem("report.pdf"), HUMAN_CONTENTS);

    expect(stagedDownloads("node-1")).toEqual([]);
    expect(announced).toEqual([]);
  });
});

describe("a download an agent caused", () => {
  it("is staged and announced, not saved where a person would find it", () => {
    const session = new FakeSession();
    watch(session);
    const item = new FakeItem("report.pdf");
    session.start(item, AGENT_CONTENTS);

    expect(item.savePath).toContain(join(dataDir, "browser-staging"));
    expect(item.savePath).not.toContain(downloads);
    const queued = stagedDownloads("node-1") as { state: string }[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.state).toBe("staging");

    item.finish();
    expect((stagedDownloads("node-1") as { state: string }[])[0]?.state).toBe(
      "ready",
    );
    expect(announced.map((each) => each.state)).toEqual(["staging", "ready"]);
  });
});

describe("a download from a guest this shell does not know", () => {
  it("is cancelled rather than saved anywhere", () => {
    const session = new FakeSession();
    watchDownloads(
      session as unknown as Session,
      () => null,
      () => false,
      () => undefined,
    );
    const item = new FakeItem("report.pdf");
    session.start(item, HUMAN_CONTENTS);

    expect(item.cancelled).toBe(true);
    expect(item.savePath).toBe(null);
  });
});

describe("the staging sweep at startup", () => {
  it("deletes yesterday's leftovers and keeps today's", () => {
    const staging = join(dataDir, "browser-staging");
    const stale = join(staging, "stale.bin");
    const fresh = join(staging, "fresh.bin");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    const longAgo = (Date.now() - STAGING_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(stale, longAgo, longAgo);

    expect(sweepStaging()).toEqual(["stale.bin"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("is what `configureStaging` runs, so a crash's leftovers do not survive", () => {
    const staging = join(dataDir, "browser-staging");
    const stale = join(staging, "stale.bin");
    writeFileSync(stale, "old");
    const longAgo = (Date.now() - STAGING_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(stale, longAgo, longAgo);

    configureStaging(dataDir, downloads);
    expect(existsSync(stale)).toBe(false);
  });
});
