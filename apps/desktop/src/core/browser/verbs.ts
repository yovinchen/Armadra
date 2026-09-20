import { randomUUID } from "node:crypto";
import { hasCapability } from "../agent/registry";
import type { ContextLink } from "../canvas/context-links";
import { getContextLinks } from "../canvas/context-links";
import { type Caller, type NodeRef, loadNode } from "../collab/nodes";
import { Args, Refusal, asRefused } from "../collab/refusals";
import { rfc3339 } from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import type { Workspace } from "../workspaces/table";
import {
  type ArgSource,
  VERBS,
  describeTarget,
  needsLease,
  shellArgs,
  withWorkspace,
} from "./args";
import { unavailable } from "./client";
import type { BrowserContext } from "./context";
import { LEASE_REVOKED, agentActor, humanActor } from "./lease";
import type { Activity } from "./model";
import { render, renderLease } from "./render";
import { type BrowserSessionHandle, ensureSession } from "./session";

/**
 * `POST /browser/{verb}` — an agent drives a browser node it is linked to.
 *
 * Ported from the pre-merge implementation. Three rules, all of
 * them checks rather than conventions:
 *
 *   * **Only a linked node.** The target must appear in the caller's own
 *     context-link document — the picture the user is looking at — and it must
 *     be a `browser` node in the caller's workspace. Holding the app bearer is
 *     not enough, and neither is knowing a session id.
 *   * **The same session as the human.** There is no agent-only browser. The
 *     verb resolves the node's live session and drives that, so a person can
 *     watch what the agent did and take over by clicking.
 *   * **A closed verb list.** Seventeen of them, listed in {@link VERBS}. No
 *     `eval`, no CDP method name, no selector that becomes code, and no verb
 *     that ends the session — closing a node is not the same as closing a
 *     page.
 *
 * Replies are prose because the reader is a model reading its own stdout,
 * exactly like the context-link surface.
 */

export async function runBrowserVerb(
  context: BrowserContext,
  caller: Caller,
  verb: string,
  source: ArgSource,
): Promise<string> {
  if (!VERBS.includes(verb)) {
    throw Refusal.badRequest(
      `未知的浏览器动词 \`${verb}\`，可用：${VERBS.join(" / ")}。`,
    );
  }
  // Every verb here changes or reads a real page, so a token this core did not
  // mint is never enough.
  if (caller.verdict !== "verified") {
    throw Refusal.forbidden(
      `\`${verb}\` 需要本运行时签发的节点令牌；这个终端没有，已拒绝。`,
    );
  }
  if (!capabilityAllowed(context, caller.node.agentId)) {
    throw Refusal.forbidden(
      "这个 Agent 的 `browser` 能力已被禁用，浏览器动词不可用。",
    );
  }

  const args = new Args(source);
  const links = getContextLinks(context.database, caller.node.id).links;
  const link = resolveBrowserLink(links, args.text("node"));
  const target = loadNode(context.database, link.id);
  if (target === undefined) {
    throw Refusal.notFound(
      `链接的浏览器节点「${link.title}」已经不在画布上了。`,
    );
  }
  if (target.workspaceId !== caller.node.workspaceId) {
    throw Refusal.forbidden(`「${target.title}」不在当前工作空间，已拒绝。`);
  }
  if (target.nodeType !== "browser") {
    throw Refusal.badRequest(
      `「${target.title}」不是浏览器节点，\`browser\` 动词只能操作浏览器节点。`,
    );
  }

  const workspace = readableWorkspace(context, target.workspaceId);

  // The three rules above are the whole of the authorization. What is left is
  // WHERE the page is, and there is only one answer: a guest of the desktop
  // window. A core with no shell answers `browser_unavailable` rather than
  // starting a browser nobody can see.
  return viaShell(context, caller, verb, source, target, workspace);
}

/**
 * The same seventeen verbs, executed in the desktop shell.
 *
 * Everything that decides WHETHER this may happen already happened: the caller
 * is verified, the node is linked, in this workspace, and a browser. What is
 * left is the lease — which stays here, because it is a fact about people and
 * agents rather than about pages — and one narrow send.
 */
async function viaShell(
  context: BrowserContext,
  caller: Caller,
  verb: string,
  source: ArgSource,
  target: NodeRef,
  workspace: Workspace,
): Promise<string> {
  const args = new Args(source);
  const url = typeof target.data.url === "string" ? target.data.url : "";
  const session = ensureSession(
    context.sessions,
    context,
    target.id,
    target.workspaceId,
    url,
  );

  // Two verbs whose whole meaning is in a flag. Refusing here rather than
  // defaulting: "dismiss" and "accept" are not the same thing to a person
  // whose page is holding a dialog open, and neither is a safe guess.
  if (
    verb === "dialog" &&
    !args.flag("accept") &&
    !args.flag("dismiss") &&
    !args.flag("reject")
  ) {
    throw Refusal.badRequest(
      "请给出 --accept 或 --dismiss；对话框不会自己消失。",
    );
  }
  if (
    verb === "download" &&
    args.text("id") !== undefined &&
    !args.flag("accept") &&
    !args.flag("reject") &&
    !args.flag("decline")
  ) {
    throw Refusal.badRequest("要处理一个下载，请给出 --accept 或 --reject。");
  }

  const actor = agentActor(
    caller.node.id,
    session.sessionId,
    caller.node.title,
  );
  if (needsLease(verb, source)) {
    try {
      await session.acquire(actor);
    } catch (error) {
      const message = asRefused(error).message;
      session.recordActivity(
        activity(
          session.sessionId,
          caller.node.id,
          verb,
          describeTarget(source),
          "refused",
          message,
        ),
      );
      throw error;
    }
  }

  let answer: string | undefined;
  let failure: string | undefined;
  let thrown: unknown;
  try {
    // `lease` never reaches the shell. There is nothing on a page for it to
    // do: it is a question about who may drive, answered here.
    if (verb === "lease") {
      answer = args.flag("release")
        ? `已交还租约。${renderLease(session.release(actor))}`
        : renderLease(session.leaseSnapshot());
    } else {
      const payload = withWorkspace(
        shellArgs(verb, source),
        workspace.rootPath,
      );
      const result = await drive(context, target.id, verb, payload);
      answer = render(verb, source, result);
    }
  } catch (error) {
    thrown = error;
    failure = asRefused(error).message;
  }

  trace(context, workspace.rootPath, caller.node.id, target.id, verb, failure);
  session.recordActivity(
    activity(
      session.sessionId,
      caller.node.id,
      verb,
      describeTarget(source),
      failure === undefined ? "ok" : "refused",
      failure ?? "",
    ),
  );
  // The original error is re-thrown rather than a fresh one built from its
  // message: the status a refusal carries is part of the answer, and the
  // activity ring and the board log above had to be written first either way.
  if (failure !== undefined) throw thrown;
  return answer ?? "";
}

async function drive(
  context: BrowserContext,
  nodeId: string,
  verb: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const client = context.client;
  if (client === undefined) throw unavailable();
  return client.drive(nodeId, verb, payload);
}

function activity(
  sessionId: string,
  nodeId: string,
  verb: string,
  target: string,
  outcome: "ok" | "refused",
  reason: string,
): Activity {
  // The badge localizes a stable code; a whole refusal message would be prose
  // in one language sitting in a chip.
  const head = reason.split(":")[0] ?? "";
  return {
    sessionId,
    actor: "agent",
    actorId: nodeId,
    verb,
    target,
    outcome,
    reasonCode: head.startsWith("LEASE_") ? head : "",
    at: rfc3339(),
  };
}

function capabilityAllowed(
  context: BrowserContext,
  agentId: string | null,
): boolean {
  // A plain terminal is a person at a shell, not an agent with a capability
  // list; the human half of "人与 Agent 共用会话".
  if (agentId === null) return true;
  return hasCapability(context.settings, agentId, "browser");
}

/** The linked browser node this verb should act on. */
export function resolveBrowserLink(
  links: readonly ContextLink[],
  wanted: string | undefined,
): ContextLink {
  const browsers = links.filter((link) => link.kind === "browser");
  if (browsers.length === 0) {
    throw Refusal.forbidden(
      "这个节点没有连接任何浏览器节点。在画布上把它连到一个浏览器节点后再试。",
    );
  }
  if (wanted === undefined) {
    if (browsers.length === 1) return browsers[0]!;
    throw Refusal.badRequest(
      `这个节点连接了 ${browsers.length} 个浏览器节点，请用 --node 指明要操作哪一个。`,
    );
  }
  const asked = wanted.trim();
  const byId = browsers.find((link) => link.id === asked);
  if (byId !== undefined) return byId;
  const lowered = asked.toLowerCase();
  const matches = browsers.filter(
    (link) => link.title.toLowerCase() === lowered,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    // A node that is not linked and a node that does not exist get the SAME
    // sentence. A refusal that told them apart would turn the verb into a
    // probe for what is on somebody else's canvas.
    throw Refusal.notFound(`连接的浏览器节点里没有叫「${asked}」的。`);
  }
  throw Refusal.badRequest(
    `有 ${matches.length} 个连接的浏览器节点叫「${asked}」，请用节点 ID。`,
  );
}

/**
 * A browser node reads and writes inside its workspace (screenshots and
 * downloads), so read permission is the floor for every verb here.
 */
export function readableWorkspace(
  context: BrowserContext,
  workspaceId: string,
): Workspace {
  const workspace = getWorkspace(context.database, workspaceId);
  if (!workspace.permissions.read) {
    throw Refusal.forbidden("This workspace is not readable");
  }
  return workspace;
}

function trace(
  context: BrowserContext,
  workspaceRoot: string,
  sourceNode: string,
  targetNode: string,
  verb: string,
  failure: string | undefined,
): void {
  context.boardLog.record(workspaceRoot, {
    traceId: randomUUID(),
    source: sourceNode,
    target: targetNode,
    outcome: `browser.${verb}`,
    ...(failure === undefined ? {} : { receipt: failure }),
    bodyChars: 0,
  });
}

/* ------------------------------ the human side ---------------------------- */

/**
 * What the shell's `control` event means: a person pressed "take over" or
 * handed the page back.
 *
 * Exported because the event handler and the verb surface must agree on who
 * "the person at this machine" is, and that is a single actor rather than a
 * convention repeated in two files.
 */
export function localHuman(displayName = ""): ReturnType<typeof humanActor> {
  return humanActor("local", displayName);
}

export { LEASE_REVOKED };

/** The handle a session lookup returns, re-exported for the event handler. */
export type { BrowserSessionHandle };
