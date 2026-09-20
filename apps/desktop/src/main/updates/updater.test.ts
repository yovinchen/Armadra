/**
 * The electron-updater wiring, against stand-ins for Electron and for the
 * updater itself.
 *
 * The state machine's own contract is tested without any of this
 * (`shell-core/updates/machine.test.ts`, 195 table entries). What is worth
 * testing here is the part that only exists once the two are joined, and the
 * one rule that is Armadra's alone:
 *
 * **A Host that will not stop means nothing is installed.** Not "installed
 * anyway", not "installed after a timeout" — the installer is never reached,
 * no pending record is written, and the update goes back to waiting with
 * `hostStopFailed` attached so the page can say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE = "http://127.0.0.1:8123/v0.2.0";
const BUNDLE = `${RELEASE}/Armadra-0.2.0-arm64-mac.zip`;
const PAYLOAD = "armadra-0.2.0";
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

/* ------------------------------- stand-ins -------------------------------- */

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableDifferentialDownload = false;
  forceDevUpdateConfig = false;
  feed: unknown = null;
  installs = 0;
  /** Set to make `downloadUpdate` reject instead of resolving. */
  failure: Error | null = null;
  /** The file `downloadUpdate` resolves with. */
  file = "";
  version = "0.2.0";
  /** Resolves only once `release()` is called, for the cancellation test. */
  hold: (() => void) | null = null;

  setFeedURL(feed: unknown) {
    this.feed = feed;
  }

  checkForUpdates() {
    return Promise.resolve({ updateInfo: { version: this.version } });
  }

  async downloadUpdate(token: { cancel: () => void }) {
    this.emit("download-progress", { transferred: 7, total: 13 });
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.hold = resolve;
        // The shell's cancel reaches electron-updater through this token.
        void token;
      });
    }
    if (this.failure) throw this.failure;
    return [this.file];
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

const updater = new FakeUpdater();
const cancellations: { cancelled: boolean }[] = [];

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.1.0",
    getAppPath: () => "/nowhere",
    getLocale: () => "en",
  },
}));

/**
 * electron-updater 的替身，经 `UpdatesDeps.updaterModule` 注入。
 *
 * 不是 `vi.mock("electron-updater")`：生产代码是延迟 `require` 它的（省下
 * 16.5 MB 常驻，理由写在 `updater.ts` 的 `updaterModule` 那一条），而
 * `vi.mock` 拦的是 import。注入是同一件事说得更直白的那种写法。
 */
const updaterModule = () =>
  ({
    get autoUpdater() {
      return updater;
    },
    CancellationToken: class {
      cancelled = false;
      constructor() {
        cancellations.push(this);
      }
      cancel() {
        this.cancelled = true;
        updater.hold?.();
      }
    },
  }) as unknown as typeof import("electron-updater");

const sent: { channel: string; payload: unknown }[] = [];
vi.mock("../window", () => ({
  sendToWindow: (channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  },
  markQuitting: () => undefined,
  getMainWindow: () => null,
}));

/* --------------------------------- fixture -------------------------------- */

const FEED = [
  "version: 0.2.0",
  "files:",
  "  - url: Armadra-0.2.0-arm64-mac.zip",
  "    size: 13",
  "",
].join("\n");

function verdict() {
  return {
    state: "available",
    reasonCode: "",
    retryAfterMs: 0,
    checkedAtMs: 1_700_000_000_000,
    target: "darwin-aarch64",
    answer: {
      version: "0.2.0",
      notesUrl: "https://releases.invalid/v0.2.0",
      artifacts: [
        {
          component: "manifest",
          target: "",
          url: `${RELEASE}/latest-mac.yml`,
          sizeBytes: 200,
          sha256: "b".repeat(64),
          signed: false,
        },
        {
          component: "desktop",
          target: "darwin-aarch64",
          url: BUNDLE,
          sizeBytes: 13,
          sha256: DIGEST,
          signed: false,
        },
      ],
    },
  };
}

let directory: string;
let stagedFile: string;
let hostStops: () => Promise<void>;
let runtimeStops: () => Promise<void>;
let restarts: number;

interface Subject {
  controller: import("./updater").UpdatesController;
}

async function subject(
  overrides: Partial<import("./updater").UpdatesDeps> = {},
): Promise<Subject> {
  const { UpdatesController } = await import("./updater");
  return {
    controller: new UpdatesController({
      host: {
        launchConfig: () => ({
          binary: join(directory, "armadra-host"),
          dataDir: directory,
        }),
        stop: () => hostStops(),
      },
      runtime: { stop: () => runtimeStops() },
      runtimeVersion: async () => "0.2.0",
      onBeforeRestart: () => {
        restarts += 1;
      },
      settings: async () => "",
      updaterModule,
      ...overrides,
    }),
  };
}

/** Walks a fresh controller as far as "downloaded, waiting for a restart". */
async function staged(overrides = {}) {
  const { controller } = await subject(overrides);
  expect((await controller.check(verdict())).state).toBe("available");
  expect((await controller.download()).state).toBe("downloaded");
  return controller;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-updater-"));
  stagedFile = join(directory, "Armadra-0.2.0-arm64-mac.zip");
  writeFileSync(stagedFile, PAYLOAD);
  // The Host's launcher record says this shell started it, so it is ours to
  // stop. The tests that need "not ours" rewrite it.
  writeFileSync(
    join(directory, "launcher.json"),
    JSON.stringify({
      launcher: "desktop",
      executable: join(directory, "armadra-host"),
    }),
  );
  process.env.ARMADRA_DATA_DIR = directory;
  process.env.ARMADRA_HOST_DATA_DIR = directory;
  // A development build only reaches a loopback release server when it was
  // explicitly asked to. Without both of these it reports `notConfigured`.
  process.env.ARMADRA_UPDATES_DEV = "1";
  process.env.ARMADRA_UPDATER_ENDPOINTS = RELEASE;

  updater.failure = null;
  updater.file = stagedFile;
  updater.version = "0.2.0";
  updater.hold = null;
  updater.installs = 0;
  cancellations.length = 0;
  sent.length = 0;
  restarts = 0;
  hostStops = async () => undefined;
  runtimeStops = async () => undefined;

  vi.stubGlobal("fetch", async (url: URL | string) => {
    if (String(url) === `${RELEASE}/latest-mac.yml`) {
      return new Response(FEED, { status: 200 });
    }
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.ARMADRA_DATA_DIR;
  delete process.env.ARMADRA_HOST_DATA_DIR;
  delete process.env.ARMADRA_UPDATES_DEV;
  delete process.env.ARMADRA_UPDATER_ENDPOINTS;
});

/* ---------------------------------- tests --------------------------------- */

it("a development build with no escape hatch reports not configured", async () => {
  delete process.env.ARMADRA_UPDATES_DEV;
  delete process.env.ARMADRA_UPDATER_ENDPOINTS;
  const { controller } = await subject();
  expect(controller.state()).toEqual({
    state: "notConfigured",
    missing: { pubkey: true, endpoints: true },
  });
  // And it stays there: a check against a build that could verify nothing must
  // not answer "up to date".
  expect((await controller.check(verdict())).state).toBe("notConfigured");
  expect((await controller.download()).state).toBe("notConfigured");
});

it("checks, downloads and verifies one release against the host's digest", async () => {
  const controller = await staged();
  const state = controller.state();
  expect(state.state).toBe("downloaded");
  if (state.state !== "downloaded") return;
  expect(state.offer.packageUrl).toBe(BUNDLE);
  expect(state.offer.sha256).toBe(DIGEST);
  expect(state.phase).toBe("ready");
  // The feed is the release the Host described, not an address baked into
  // this build.
  expect(updater.feed).toEqual({
    provider: "generic",
    url: `${RELEASE}/`,
  });
  // A differential download reassembles a file this shell never saw
  // published; the digest check below is only meaningful over the whole one.
  expect(updater.disableDifferentialDownload).toBe(true);
  expect(updater.autoDownload).toBe(false);
  // Progress reached the page, resolved at send time.
  expect(sent).toContainEqual({
    channel: "updates:progress",
    payload: { receivedBytes: 7, totalBytes: 13 },
  });
});

it("a bundle whose bytes are not the ones the host described is refused", async () => {
  writeFileSync(stagedFile, "something else entirely");
  const { controller } = await subject();
  await controller.check(verdict());
  const state = await controller.download();
  expect(state).toMatchObject({ state: "failed", reason: "digestMismatch" });
  // Nothing is staged, so a restart has nothing to install.
  expect(updater.installs).toBe(0);
});

it("a feed that offers a different version than the host did is refused", async () => {
  updater.version = "0.9.9";
  const { controller } = await subject();
  await controller.check(verdict());
  expect(await controller.download()).toMatchObject({
    state: "failed",
    reason: "sourceMalformed",
  });
});

it("a cancelled transfer keeps the offer and stops the bytes", async () => {
  updater.hold = () => undefined;
  const { controller } = await subject();
  await controller.check(verdict());
  const running = controller.download();
  // Let the transfer reach its hold before cancelling it.
  await new Promise((resolve) => setImmediate(resolve));
  expect(controller.cancel()).toEqual({
    state: "available",
    offer: expect.objectContaining({ packageUrl: BUNDLE }),
  });
  expect(cancellations.at(-1)?.cancelled).toBe(true);
  // The transfer that completes anyway stages nothing: the machine refused
  // `downloadFinished`, and that refusal is read as "do not keep these bytes".
  expect((await running).state).toBe("available");
  expect(updater.installs).toBe(0);
});

describe("stopping the background before an install (§2.3, R5)", () => {
  it("a host that will not stop means nothing is installed", async () => {
    const controller = await staged();
    hostStops = () => Promise.reject(new Error("Host shutdown timed out"));

    const state = await controller.install();

    expect(state).toEqual({
      state: "downloaded",
      offer: expect.objectContaining({ version: "0.2.0" }),
      phase: "ready",
      problem: "hostStopFailed",
    });
    // The three things "nothing was installed" actually means.
    expect(updater.installs).toBe(0);
    expect(restarts).toBe(0);
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      false,
    );
  });

  it("a runtime that will not stop is the same answer", async () => {
    const controller = await staged();
    runtimeStops = () => Promise.reject(new Error("Runtime did not confirm"));

    expect(await controller.install()).toMatchObject({
      state: "downloaded",
      phase: "ready",
      problem: "hostStopFailed",
    });
    expect(updater.installs).toBe(0);
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      false,
    );
  });

  it("a host somebody else launched is never stopped, and the install runs", async () => {
    writeFileSync(
      join(directory, "launcher.json"),
      JSON.stringify({ launcher: "service" }),
    );
    let asked = 0;
    hostStops = async () => {
      asked += 1;
    };
    const controller = await staged();

    await controller.install();

    // Its sessions belong to whoever installed it; this update does not end
    // them, and it does not need to.
    expect(asked).toBe(0);
    expect(updater.installs).toBe(1);
  });

  it("a confirmed restart records what it expects before handing over", async () => {
    const controller = await staged();

    await controller.install();

    expect(restarts).toBe(1);
    expect(updater.installs).toBe(1);
    const pending = JSON.parse(
      readFileSync(join(directory, "updates", "pending-restart.json"), "utf8"),
    );
    expect(pending).toMatchObject({
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
    });
  });

  it("an installer that failed leaves no record and retracts the announcement", async () => {
    const controller = await staged();
    const announcements: unknown[] = [];
    controller.onStaged((update) => announcements.push(update));
    updater.quitAndInstall = () => {
      throw new Error("could not write to the application bundle");
    };

    const state = await controller.install();

    expect(state.state).toBe("failed");
    // Nothing should tell the next start that an update happened…
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      false,
    );
    // …and the tray must stop offering a restart that would fail the same way.
    expect(announcements).toContainEqual({ ready: false, version: "" });
    updater.quitAndInstall = FakeUpdater.prototype.quitAndInstall;
  });
});

describe("the restart report (§2.3, R6)", () => {
  it("says nothing when no update was pending", async () => {
    const { controller } = await subject();
    expect(await controller.restartReport()).toBeNull();
  });

  it("reports the update as unfinished when a reading disagrees", async () => {
    const { controller } = await subject({
      runtimeVersion: async () => "0.1.0",
    });
    writeFileSync(
      join(directory, "launcher.json"),
      JSON.stringify({ launcher: "desktop" }),
    );
    const { writePending } = await import(
      "../../shell-core/updates/coordinate"
    );
    writePending(directory, {
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
      previousPackageUrl: "",
      notesUrl: "",
      startedAtMs: 1,
    });
    const outcome = await controller.restartReport();
    expect(outcome).toMatchObject({ outcome: "incomplete" });
    // The record is KEPT, so the page can still offer the previous release.
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      true,
    );
  });
});
