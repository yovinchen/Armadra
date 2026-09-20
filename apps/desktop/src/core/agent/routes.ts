import type { CoreServer } from "../http/server";
import { answerConfirm } from "../collab/control";
import { cancelQueued, listDeliveries, listQueued } from "../collab/deliveries";
import { nowSeconds, type CollabContext } from "../collab/service";
import { getAgentStatus, markAgentStatusRead } from "./status";
import {
  MAX_TAIL_BYTES,
  MAX_RENDERED_BYTES,
  locate,
  readTail,
  render,
} from "../collab/transcript";
import {
  commandFromCapture,
  configuredScope,
  ensureIndexed,
  listConversations,
  refresh,
  transcriptTitle,
  DEFAULT_LIMIT,
} from "../conversations";
import { definition, baseAgent } from "./registry";
import { listAgents } from "./list";
import { loadSession } from "../collab/nodes";
import { listContextReads } from "../collab/context-reads";
import {
  type ConfirmRequest,
  accept,
  cancel,
  get as getHandoff,
  list as listHandoffs,
  listWorkspace,
  prepare,
  type PrepareRequest,
} from "../handoff/store";
import {
  DomainError,
  badRequest,
  jsonObject,
  notFound,
  optionalString,
} from "../workspaces/support";
import { answerApproval } from "./approvals";
import { audit } from "../identity/audit";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";

/**
 * The runtime-surface routes the agent, collaboration, handoff and
 * conversation domains own.
 *
 * The hook surface is not here: `POST /control/{verb}`, `/context-link/{verb}`
 * and the automation doors belong to the Hook domain, which authenticates the
 * caller and then hands the already-authenticated verb to the
 * {@link import("../collab/control").ControlDispatcher} this domain publishes.
 * Splitting it that way is what keeps a route from ever being a weaker door
 * than the verb behind it.
 */

/** `GET /api/nodes/{id}/context-reads` 不带 `limit` 时给这么多条。 */
const DEFAULT_CONTEXT_READS = 20;
/** 带了也最多给这么多条：这一栏是节点头上的一个小清单，不是审计导出。 */
const MAX_CONTEXT_READS = 200;

export interface AgentRouteDeps {
  readonly server: CoreServer;
  readonly collab: CollabContext;
}

export function installRoutes(deps: AgentRouteDeps): void {
  const { server, collab } = deps;
  const database = collab.database;

  /* --------------------------------- agents ------------------------------- */

  // The new-node menu, the command palette, the settings pages and the node
  // header all read this one list. Without it the canvas can still open a
  // plain terminal and nothing else: an empty list is not a degraded menu, it
  // is a build with no agents in it.
  server.router.handle(
    "GET",
    "/api/agents",
    answered(() => ({
      status: 200,
      body: listAgents({
        dataDir: collab.dataDir,
        settings: collab.settings,
      }),
    })),
  );

  /* ------------------------------ agent status ---------------------------- */

  server.router.handle(
    "POST",
    "/api/agent-status/{nodeId}/read",
    answered((match) => {
      const nodeId = param(match, "nodeId");
      const receipt = markAgentStatusRead(database, nodeId);
      if (receipt === undefined) {
        throw notFound("This node has never reported");
      }
      // A read that changed nothing is answered but not broadcast:
      // re-announcing an unchanged row would put one pointless frame on every
      // workspace socket per finished turn.
      if (receipt.cleared) {
        collab.publish(receipt.status.workspaceId, {
          type: "agent.status",
          status: receipt.status as unknown as Record<string, unknown>,
        });
      }
      return { status: 200, body: receipt.status };
    }),
  );

  server.router.handle(
    "GET",
    "/api/agent-status/{nodeId}/transcript",
    answered((match, request) => {
      const nodeId = param(match, "nodeId");
      const status = getAgentStatus(database, nodeId);
      if (status === undefined) throw notFound("This node has never reported");
      const provider = baseAgent(collab.settings, status.agentId);
      const located = locate(provider, status.transcriptPath, status.sessionId);
      // A provider that keeps nothing readable is **501, not an empty body**.
      // An empty excerpt would be indistinguishable from a session that has
      // said nothing yet, and the panel would draw the blank as the truth.
      if (located === undefined) {
        throw unsupported(
          `${provider} keeps no transcript this machine can read`,
        );
      }
      const wanted = Number.parseInt(request.query.get("maxBytes") ?? "", 10);
      const budget = Number.isFinite(wanted)
        ? Math.min(MAX_TAIL_BYTES, Math.max(1, wanted))
        : MAX_TAIL_BYTES;
      let text: string;
      try {
        text = readTail(located.path, budget);
      } catch {
        throw notFound("The transcript could not be read");
      }
      const lines = render(text);
      if (lines.length === 0) {
        throw unsupported(
          `The file ${provider} reports is not a conversation this reader renders`,
        );
      }
      const rendered = lines.join("\n");
      const truncated =
        Buffer.byteLength(rendered, "utf8") > MAX_RENDERED_BYTES;
      return {
        status: 200,
        body: {
          nodeId,
          text: truncated ? cutBytes(rendered, MAX_RENDERED_BYTES) : rendered,
          truncated,
        },
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/agent-status/{nodeId}/suggest-title",
    answeredAsync(async (match) => {
      const nodeId = param(match, "nodeId");
      const status = getAgentStatus(database, nodeId);
      if (status === undefined) throw notFound("This node has never reported");

      // Three sources, best first: what the session is *about*, then what was
      // last typed in the pane, then the agent's own label — which is always
      // available and never wrong. No model is called: this is a rename
      // button, and a local read answers it in milliseconds.
      if (status.transcriptPath !== undefined) {
        const title = transcriptTitle(status.agentId, status.transcriptPath);
        if (title !== undefined) {
          return { status: 200, body: { title, source: "transcript" } };
        }
      }
      // The node's terminal keeps its logical key across recycles, so the
      // lookup is by node id rather than by the session id the status row
      // happens to remember.
      const session = loadSession(database, nodeId);
      if (session !== undefined && collab.terminals !== undefined) {
        const capture = await collab.terminals
          .capture(session.sessionId, 40, false)
          .catch(() => undefined);
        const title =
          capture === undefined ? undefined : commandFromCapture(capture.data);
        if (title !== undefined) {
          return { status: 200, body: { title, source: "terminal" } };
        }
      }
      return {
        status: 200,
        body: {
          title: definition(status.agentId)?.label ?? status.agentId,
          source: "agent",
        },
      };
    }),
  );

  /* -------------------------------- approvals ----------------------------- */

  server.router.handle(
    "POST",
    "/api/approvals/{pendingId}/answer",
    answeredAsync(async (match, request) => {
      const body = jsonObject(request.body);
      const decision = optionalString(body, "decision");
      if (decision === undefined) throw badRequest("decision is required");
      const expected = body.expectedRevision;
      if (
        expected !== undefined &&
        expected !== null &&
        typeof expected !== "number"
      ) {
        throw badRequest("expectedRevision must be a number");
      }
      const { approval, route } = await answerApproval(
        collab,
        param(match, "pendingId"),
        {
          decision,
          ...(optionalString(body, "answeredBy") === undefined
            ? {}
            : { answeredBy: optionalString(body, "answeredBy") as string }),
          ...(typeof expected === "number"
            ? { expectedRevision: expected }
            : {}),
        },
      );
      // 审批答复是设计 §4.5 的五个审计写入点之一：一次「允许」可能让 Agent 动
      // 到磁盘，事后必须查得到是谁在什么时候答的。
      audit({
        action: "approval.answer",
        target: param(match, "pendingId"),
        detail: { decision },
      });
      return { status: 200, body: { ...approval, route } };
    }),
  );

  /* ------------------------------- deliveries ----------------------------- */

  // 两个切片，一条路径（设计 §10 的节点头「排队 N」）：不带 `node=` answers
  // 投递**记录**，带上它答的是那个目标还排着的**队**。页面上这两件事挨在
  // 一起——一条边上发生过什么，和这条边上还压着什么。
  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/deliveries",
    answered((match, request) => {
      const workspaceId = param(match, "workspaceId");
      const node = request.query.get("node") ?? "";
      if (node !== "") {
        return {
          status: 200,
          body: listQueued(collab, workspaceId, node, nowSeconds(collab)),
        };
      }
      const limit = Number.parseInt(request.query.get("limit") ?? "", 10);
      return {
        status: 200,
        body: listDeliveries(
          collab,
          workspaceId,
          Number.isFinite(limit) ? limit : 200,
        ),
      };
    }),
  );

  // 目标那一侧的人拒收一条还排着的投递（设计 §4.6 的取消一行）。发起者那一侧
  // 的入口是 `canvas cancel --id`，走的是同一张表的同一列。
  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/deliveries/{deliveryId}",
    answered((match) => ({
      status: 200,
      body: {
        cancelled: cancelQueued(
          collab,
          param(match, "workspaceId"),
          param(match, "deliveryId"),
        ),
      },
    })),
  );

  /* ---------------------------- control confirm --------------------------- */

  server.router.handle(
    "POST",
    "/api/control/confirm/{requestId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const approve = body.approve;
      if (typeof approve !== "boolean") {
        throw badRequest("approve must be a boolean");
      }
      const requestId = param(match, "requestId");
      // `accepted: false` means the verb already gave up; the dialog closes
      // either way, which is why this is not an error.
      return {
        status: 200,
        body: {
          requestId,
          approve,
          accepted: answerConfirm(requestId, approve),
        },
      };
    }),
  );

  /* --------------------------------- handoff ------------------------------ */

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/handoffs",
    answered((match, request) => ({
      status: 200,
      body: prepare(
        collab,
        param(match, "workspaceId"),
        parsePrepare(jsonObject(request.body)),
      ),
    })),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/handoffs",
    answered((match, request) => {
      const workspaceId = param(match, "workspaceId");
      const sourceNodeId = request.query.get("sourceNodeId");
      return {
        status: 200,
        body:
          sourceNodeId === null || sourceNodeId === ""
            ? listWorkspace(collab, workspaceId)
            : listHandoffs(collab, workspaceId, sourceNodeId),
      };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/handoffs/{handoffId}",
    answered((match) => ({
      status: 200,
      body: getHandoff(
        collab,
        param(match, "workspaceId"),
        param(match, "handoffId"),
      ),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/handoffs/{handoffId}/accept",
    answered((match, request) => ({
      status: 200,
      body: accept(
        collab,
        param(match, "workspaceId"),
        param(match, "handoffId"),
        parseConfirm(jsonObject(request.body)),
      ),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/handoffs/{handoffId}/cancel",
    answered((match, request) => ({
      status: 200,
      body: cancel(
        collab,
        param(match, "workspaceId"),
        param(match, "handoffId"),
        parseConfirm(jsonObject(request.body)),
      ),
    })),
  );

  /* ------------------------------ conversations --------------------------- */

  server.router.handle(
    "GET",
    "/api/conversations",
    answered((_match, request) => {
      // 第一次有人读的时候才建索引；装配时不扫（见 `conversations.ensureIndexed`）。
      ensureIndexed(database);
      const limit = Number.parseInt(request.query.get("limit") ?? "", 10);
      const q = request.query.get("q");
      return {
        status: 200,
        body: listConversations(
          database,
          q === null ? undefined : q,
          Number.isFinite(limit) ? limit : DEFAULT_LIMIT,
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/conversations/refresh",
    answered(() => ({
      status: 200,
      body: refresh(database, undefined, configuredScope(database)),
    })),
  );

  /* ------------------------------ context reads --------------------------- */

  // 节点头那一句「被读取 N 次」（设计 §13 第 5 条）。读取本身是 Agent 之间
  // 的事，而「谁在读我」是**人**要知道的事——一个 Agent 静悄悄地把另一个的转
  // 录读走十次，今天在界面上一点痕迹都没有。
  server.router.handle(
    "GET",
    "/api/nodes/{nodeId}/context-reads",
    answered((match, request) => {
      const limit = Number.parseInt(request.query.get("limit") ?? "", 10);
      return {
        status: 200,
        body: listContextReads(
          database,
          param(match, "nodeId"),
          Number.isFinite(limit) && limit > 0
            ? Math.min(limit, MAX_CONTEXT_READS)
            : DEFAULT_CONTEXT_READS,
        ),
      };
    }),
  );
}

/* --------------------------------- plumbing -------------------------------- */

function param(match: RouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) {
    throw new DomainError(500, "internal_error", `${name} is not in the path`);
  }
  return value;
}

/** 501 with a sentence — a provider whose transcript nothing here can read. */
function unsupported(message: string): DomainError {
  return new DomainError(501, "unsupported", message);
}

function answered(
  handle: (match: RouteMatch, request: CoreRequest) => HandlerResult,
): (match: RouteMatch, request: CoreRequest) => HandlerResult {
  return (match, request) => {
    try {
      return handle(match, request);
    } catch (error) {
      return failure(error);
    }
  };
}

function answeredAsync(
  handle: (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult>,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  return async (match, request) => {
    try {
      return await handle(match, request);
    } catch (error) {
      return failure(error);
    }
  };
}

function failure(error: unknown): HandlerResult {
  if (error instanceof DomainError) {
    const { status, body } = error.response();
    return { status, body };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: { code: "bad_request", message: "Request body is not valid JSON" },
    };
  }
  throw error;
}

function cutBytes(text: string, limit: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = limit;
  // Back off to a character boundary: a cut UTF-8 sequence renders as a
  // replacement character in the agent's own transcript.
  while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function parsePrepare(body: Record<string, unknown>): PrepareRequest {
  const sections = body.sections;
  if (sections === null || typeof sections !== "object") {
    throw badRequest("sections is required");
  }
  const filePaths = body.filePaths ?? [];
  if (
    !Array.isArray(filePaths) ||
    filePaths.some((p) => typeof p !== "string")
  ) {
    throw badRequest("filePaths must be an array of strings");
  }
  const byteBudget = body.byteBudget;
  if (typeof byteBudget !== "number")
    throw badRequest("byteBudget is required");
  return {
    sourceNodeId: required(body, "sourceNodeId"),
    sourceSessionId: required(body, "sourceSessionId"),
    sourceGeneration: requiredNumber(body, "sourceGeneration"),
    targetNodeId: required(body, "targetNodeId"),
    targetSessionId: required(body, "targetSessionId"),
    targetGeneration: requiredNumber(body, "targetGeneration"),
    sections: sectionsOf(sections as Record<string, unknown>),
    filePaths: filePaths as string[],
    byteBudget,
    includeTranscript: body.includeTranscript !== false,
  };
}

function sectionsOf(
  source: Record<string, unknown>,
): PrepareRequest["sections"] {
  const read = (key: string): string => {
    const value = source[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw badRequest(`${key} must be a string`);
    return value;
  };
  return {
    goal: read("goal"),
    constraints: read("constraints"),
    completed: read("completed"),
    pending: read("pending"),
    decisions: read("decisions"),
    toolSummary: read("toolSummary"),
  };
}

function parseConfirm(body: Record<string, unknown>): ConfirmRequest {
  return { expectedDigest: required(body, "expectedDigest") };
}

function required(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || value === "") {
    throw badRequest(`${name} is required`);
  }
  return value;
}

function requiredNumber(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`${name} is required`);
  }
  return value;
}
