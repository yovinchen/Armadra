import { expectedProcesses, paneRunsAgent } from "../../agent/launch";
import { baseAgent } from "../../agent/registry";
import { getContextLinks } from "../../canvas/context-links";
import { AddressError, loadHandles, resolveLink } from "../addressing";
import { type Caller, loadNode, loadSession, workspaceRoot } from "../nodes";
import { type Args, Refused, nonce } from "../refusals";
import type { CollabContext } from "../service";
import { type Outcome, result } from "./outcome";

/**
 * `interrupt` — the one thing an agent may still write into a peer's terminal.
 *
 * Ported from `apps/runtime/src/collab/control/interrupt.rs`. It carries no
 * text. The whole payload is `ESC`, which is what a person reaches for when a
 * CLI has gone down the wrong path: it stops the turn and leaves the session
 * exactly where it was. Nothing about the peer's work is replaced, nothing is
 * submitted, and there is no way to smuggle a sentence through it — the byte
 * is a constant in this file.
 *
 * That is why it survives the removal of `send` / `reply` / `notify` while
 * they do not. Those wrote a *message* somebody else's agent would read as
 * input; this writes a keystroke whose only meaning is "stop".
 *
 * There is no idle gate. Interrupting a *busy* agent is the entire point, and
 * an agent that is not busy loses nothing: `ESC` at an idle prompt is a no-op.
 * The pane gate stays, though — the foreground has to still be the agent we
 * think it is, or the keystroke lands in whatever replaced it.
 */

/**
 * The keystroke. A constant rather than an argument: the moment this takes
 * text from the caller it stops being an interrupt and becomes the delivery
 * primitive that was removed.
 */
const ESCAPE = "\u001b";

export async function interrupt(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const wanted = args.text("to") ?? args.text("node");
  if (wanted === undefined) {
    throw new Refused(
      400,
      "bad_request",
      "interrupt 需要 --to <已连线节点的 id、短名或标题>。",
    );
  }

  // The caller's own link document, exactly as the mailbox reads it: a node
  // that exists on the board but has no edge to the caller is refused as a
  // permission answer, not as "not found".
  const links = getContextLinks(context.database, caller.node.id).links;
  const handles = loadHandles(context.database, links);
  let link;
  try {
    link = resolveLink(links, handles, wanted);
  } catch (error) {
    if (error instanceof AddressError) {
      throw new Refused(
        error.status,
        error.code,
        error.refusal("--to").message,
      );
    }
    throw error;
  }

  const target = loadNode(context.database, link.id);
  if (target === undefined || target.workspaceId !== caller.node.workspaceId) {
    throw new Refused(
      403,
      "target_not_linked",
      "这个链接指向的节点不在当前工作空间，已拒绝。",
    );
  }
  if (target.id === caller.node.id) {
    throw new Refused(400, "bad_request", "不能打断你自己。");
  }
  if (target.nodeType !== "terminal") {
    throw new Refused(
      400,
      "target_not_terminal",
      `「${target.title}」不是终端节点，没有可以打断的东西。`,
    );
  }

  const session = loadSession(context.database, target.id);
  if (session === undefined || session.status !== "running") {
    throw new Refused(
      404,
      "target_gone",
      `「${target.title}」没有在运行的终端会话。`,
    );
  }

  // The pane gate. Not an idle gate: a busy agent is exactly who this is for.
  // What it checks is that the foreground is still the agent this node claims
  // to run, so an `ESC` cannot land in whatever the user started instead.
  if (target.agentId !== null) {
    const expected = expectedProcesses(
      baseAgent(context.settings, target.agentId),
    );
    const foreground = await context.terminals
      ?.foreground(session.sessionId)
      .catch(() => undefined);
    if (foreground === undefined || !paneRunsAgent(foreground, expected)) {
      throw new Refused(
        409,
        "target_not_agent_pane",
        `「${target.title}」的终端当前没有在跑 ${target.agentId}，没有发送打断。`,
      );
    }
  }

  if (args.flag("dry-run")) {
    return result(`（演练）会向「${target.title}」发送一次打断。`, {
      dryRun: true,
      id: target.id,
      title: target.title,
    });
  }

  if (context.terminals === undefined) {
    throw new Refused(
      503,
      "internal_error",
      "终端域还没有装配好，无法发送打断。",
    );
  }
  try {
    await context.terminals.write(
      session.sessionId,
      session.generation,
      ESCAPE,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Refused(500, "internal_error", `画布操作失败：${message}`);
  }

  // Traced like every other reach into somebody else's node. `bodyChars` is
  // zero because there is no body — that is the claim worth recording.
  const traced = context.boardLog.record(
    workspaceRoot(context.database, caller.node.workspaceId),
    {
      traceId: nonce(16),
      source: caller.node.id,
      target: target.id,
      outcome: "interrupted",
      receipt: "escape",
      bodyChars: 0,
    },
  );
  return result(`已向「${target.title}」发送一次打断（Escape）。`, {
    id: target.id,
    title: target.title,
    traced,
  });
}
