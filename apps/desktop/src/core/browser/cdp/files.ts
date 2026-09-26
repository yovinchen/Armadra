import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { DRIVE_CODES, refuse } from "./codes";
import { clickAt, sleep } from "./input";
import {
  findTarget,
  hasTarget,
  label,
  pageBox,
  pointOf,
  stateOf,
} from "./locate";
import type { CdpSession } from "./session";
import type { VerbHost } from "./verbs";
import { jailMessage, jailReadPath, jailWritePath } from "./workspace-path";

/**
 * What a verb writes into, or reads out of, the workspace: screenshots, PDFs,
 * uploads. The jail (`workspace-path.ts`) is what keeps each of them inside
 * the project; the answer carries a path and a digest, never the bytes — base64
 * in a reply is a screenshot pasted into a model's context window.
 */

type Args = Record<string, unknown>;

function text(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function list(args: Args, name: string): string[] {
  const value = args[name];
  if (Array.isArray(value))
    return value.filter((e): e is string => typeof e === "string");
  return typeof value === "string" ? [value] : [];
}

/** A writable path inside the workspace, its directory created if missing. */
function writable(args: Args): string {
  const root = text(args, "workspaceRoot");
  const requested = text(args, "path");
  if (!root) refuse(DRIVE_CODES.badArgument, "没有可写入的工作区");
  if (!requested) refuse(DRIVE_CODES.badArgument, "需要 --path");
  // The directory is created BEFORE the jail check so `realpath` of the parent
  // has something to resolve — and only under a path that is already inside
  // the workspace by lexical resolution, which the jail then re-checks.
  const provisional = jailWritePath(root, requested);
  if (!provisional.ok && provisional.reason === "missingParent") {
    const lexical = jailWritePath(root, dirname(requested) || ".");
    if (lexical.ok) mkdirSync(lexical.path, { recursive: true });
  }
  const jailed = jailWritePath(root, requested);
  if (!jailed.ok) refuse(DRIVE_CODES.refused, jailMessage(jailed.reason));
  return jailed.path;
}

function written(
  path: string,
  bytes: Buffer,
): { path: string; bytes: number; sha256: string } {
  writeFileSync(path, bytes, { mode: 0o600, flag: "w" });
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const MAX_SIDE = 16_384;
/** Longest a host printer may take before `pdf` gives up on it. */
const PRINT_TIMEOUT_MS = 20_000;

export async function capture(
  session: CdpSession,
  args: Args,
): Promise<unknown> {
  const path = writable(args);
  const format = text(args, "format") === "jpeg" ? "jpeg" : "png";
  let clip:
    | { x: number; y: number; width: number; height: number; scale: number }
    | undefined;
  let beyond = false;
  let what = "";
  if (hasTarget(args)) {
    const target = await findTarget(session, args);
    if (target.point !== undefined)
      refuse(
        DRIVE_CODES.badArgument,
        "元素截图要用 --ref、--role 或 --selector",
      );
    const box = await pageBox(session, target);
    if (box.width < 1 || box.height < 1)
      refuse(DRIVE_CODES.notFound, `${label(target)} 没有可截的区域`);
    clip = {
      x: box.x,
      y: box.y,
      width: Math.min(box.width, MAX_SIDE),
      height: Math.min(box.height, MAX_SIDE),
      scale: 1,
    };
    what = label(target);
  } else if (args.fullPage === true) {
    // OUR measurement, never anything the caller sent. `captureBeyondViewport`
    // is what makes the part below the fold render at all; without it the
    // clip is the viewport's pixels stretched over a page-sized rectangle.
    const metrics = await session.layoutMetrics();
    clip = {
      x: 0,
      y: 0,
      width: Math.min(Math.ceil(metrics.contentWidth), MAX_SIDE),
      height: Math.min(Math.ceil(metrics.contentHeight), MAX_SIDE),
      scale: 1,
    };
    beyond = true;
  }
  const shot = (await session.send("Page.captureScreenshot", {
    format,
    ...(clip ? { clip } : {}),
    ...(beyond || clip !== undefined ? { captureBeyondViewport: true } : {}),
  })) as { data: string };
  const bytes = Buffer.from(shot.data, "base64");
  const viewport = session.viewport();
  return {
    ...written(path, bytes),
    width: Math.round(clip?.width ?? viewport.width),
    height: Math.round(clip?.height ?? viewport.height),
    ...(what === "" ? {} : { element: what }),
  };
}

/**
 * `pdf`. A host that prints its own way (Electron's `printToPDF`: a headed
 * guest has no CDP `Page.printToPDF`) says so through `printToPdf`; otherwise
 * the allowlisted CDP method, which returns the document inline.
 */
export async function pdf(host: VerbHost, args: Args): Promise<unknown> {
  const path = writable(args);
  const landscape = args.landscape === true;
  let bytes: Buffer;
  if (host.printToPdf !== undefined) {
    // Electron's printer never finishes a `<webview>` page that has a
    // cross-origin iframe (checked on Electron 42: the promise hangs, and the
    // app can die with it on quit). Refused up front rather than hung on;
    // the timeout is for whatever else might stall it.
    if (host.session.childFrames().length > 0)
      refuse(
        DRIVE_CODES.refused,
        "桌面浏览器节点打印不了含跨源 iframe 的页面；可以用 capture --full-page 截整页",
      );
    const printing = host.printToPdf({ landscape });
    printing.catch(() => undefined);
    bytes = await Promise.race([
      printing,
      sleep(PRINT_TIMEOUT_MS).then(() =>
        refuse(DRIVE_CODES.timeout, "打印 PDF 超时"),
      ),
    ]);
  } else {
    const answer = (await host.session.send("Page.printToPDF", {
      landscape,
      printBackground: true,
    })) as { data?: string };
    if (typeof answer.data !== "string")
      refuse(DRIVE_CODES.failed, "这个浏览器没有给出 PDF");
    bytes = Buffer.from(answer.data, "base64");
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-")
    refuse(DRIVE_CODES.failed, "这个浏览器没有给出 PDF");
  const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [])
    .length;
  return { ...written(path, bytes), pages };
}

/* -------------------------------- upload ---------------------------------- */

export async function upload(host: VerbHost, args: Args): Promise<unknown> {
  const session = host.session;
  const root = text(args, "workspaceRoot");
  if (!root) refuse(DRIVE_CODES.badArgument, "没有可读取的工作区");
  const wanted = list(args, "paths");
  if (wanted.length === 0)
    refuse(DRIVE_CODES.badArgument, "upload 需要至少一个 --path");
  if (wanted.length > 20) refuse(DRIVE_CODES.refused, "一次最多上传二十个文件");
  const paths: string[] = [];
  for (const each of wanted) {
    const jailed = jailReadPath(root, each);
    // The WHOLE batch is refused, not the offending file: a partial upload is
    // a form somebody submits believing it carries what they named.
    if (!jailed.ok) refuse(DRIVE_CODES.refused, jailMessage(jailed.reason));
    paths.push(jailed.path);
  }

  // A chooser the page ALREADY opened is answered directly.
  const open = host.pendingChooser();
  if (open) return answerChooser(host, open.backendNodeId, paths);

  // Otherwise the input is clicked so the page opens one. `Page.fileChooser
  // Opened` carries the backend node id for the element the page itself asked
  // about, which is a much narrower thing to be given than a DOM read.
  if (!hasTarget(args))
    refuse(
      DRIVE_CODES.badArgument,
      "页面没有打开文件选择框；请用 --ref 指明文件输入框",
    );
  const target = await findTarget(session, args);
  const point = await pointOf(session, target);
  if (target.node !== undefined) {
    const state = await stateOf(session, target);
    if (!state.accepts && target.role !== "button")
      refuse(DRIVE_CODES.refused, `${label(target)} 不是文件输入框`);
  }
  await clickAt(session, point);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chooser = host.pendingChooser();
    if (chooser) return answerChooser(host, chooser.backendNodeId, paths);
    await sleep(100);
  }
  refuse(DRIVE_CODES.notFound, `点了 ${label(target)} 之后没有出现文件选择框`);
}

async function answerChooser(
  host: VerbHost,
  backendNodeId: number,
  paths: string[],
): Promise<unknown> {
  await host.session.send("DOM.setFileInputFiles", {
    files: paths,
    backendNodeId,
  });
  host.clearChooser();
  // File NAMES, never the paths: the reply goes into a model's context, and
  // the absolute path of somebody's project is not something a page's form
  // needed in order to be filled in.
  return { answeredChooser: true, paths: paths.map((each) => basename(each)) };
}
