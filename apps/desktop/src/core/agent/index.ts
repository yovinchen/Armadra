import { parseCustomAgents } from "../settings/custom-agents";
import { settingsDomain } from "../settings";
import {
  createControlDispatcher,
  setControlDispatcher,
} from "../collab/control";
import { runContextLink } from "../collab/context-link";
import { SendPump } from "../collab/send-pump";
import { installCollaborationSkill } from "../collab/skill";
import type { Caller } from "../collab/nodes";
import { Args } from "../collab/refusals";
import {
  type CollabContext,
  type TerminalBridge,
  collabContext,
} from "../collab/service";
import { eventStream } from "../events";
import type { CoreContext } from "../main";
import {
  authorizeMailboxAck,
  noteAcknowledged,
  readForCaller,
} from "../handoff/store";
import { ContextUsageCache } from "../usage/context-usage";
import { ORPHAN_MINUTES, pendingDir, sweepOrphans } from "./approvals";
import { armProbeSweep } from "./probe";
import { installRoutes } from "./routes";
import { installHookBridge } from "./hook-bridge";

/**
 * The agent domain's assembly point — agent status, approvals, collaboration,
 * handoff, the conversations index and context usage.
 *
 * Three things are published from here rather than registered as routes,
 * because the Hook surface (its own domain, its own credentials, its own body
 * limit) is what receives them from an agent CLI and this is what decides what
 * they may do:
 *
 *   * {@link import("../collab/control").ControlDispatcher} — the thirteen
 *     canvas verbs;
 *   * {@link contextLinkReader} — `context list | summary | transcript |
 *     terminal`;
 *   * {@link contextUsageCache} — where a provider's live window report lands.
 *
 * The terminal bridge is the other direction: this domain needs a PTY for
 * `interrupt`, `close`, the terminal read and the title suggestion, and it
 * gets one from R2 through {@link setTerminalBridge} rather than by importing
 * the manager. A build with no terminal domain still answers every route; the
 * verbs that need a pane refuse with a sentence instead of throwing.
 */

let assembled: CollabContext | undefined;
const usage = new ContextUsageCache();

/**
 * 出队泵（设计 `agent-delivery.md` §4.6）。上下文现取，因为
 * `setTerminalBridge` 之后它整个是一个新对象。
 */
const pump = new SendPump(() => assembled);

/** 待投队列的出队泵，供用例与装配点使用。 */
export function sendPump(): SendPump {
  return pump;
}

/** The collaboration context of the running core, for the Hook domain. */
export function collab(): CollabContext | undefined {
  return assembled;
}

/** Where a provider's live context-window report lands. */
export function contextUsageCache(): ContextUsageCache {
  return usage;
}

/**
 * Runs one context-link verb. The Hook surface authenticates, then calls this.
 *
 * Prose in, prose out: the client prints the body verbatim, so a refusal is
 * one readable sentence and nothing else.
 */
export async function contextLinkReader(
  caller: Caller,
  verb: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const context = assembled;
  if (context === undefined) throw new Error("agent domain is not assembled");
  return runContextLink(context, caller, verb, new Args(args));
}

/**
 * Hands the terminal domain's PTY operations to the collaboration verbs.
 *
 * Called by R2 after it builds its manager. Kept mutable rather than required
 * at install time because the two domains are installed in sequence and this
 * one is installed first — the routes have to exist before a terminal does.
 */
let terminals: TerminalBridge | undefined;

export function setTerminalBridge(bridge: TerminalBridge | undefined): void {
  terminals = bridge;
  if (assembled !== undefined) {
    assembled = { ...assembled, terminals: bridge };
    setControlDispatcher(createControlDispatcher(assembled));
  }
}

export function install(context: CoreContext): CollabContext {
  const collabState = collabContext({
    database: context.db.database,
    // Read through the settings store on every call rather than snapshotted:
    // a custom Agent whose `contextLink` the user just switched off must stop
    // being readable now, not at the next restart.
    settings: {
      customAgents: () =>
        parseCustomAgents(settingsDomain()?.settings.snapshot() ?? {}),
    },
    publish: (workspaceId, event) => {
      context.bus.emit("workspace.event", { workspaceId, event });
    },
    // `close` is the only verb that needs an audience count, and it needs the
    // real one: a dialog nobody can see is a two-minute wait for nothing.
    audience: (workspaceId) => eventStream()?.subscriberCount(workspaceId) ?? 0,
    terminals,
    dataDir: context.dataDir,
  });
  const withHandoff: CollabContext = {
    ...collabState,
    handoff: {
      authorizeMailboxAck: (caller, handoffId, sessionId, generation) =>
        authorizeMailboxAck(
          withHandoff,
          caller,
          handoffId,
          sessionId,
          generation,
        ),
      noteAcknowledged: (mailboxId) => noteAcknowledged(withHandoff, mailboxId),
    },
    handoffReader: (caller, handoffId, sessionId, generation) =>
      readForCaller(withHandoff, caller, handoffId, sessionId, generation),
  };
  assembled = withHandoff;
  setControlDispatcher(createControlDispatcher(withHandoff));
  installRoutes({ server: context.server, collab: withHandoff, usage });
  // The hook surface authenticates; these two families answer.
  installHookBridge(context.db.database, contextLinkReader);
  // The skill half of the install unit (docs/design/agent-integration.md §2).
  // The body describes *these* verbs, so this domain owns it; the hook domain
  // only knows where the file goes. Registered at assembly rather than
  // imported by the installer, so a build with no collaboration domain writes
  // no skill instead of writing one that promises verbs nobody answers.
  installCollaborationSkill();

  // 出队挂在 `agent.status` 的发布点上，不轮询（§4.6）。同一条事件回答两个
  // 问题：谁的一轮结束了（扇出计数清零），以及谁空出来了（该出队了）。
  context.bus.on("workspace.event", ({ event }) => {
    if (event.type === "agent.status") {
      const status = event.status as { nodeId?: unknown; state?: unknown };
      const nodeId = typeof status.nodeId === "string" ? status.nodeId : "";
      const state = typeof status.state === "string" ? status.state : undefined;
      pump.noteStatus(nodeId, state);
      return;
    }
    // 租约放开也是一次「现在可以投了」。人抢占之后停手十秒，租约自己过期并广播
    // 一帧 `free`——而目标那一侧此时什么状态都不会再报（它本来就空闲着）。没有
    // 这一条，「停手十秒后自动投进去」就会等一个永远不来的状态事件。
    if (event.type !== "terminal.lease") return;
    const lease = event.lease as { state?: unknown };
    if (lease.state !== "free") return;
    if (typeof event.nodeId !== "string") return;
    pump.noteFree(event.nodeId);
  });
  pump.start();

  // A client that was killed mid-wait leaves a pending request and its answer
  // behind, and they contain the tool call the agent wanted to make.
  const removed = sweepOrphans(
    pendingDir(withHandoff),
    ORPHAN_MINUTES * 60_000,
  );
  if (removed > 0) {
    context.log.info("cleared orphaned permission requests", { removed });
  }

  // CLI 版本探测（Agent 自动化设计 §1）。装配一步都不等它：武装一个 `unref` 的
  // 定时器，扫描在后台跑，`GET /api/agents` 读的永远是缓存。一次探不到只是少一
  // 条缓存——那一条本身就是「问过了，问不出来」，而那正是 §1 要的答案。
  armProbeSweep((error) => {
    context.log.warn("could not probe the agent CLIs", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return withHandoff;
}

export { ContextUsageCache } from "../usage/context-usage";
export type { CollabContext } from "../collab/service";
