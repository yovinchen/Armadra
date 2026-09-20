import { app } from "electron";
import type { CancellationToken } from "electron-updater";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { IPC } from "../../shared/ipc";
import { dataDir } from "../../shell-core/paths";
import { initialState } from "../../shell-core/updates/availability";
import { Cancellation } from "../../shell-core/updates/cancel";
import * as coordinate from "../../shell-core/updates/coordinate";
import {
  Machine,
  type Event,
  type Offer,
  type Reason,
  type UpdateState,
} from "../../shell-core/updates/machine";
import {
  STAGED_EVENT,
  localeFromEnvironment,
  notificationBody,
  notificationTitle,
  stagedCleared,
  stagedReady,
  wantsNotification,
  type Staged,
} from "../../shell-core/updates/notify";
import * as offer from "../../shell-core/updates/offer";
import {
  readVerdict,
  reasonFor,
  type HostVerdict,
} from "../../shell-core/updates/verdict";
import { sendToWindow } from "../window";
import { updaterEnvironment } from "./environment";

/**
 * Shell-side application updates, on electron-updater
 * (design docs/design/updates-and-service-install.md §2, migration §5 W2.2).
 *
 * The shell can only report what it could actually verify. electron-updater
 * refuses to install a package whose platform signature does not check out —
 * so an unsigned build could check nothing, and it says exactly that. It never
 * reports "up to date" for a check it did not make, and it never installs
 * anything on its own: the handlers below read, stage and, only after a person
 * confirms, restart.
 *
 * The work is split so the rules can be tested without a window — everything
 * with a rule worth stating lives in `shell-core/updates/`:
 *
 * - `machine` is the state machine, pure;
 * - `offer` turns the Host's answer plus the release manifest into one offer;
 * - `cancel` is the shell's own handle on a transfer already running;
 * - `notify` holds the two out-of-page announcements and their strings;
 * - `coordinate` decides what may be stopped and whether a restart worked;
 * - this file is the Electron surface: the seven handlers and one event.
 *
 * Two Electron rules are obeyed here rather than remembered:
 *
 *   1. **The window is resolved at send time** (`sendToWindow`), never
 *      captured in a closure. A download can finish long after a
 *      close→dock-reopen, and a captured reference is a destroyed window.
 *      Sending through that reference can crash the updater.
 *   2. **Only what this shell started is stopped** before an install, and a
 *      Host that will not stop means the install never starts. That is
 *      `hostStopFailed`, which blocks installation in Armadra.
 */

/** What the updater needs from the rest of the shell. */
export interface UpdatesDeps {
  /** Stops the Host this shell configured, and says who that Host is. */
  readonly host: {
    launchConfig(): { binary: string; dataDir?: string | undefined } | null;
    stop(): Promise<void>;
  };
  /** Stops the Runtime this shell owns. */
  readonly runtime: { stop(): Promise<void> };
  /** The Runtime's own version, for the restart report. `null` if unreachable. */
  readonly runtimeVersion: () => Promise<string | null>;
  /**
   * Run immediately before `quitAndInstall()`. Required so the caller can flip
   * its "quitting" flag: `quitAndInstall()` closes every window and only then
   * calls `app.quit()`, but the window's own `close` handler hides it while
   * the app is not quitting — so without this the window merely hides,
   * `app.quit()` never fires, and the update never installs.
   */
  readonly onBeforeRestart: () => void;
  /** The Runtime's settings document, for `updates.notify`. */
  readonly settings: () => Promise<Uint8Array | string>;
  /** The OS notification, which W2.1 owns. Absent = the shell shows none. */
  readonly notify?: (title: string, body: string) => void;
  /**
   * electron-updater 本体，第一次真的要用它时才取。
   *
   * 默认实现是一次延迟的 `require`，这是本批的内存改动：量出来这个包要
   * 16.5 MB RSS、159 个模块（`builder-util-runtime`、`js-yaml`、`fs-extra`、
   * `semver` 整棵树），而绝大多数会话里没有人按过「检查更新」，它从头到尾一次
   * 也没被调用。挪到下面这个函数之后，这笔常驻只有下载 / 安装那条路径才付。
   *
   * 为什么是 `require` 不是 `import()`：主进程的产物是 CJS 且装在 asar 里，
   * 实测 `import()` 走得通，但 `autoUpdater` 是个 getter，CJS 具名导出探测
   * 认不出来，拿回来是 `undefined`——更新会悄悄不工作。
   */
  readonly updaterModule?: () => typeof import("electron-updater");
}

declare const require: (id: string) => unknown;

let loaded: typeof import("electron-updater") | null = null;

function loadElectronUpdater(): typeof import("electron-updater") {
  loaded ??= require("electron-updater") as typeof import("electron-updater");
  return loaded;
}

export class UpdatesController {
  private machine: Machine | null = null;
  private readonly cancellation = new Cancellation();
  /** Set while a transfer is being awaited, so a cancel can stop the bytes. */
  private transfer: CancellationToken | null = null;
  private staged: { offer: Offer; file: string } | null = null;
  private readonly stagedListeners = new Set<(staged: Staged) => void>();

  constructor(private readonly deps: UpdatesDeps) {}

  /** electron-updater 本体。没人注入就走那次延迟的 `require`。 */
  private updater(): typeof import("electron-updater") {
    return (this.deps.updaterModule ?? loadElectronUpdater)();
  }

  /**
   * The staged-update announcement, for the tray item W2.1 adds. The tray
   * shows "restart to finish updating" while `ready` and hides it otherwise;
   * pressing it runs the same confirmed restart the settings page runs, which
   * is `install()` below.
   */
  onStaged(listener: (staged: Staged) => void): () => void {
    this.stagedListeners.add(listener);
    return () => this.stagedListeners.delete(listener);
  }

  /* ------------------------------ the state ------------------------------ */

  private current(): Machine {
    this.machine ??= Machine.of(initialState(updaterEnvironment()));
    return this.machine;
  }

  /** The state as it stands. Reads nothing off the network. */
  state(): UpdateState {
    return this.current().state();
  }

  private apply(event: Event): UpdateState {
    this.current().apply(event);
    return this.state();
  }

  /* ------------------------------- the check ----------------------------- */

  /**
   * Records the Host's answer and, when it is an offer, cross-checks it
   * against the release manifest before calling anything available (§2.2).
   */
  async check(input: unknown): Promise<UpdateState> {
    const started = this.apply({ type: "checkStarted" });
    if (started.state !== "checking") return started;
    return this.apply(await evaluate(readVerdict(input)));
  }

  /** "Skip this version": claims nothing about whether a newer one exists. */
  dismiss(): UpdateState {
    return this.apply({ type: "offerDismissed" });
  }

  /**
   * Stops what is in flight: a transfer, or a check.
   *
   * A cancelled transfer discards its bytes and goes back to the offer (§2.1).
   * There is no resume, so half a package is not something to keep, and the
   * shell says "available" again rather than pretending the partial file is
   * worth anything.
   */
  cancel(): UpdateState {
    const state = this.state();
    if (state.state === "downloading") {
      this.cancellation.cancel();
      // electron-updater's own token is what actually closes the response
      // body; the shell's token is what stops it being awaited.
      this.transfer?.cancel();
      return this.apply({ type: "checkCancelled" });
    }
    if (state.state === "checking") {
      // A check in flight is one await that cannot be interrupted; leaving
      // `checking` is enough, because its answer is only accepted from
      // `checking` and will be ignored when it lands.
      return this.apply({ type: "checkCancelled" });
    }
    return state;
  }

  /* ----------------------------- the transfer ---------------------------- */

  /**
   * Downloads the offered bundle, lets electron-updater verify its signature,
   * checks the digest the Host published, and stages it. Nothing is installed.
   */
  async download(): Promise<UpdateState> {
    // A failure that kept its offer is retried from the offer, so a person
    // pressing "try again" does not have to check first.
    if (this.state().state === "failed") this.apply({ type: "retry" });
    const started = this.apply({ type: "downloadStarted" });
    if (started.state !== "downloading") return started;
    const pending = started.offer;

    const token = this.cancellation.arm();
    const outcome = await Promise.race([
      this.transferBytes(pending).then((result) => ({ result })),
      token.notified().then(() => null),
    ]);
    this.cancellation.finish(token);
    this.transfer = null;
    if (outcome === null) {
      // `cancel()` already moved the machine back to the offer; report where
      // things actually stand rather than a second, racing transition.
      return this.state();
    }
    const result = outcome.result;
    if (!result.ok) {
      return this.apply({ type: "downloadFailed", reason: result.reason });
    }
    const state = this.apply({ type: "downloadFinished" });
    // A transfer that finished *while* it was being cancelled is not a staged
    // update: the machine refused the event, and keeping the bytes would let a
    // later restart install something nobody chose.
    if (state.state !== "downloaded") return state;
    this.staged = { offer: pending, file: result.value };
    await this.announceStaged(pending);
    return state;
  }

  private async transferBytes(pending: Offer): Promise<offer.Resolved<string>> {
    let feed: URL;
    try {
      feed = new URL(pending.manifestUrl);
    } catch {
      return { ok: false, reason: "sourceMalformed" };
    }
    const { CancellationToken, autoUpdater } = this.updater();
    // The feed of the release the Host offered, not an address this bundle was
    // built with: that is what lets a beta build update.
    autoUpdater.setFeedURL({
      provider: "generic",
      url: new URL(offer.directory(feed), feed).toString(),
    });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // The digest below is checked against the file that arrives, and a
    // differential download reassembles a file from blocks this shell never
    // saw published. Ask for the whole artifact so the two statements — the
    // Host's sha256 and these bytes — are about the same thing.
    autoUpdater.disableDifferentialDownload = true;
    // A development build has no `app-update.yml`, so electron-updater would
    // refuse to do anything at all. Measured while walking a local release
    // server: `setFeedURL` is enough for the *check*, but the download path
    // re-reads the update config from disk, so a development walkthrough also
    // needs a `dev-app-update.yml` beside the app — otherwise the transfer
    // fails with ENOENT on that file and nothing says why.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;

    const onProgress = (progress: { transferred: number; total: number }) => {
      this.apply({
        type: "downloadProgressed",
        receivedBytes: progress.transferred,
        totalBytes: progress.total,
      });
      // Resolved at send time. See the rule at the top of this file.
      sendToWindow(IPC.updatesProgress.channel, {
        receivedBytes: progress.transferred,
        totalBytes: progress.total || pending.sizeBytes,
      });
    };
    autoUpdater.on("download-progress", onProgress);
    const token = new CancellationToken();
    this.transfer = token;
    try {
      const found = await autoUpdater.checkForUpdates();
      if (!found?.updateInfo) {
        // The Host said there is one and the manifest agreed; the updater
        // disagreeing means the two documents describe different things.
        return { ok: false, reason: "sourceMalformed" };
      }
      if (found.updateInfo.version.replace(/^v+/, "") !== pending.version) {
        return { ok: false, reason: "sourceMalformed" };
      }
      const files = await autoUpdater.downloadUpdate(token);
      const file = files?.[0];
      if (typeof file !== "string" || file.length === 0) {
        return { ok: false, reason: "downloadInterrupted" };
      }
      // electron-updater verified what it verifies. This is the second,
      // independent statement: the digest the *Host* published for these
      // bytes (design §2.2, inventory §2 item 20).
      const digest = await digestOfFile(file);
      if (digest === null) return { ok: false, reason: "downloadInterrupted" };
      const verified = offer.verifyDigestHex(digest, pending.sha256);
      if (!verified.ok) return verified;
      return { ok: true, value: file };
    } catch (error) {
      return { ok: false, reason: transferReason(error) };
    } finally {
      autoUpdater.off("download-progress", onProgress);
    }
  }

  /* ------------------------------ the restart ---------------------------- */

  /**
   * Stops what this shell owns, records the restart, and installs. On success
   * this call does not return: the process is replaced.
   */
  async install(): Promise<UpdateState> {
    const preparing = this.apply({ type: "restartRequested" });
    if (preparing.state !== "downloaded" || preparing.phase !== "preparing") {
      return preparing;
    }
    const pending = preparing.offer;

    const stopped = await this.stopOwnedBackground();
    if (stopped !== null) {
      // The install never started. Nothing was replaced, nothing was written,
      // and the update goes back to waiting with the reason attached.
      return this.apply({ type: "restartAbandoned", reason: stopped });
    }

    const written = coordinate.writePending(dataDir(), {
      expectedVersion: pending.version,
      previousVersion: app.getVersion(),
      previousPackageUrl: "",
      notesUrl: pending.notesUrl,
      startedAtMs: Date.now(),
    });
    if (!written.ok) {
      return this.apply({ type: "restartAbandoned", reason: written.reason });
    }

    this.apply({ type: "backgroundStopped" });
    if (this.staged === null) {
      return this.failInstall("installFailed");
    }
    try {
      // 走到这一步必然已经下载过，模块早就加载好了；这里只是把句柄再取一次。
      const { autoUpdater } = this.updater();
      this.deps.onBeforeRestart();
      // Never returns: the installer replaces this process.
      autoUpdater.quitAndInstall();
      return this.state();
    } catch (error) {
      return this.failInstall(transferReason(error));
    }
  }

  /**
   * The install did not happen, so nothing should tell the next start that it
   * did — and the tray must stop offering a restart that would only fail the
   * same way.
   */
  private failInstall(reason: Reason): UpdateState {
    coordinate.clearPending(dataDir());
    this.staged = null;
    this.announce(stagedCleared());
    return this.apply({ type: "installFailed", reason });
  }

  /**
   * Stops the background this shell started, and only that (design §2.3).
   * Returns the reason it could not, or `null` when everything is down.
   *
   * A Host that reports another launcher keeps running: it belongs to whoever
   * installed it, and its sessions are not this update's to end.
   */
  private async stopOwnedBackground(): Promise<Reason | null> {
    const config = this.deps.host.launchConfig();
    if (config !== null) {
      const directory = coordinate.hostDataDir(config.dataDir);
      if (coordinate.hostIsOurs(directory, config.binary)) {
        try {
          await this.deps.host.stop();
        } catch {
          return "hostStopFailed";
        }
      }
    }
    try {
      await this.deps.runtime.stop();
    } catch {
      return "hostStopFailed";
    }
    return null;
  }

  /**
   * Whether the last restart delivered what it promised (design §2.3, R6).
   *
   * The page calls this once at startup. `null` means no update was pending,
   * which is the ordinary case and is not reported to anybody.
   */
  async restartReport(): Promise<coordinate.RestartOutcome | null> {
    const directory = dataDir();
    const pending = coordinate.readPending(directory);
    if (pending === null) return null;
    const config = this.deps.host.launchConfig();
    const outcome = coordinate.verifyRestart(pending, {
      shell: app.getVersion(),
      host:
        config === null
          ? null
          : await coordinate.probeHostVersion(config.binary, config.dataDir),
      runtime: await this.deps.runtimeVersion(),
    });
    if (outcome.outcome === "completed") coordinate.clearPending(directory);
    return outcome;
  }

  /* ---------------------------- announcements ---------------------------- */

  /**
   * Tells the tray and the person that a restart is all that is left
   * (design §4.1, last rule).
   *
   * Both announcements are best-effort: an update that is staged stays staged
   * whether or not the notification could be shown, and the settings page says
   * the same thing without either of them.
   */
  private async announceStaged(pending: Offer): Promise<void> {
    this.announce(stagedReady(pending.version));
    if (this.deps.notify === undefined) return;
    let settings: Uint8Array | string;
    try {
      settings = await this.deps.settings();
    } catch {
      settings = "";
    }
    if (!wantsNotification(settings)) return;
    const locale = localeFromEnvironment();
    this.deps.notify(
      notificationTitle(locale),
      notificationBody(locale, pending.version),
    );
  }

  /**
   * The announcement goes to the shell's own listeners — the tray W2.1 adds —
   * and no further. It reaches no renderer channel, because the IPC table of
   * design §2.2 declares no `updates:staged`: the page does not need one while
   * `autoDownload` is off, since no transfer finishes that the page did not
   * ask for. `STAGED_EVENT` is kept as the name both sides would use if that
   * ever changes.
   */
  private announce(staged: Staged): void {
    for (const listener of this.stagedListeners) listener(staged);
  }
}

/* --------------------------------- helpers -------------------------------- */

async function evaluate(verdict: HostVerdict): Promise<Event> {
  const atMs = verdict.checkedAtMs;
  if (verdict.state === "upToDate") {
    return { type: "checkedUpToDate", atMs };
  }
  if (verdict.state === "available") {
    const resolved = await resolveOffer(verdict);
    return resolved.ok
      ? { type: "checkedAvailable", offer: resolved.value }
      : {
          type: "checkRefused",
          reason: resolved.reason,
          retryAfterMs: verdict.retryAfterMs,
          atMs,
        };
  }
  // "unsupported", "unavailable" and anything this build has never heard of
  // are all "the check did not produce an answer".
  return {
    type: "checkRefused",
    reason: reasonFor(verdict.reasonCode),
    retryAfterMs: verdict.retryAfterMs,
    atMs,
  };
}

async function resolveOffer(
  verdict: HostVerdict,
): Promise<offer.Resolved<Offer>> {
  const insecure = !app.isPackaged;
  const target = offer.pointer(verdict.answer, verdict.target, insecure);
  if (!target.ok) return target;
  const manifest = await fetchManifest(target.value.url);
  if (!manifest.ok) return manifest;
  // No minisign key exists in an Electron build; the manifest's own signature
  // field is therefore not compared against one. See `offer.ts`.
  return offer.resolve(
    verdict.answer,
    target.value,
    manifest.value,
    "",
    insecure,
  );
}

/**
 * Reads the release manifest, bounded. A body that claims to be larger than a
 * manifest ever is refused before it is read, not after.
 */
async function fetchManifest(url: URL): Promise<offer.Resolved<string>> {
  const abort = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: abort, redirect: "follow" });
  } catch {
    return { ok: false, reason: "sourceUnreachable" };
  }
  if (!response.ok) return { ok: false, reason: "sourceUnreachable" };
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > offer.MANIFEST_LIMIT_BYTES) {
    return { ok: false, reason: "sourceMalformed" };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "sourceUnreachable" };
  }
  if (body.length > offer.MANIFEST_LIMIT_BYTES) {
    return { ok: false, reason: "sourceMalformed" };
  }
  return { ok: true, value: body };
}

/** The sha256 of a staged file, streamed. `null` when it could not be read. */
function digestOfFile(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * A transfer or install error as one of the stable reason tokens. The error's
 * own text is never surfaced: it carries the endpoint, and an endpoint can
 * carry a token.
 */
export function transferReason(error: unknown): Reason {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOSPC") return "diskFull";
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase();
  if (message.includes("cancelled") || message.includes("canceled")) {
    return "downloadInterrupted";
  }
  if (message.includes("sha512") || message.includes("checksum")) {
    return "digestMismatch";
  }
  if (message.includes("signature") || message.includes("code sign")) {
    return "signatureMismatch";
  }
  if (message.includes("no such file") || message.includes("enoent")) {
    return "installFailed";
  }
  if (
    message.includes("net::") ||
    message.includes("econn") ||
    message.includes("etimedout") ||
    message.includes("socket")
  ) {
    return "downloadInterrupted";
  }
  if (message.includes("404") || message.includes("not found")) {
    return "noArtifactForTarget";
  }
  if (
    message.includes("updater is not") ||
    message.includes("app-update.yml")
  ) {
    return "updaterUnavailable";
  }
  return "sourceMalformed";
}
