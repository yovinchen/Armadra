import { rfc3339 } from "../../workspaces/support";
import { type Caller, loadSession } from "../nodes";
import { type Args, Refusal, nonce } from "../refusals";
import type { CollabContext } from "../service";
import { load, resolveOnBoard, save } from "./board";
import { type Outcome, result } from "./outcome";

/**
 * `close`, and the human confirmation it waits for.
 *
 * Ported from `apps/runtime/src/collab/control/close.rs`. This is the one
 * destructive verb, so it never runs on the agent's word alone: the canvas
 * gets a `control.confirm` frame, a human answers it, and only then does the
 * node leave the board and its PTY get destroyed.
 *
 * Everything is re-derived *after* the wait. 130 seconds is long enough for
 * the board to have moved on, and acting on the pre-wait snapshot would
 * resurrect whatever changed in between.
 */

/**
 * How long a `close` waits for a human. The hook client's own wait is longer,
 * so a refusal always reaches the agent as a sentence rather than as a dropped
 * connection.
 */
export const CONFIRM_TIMEOUT_SECS = 130;

interface Pending {
  readonly settle: (approve: boolean) => void;
}

/**
 * The verbs waiting on a human verdict, keyed by request id.
 *
 * Module state rather than a field on the context: one core serves one data
 * directory, the map never outlives the process, and putting it on the
 * context would mean every fixture had to carry one.
 */
const confirms = new Map<string, Pending>();

/**
 * Answers a pending confirmation. `false` means nothing was waiting any more:
 * the verb already timed out, or the id was never minted.
 */
export function answerConfirm(requestId: string, approve: boolean): boolean {
  const pending = confirms.get(requestId);
  if (pending === undefined) return false;
  confirms.delete(requestId);
  pending.settle(approve);
  return true;
}

/** For the tests: how many verbs are waiting right now. */
export function pendingConfirms(): number {
  return confirms.size;
}

export async function close(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const document = load(context, caller);
  const wanted = args.text("node");
  if (wanted === undefined) {
    throw Refusal.badRequest("close 需要 --node <节点 id 或标题>。");
  }
  const target = resolveOnBoard(document, wanted);
  const targetId = target.id;
  const title = target.title;
  if (targetId === caller.node.id) {
    throw Refusal.badRequest("不能关闭你自己所在的节点；请让用户手动关闭。");
  }

  const summary =
    `「${caller.node.title}」请求关闭节点「${title}」（${target.type}）。` +
    "终端会被销毁，节点会从画布上移除。";
  if (args.flag("dry-run")) {
    return result(`（演练）会请用户确认关闭「${title}」。`, {
      dryRun: true,
      id: targetId,
      title,
      summary,
    });
  }

  const requestId = nonce(16);
  const verdict = await requestConfirmation(context, caller, {
    requestId,
    targetId,
    summary,
  });
  if (verdict === "no-audience") {
    throw Refusal.forbidden("界面没有连接到这个工作空间，close 无法获得确认。");
  }
  if (verdict === "denied") {
    throw Refusal.forbidden(`用户拒绝了关闭「${title}」。`);
  }
  if (verdict === "timeout") {
    throw Refusal.forbidden(
      `等待用户确认超过 ${CONFIRM_TIMEOUT_SECS} 秒，关闭「${title}」已取消。`,
    );
  }

  // The PTY first: a node that is gone from the board can no longer be
  // reached, so a session left running would be unreachable rather than merely
  // orphaned.
  const session = loadSession(context.database, targetId);
  if (session !== undefined && context.terminals !== undefined) {
    await context.terminals
      .terminate(session.sessionId, "session")
      .catch(() => {
        // Already gone. Removing the node is still the right thing to do.
      });
  }

  const after = load(context, caller);
  const existed = after.nodes.some((node) => node.id === targetId);
  const nodes = after.nodes
    .filter((node) => node.id !== targetId)
    // Members of a closed group outlive it; only the frame goes away.
    .map((node) =>
      node.parentId === targetId ? stripParent(node, rfc3339()) : node,
    );
  const edges = after.edges.filter(
    (edge) => edge.source !== targetId && edge.target !== targetId,
  );
  save(context, caller, { ...after, nodes, edges });
  return result(
    existed
      ? `用户已确认，「${title}」已关闭。`
      : `用户已确认，但「${title}」在等待期间已经不在画布上了。`,
    { id: targetId, title, closed: existed },
  );
}

function stripParent(
  node: import("../../canvas/document-types").CanvasNode,
  updatedAt: string,
): import("../../canvas/document-types").CanvasNode {
  const copy = { ...node, updatedAt } as Record<string, unknown>;
  delete copy.parentId;
  return copy as unknown as import("../../canvas/document-types").CanvasNode;
}

type Verdict = "approved" | "denied" | "timeout" | "no-audience";

/**
 * Publishes the dialog and waits.
 *
 * Nobody watching the workspace means nobody can confirm: say so now instead
 * of holding the agent for two minutes on a dialog that will never be drawn.
 */
function requestConfirmation(
  context: CollabContext,
  caller: Caller,
  options: {
    readonly requestId: string;
    readonly targetId: string;
    readonly summary: string;
  },
): Promise<Verdict> {
  if (context.audience(caller.node.workspaceId) === 0) {
    return Promise.resolve("no-audience");
  }
  return new Promise<Verdict>((resolve) => {
    let settled = false;
    const finish = (verdict: Verdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      confirms.delete(options.requestId);
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish("timeout"),
      CONFIRM_TIMEOUT_SECS * 1000,
    );
    // Node keeps the process alive for a pending timer; a core shutting down
    // while an agent waits must not be held open by this one.
    timer.unref?.();
    confirms.set(options.requestId, {
      settle: (approve) => finish(approve ? "approved" : "denied"),
    });
    context.publish(caller.node.workspaceId, {
      type: "control.confirm",
      requestId: options.requestId,
      verb: "close",
      nodeId: options.targetId,
      summary: options.summary,
    });
  });
}
