import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { DownloadItem, Session } from "electron";

import { DRIVE_CODES } from "../../shell-core/browser/drive";
import {
  jailMessage,
  jailWritePath,
} from "../../shell-core/browser/workspace-path";
import { CdpRefusal } from "./cdp";

/**
 * Files moving in and out of a guest: downloads the page started, and the file
 * chooser it opened.
 *
 * A download is STAGED, never saved. Bytes a page chose land in a private
 * directory with a name this shell picked, and stay there until somebody says
 * `download --accept`, which is the only thing in the browser surface that
 * writes a page's bytes into somebody's project. Rejecting deletes the staged
 * file; nothing expires on its own, because a queue that empties itself is a
 * queue that loses the thing a person was about to look at.
 */

export interface StagedDownload {
  readonly id: string;
  readonly nodeId: string;
  readonly suggestedFilename: string;
  readonly url: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly stagedPath: string;
  readonly at: string;
  state: "staging" | "ready" | "failed";
}

const staged = new Map<string, StagedDownload>();
let stagingDirectory = "";

export function configureStaging(dataDir: string): string {
  stagingDirectory = join(dataDir, "browser-staging");
  mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
  return stagingDirectory;
}

/**
 * Takes over `will-download` for one guest partition.
 *
 * Registered per partition rather than per guest because that is the object
 * Electron fires the event on. The `nodeId` is resolved at fire time from the
 * webContents that started it, so a partition shared by several nodes still
 * files each download under the node whose page asked for it.
 */
export function watchDownloads(
  guestSession: Session,
  nodeIdFor: (webContentsId: number) => string | null,
  announce: (download: StagedDownload) => void,
): void {
  if (watched.has(guestSession)) return;
  watched.add(guestSession);
  guestSession.on("will-download", (_event, item: DownloadItem, contents) => {
    const nodeId = contents ? nodeIdFor(contents.id) : null;
    if (!nodeId) {
      // A download from something this shell does not know is not something it
      // can file, and saving it somewhere anyway is the worst of both.
      item.cancel();
      return;
    }
    const id = randomUUID();
    const target = join(
      stagingDirectory,
      `${id}-${safeName(item.getFilename())}`,
    );
    item.setSavePath(target);
    const record: StagedDownload = {
      id,
      nodeId,
      suggestedFilename: safeName(item.getFilename()),
      url: item.getURL(),
      mimeType: item.getMimeType(),
      bytes: item.getTotalBytes(),
      stagedPath: target,
      at: new Date().toISOString(),
      state: "staging",
    };
    staged.set(id, record);
    item.once("done", (_done, state) => {
      record.state = state === "completed" ? "ready" : "failed";
      announce(record);
    });
    announce(record);
  });
}

const watched = new WeakSet<Session>();

/** A filename from a page, made into something that is only a filename. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 120) || "download";
}

export function stagedDownloads(nodeId: string): unknown[] {
  return [...staged.values()]
    .filter((record) => record.nodeId === nodeId)
    .map((record) => ({
      id: record.id,
      suggestedFilename: record.suggestedFilename,
      url: record.url,
      mimeType: record.mimeType,
      bytes: record.bytes,
      state: record.state,
      at: record.at,
    }));
}

export function acceptStagedDownload(
  nodeId: string,
  id: string,
  workspaceRoot: string,
): unknown {
  const record = staged.get(id);
  if (!record || record.nodeId !== nodeId) {
    throw new CdpRefusal(DRIVE_CODES.notFound, `no staged download ${id}`);
  }
  if (record.state !== "ready") {
    throw new CdpRefusal(DRIVE_CODES.refused, "that download has not finished");
  }
  const jailed = jailWritePath(
    workspaceRoot,
    join("downloads", record.suggestedFilename),
  );
  if (!jailed.ok && jailed.reason === "missingParent") {
    const directory = jailWritePath(workspaceRoot, "downloads");
    if (directory.ok) mkdirSync(directory.path, { recursive: true });
  }
  const destination = jailWritePath(
    workspaceRoot,
    join("downloads", record.suggestedFilename),
  );
  if (!destination.ok) {
    throw new CdpRefusal(DRIVE_CODES.refused, jailMessage(destination.reason));
  }
  // Copy then unlink rather than rename: the staging directory and the
  // workspace are routinely on different filesystems, and a rename that fails
  // across a device boundary would look like a refusal.
  copyFileSync(record.stagedPath, destination.path);
  const bytes = readFileSync(destination.path);
  rmSync(record.stagedPath, { force: true });
  staged.delete(id);
  return {
    path: destination.path,
    bytes: statSync(destination.path).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    suggestedFilename: record.suggestedFilename,
  };
}

export function rejectStagedDownload(nodeId: string, id: string): unknown {
  const record = staged.get(id);
  if (!record || record.nodeId !== nodeId) {
    throw new CdpRefusal(DRIVE_CODES.notFound, `no staged download ${id}`);
  }
  rmSync(record.stagedPath, { force: true });
  staged.delete(id);
  return { rejected: true, suggestedFilename: record.suggestedFilename };
}

/** Drops everything a node staged. Called when its last guest goes away. */
export function forgetNodeTransfers(nodeId: string): void {
  for (const [id, record] of staged) {
    if (record.nodeId !== nodeId) continue;
    rmSync(record.stagedPath, { force: true });
    staged.delete(id);
  }
  choosers.delete(nodeId);
}

/* ------------------------------ file choosers ------------------------------ */

export interface PendingChooser {
  readonly backendNodeId: number;
  readonly mode: string;
  readonly at: string;
  /** Marks it answered, so a second `upload` does not fill the same chooser. */
  answer(): void;
}

const choosers = new Map<string, PendingChooser>();

/** Records a `Page.fileChooserOpened`. */
export function noteChooser(
  nodeId: string,
  backendNodeId: number,
  mode: string,
): void {
  choosers.set(nodeId, {
    backendNodeId,
    mode,
    at: new Date().toISOString(),
    answer: () => choosers.delete(nodeId),
  });
}

export function pendingChooser(nodeId: string): PendingChooser | undefined {
  return choosers.get(nodeId);
}

export function clearChooser(nodeId: string): void {
  choosers.delete(nodeId);
}

/** Only for tests. */
export function resetTransfers(): void {
  for (const record of staged.values())
    rmSync(record.stagedPath, { force: true });
  staged.clear();
  choosers.clear();
}

export function describeBasename(path: string): string {
  return basename(path);
}
