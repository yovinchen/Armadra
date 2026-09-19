import { resolve } from "node:path";
import { VERSION } from "../instance";
import type { CoreContext } from "../main";
import { TerminalError, type TerminateMode } from "./backend";
import { agentEnvironment } from "./environment";
import { TerminalManager } from "./manager";
import { serveTerminalSocket, validWriter } from "./socket";
import { TmuxBackend } from "./tmux/backend";

/**
 * The terminal domain's one assembly point.
 *
 * Three routes are claimed here — and only three, which is what keeps the rest
 * of R2 (capture, paste, scroll, recycle, `GET /api/terminals/backend`,
 * `GET /api/terminals/{id}`) answering 501 with their feature named rather
 * than half-answering:
 *
 *   * `POST /api/terminals` — create and start in one step;
 *   * `POST /api/terminals/{sessionId}/terminate` — end it;
 *   * `GET  /api/terminals/{sessionId}/ws` — attach.
 *
 * `DELETE` on `/api/terminals/{sessionId}` is **not** claimed: the route table
 * lists that path as `GET` only, because the Rust Runtime has no DELETE there
 * — closing a terminal node posts `terminate` with `mode: "session"`. Claiming
 * a method the Rust face does not have would fail `tools/route-parity.mjs`,
 * which is exactly what that guard is for.
 */

export interface TerminalDomain {
  readonly manager: TerminalManager;
  readonly backend: TmuxBackend;
  stop(): Promise<void>;
}

export function install(context: CoreContext): TerminalDomain {
  const backend = new TmuxBackend({
    dataDir: context.dataDir,
    version: VERSION,
  });
  const manager = new TerminalManager({
    database: context.db.database,
    backend,
  });

  context.server.router.handle(
    "POST",
    "/api/terminals",
    async (_match, request) => {
      let body: CreateTerminalRequest;
      try {
        body = request.json<CreateTerminalRequest>();
      } catch {
        return error(new TerminalError(400, "bad_request", "请求体不是 JSON"));
      }
      const invalid = validateCreate(body);
      if (invalid !== undefined) {
        return error(new TerminalError(400, "bad_request", invalid));
      }
      try {
        // The agent's four address variables, when a node owns this terminal.
        // The per-node token is issued by R3 and never travels here.
        const env =
          body.agent !== undefined && body.nodeId !== undefined
            ? agentEnvironment(body.nodeId, body.agent.id, context.dataDir)
            : [];
        const session = await manager.spawn({
          workspaceId: body.workspaceId as string,
          // Resolved, so a relative `cwd` cannot mean two directories. The
          // root-confinement check `resolve_in_root` does on the Rust side
          // needs the workspace row, which is R1's; until then a cwd outside
          // the workspace is refused by the filesystem, not by us.
          cwd: resolve(body.cwd as string),
          ...(body.shell === undefined ? {} : { shell: body.shell }),
          ...(body.command === undefined ? {} : { command: body.command }),
          args: body.args ?? [],
          kind: "terminal",
          ...(body.nodeId === undefined ? {} : { ownerNodeId: body.nodeId }),
          ...(body.agent === undefined ? {} : { agentId: body.agent.id }),
          env,
        });
        return { status: 200, body: session };
      } catch (failure) {
        return error(failure);
      }
    },
  );

  context.server.router.handle(
    "POST",
    "/api/terminals/{sessionId}/terminate",
    async (match, request) => {
      const sessionId = match.params.sessionId as string;
      if (!manager.exists(sessionId)) {
        return error(new TerminalError(404, "not_found", "没有这个终端会话"));
      }
      let mode: TerminateMode = "process";
      if (request.body.byteLength > 0) {
        try {
          const parsed = request.json<{ mode?: TerminateMode }>();
          if (parsed?.mode !== undefined) mode = parsed.mode;
        } catch {
          return error(
            new TerminalError(400, "bad_request", "请求体不是 JSON"),
          );
        }
      }
      try {
        await manager.terminate(sessionId, mode);
      } catch (failure) {
        // A session that already finished is not an error for the caller.
        const alreadyOver =
          failure instanceof TerminalError &&
          failure.status === 404 &&
          manager.session(sessionId).status !== "running";
        if (!alreadyOver) return error(failure);
      }
      return { status: 200, body: manager.session(sessionId) };
    },
  );

  context.server.stream(
    "/api/terminals/{sessionId}/ws",
    (connection, params, request) => {
      const sessionId = params.sessionId as string;
      void serveTerminalSocket(connection, {
        manager,
        sessionId,
        writer: validWriter(request.query.get("writer")) ?? "",
        onError: (failure) =>
          context.log.warn("terminal socket", {
            sessionId,
            error: failure instanceof Error ? failure.message : String(failure),
          }),
      });
    },
    // Refused before the upgrade, the way the Rust face does it: an unknown
    // session is an HTTP 404, not a socket that opens and closes, and a
    // malformed `writer` is a 400 rather than a label nobody validated.
    (params, request) => {
      if (!manager.exists(params.sessionId as string)) {
        return { status: 404, reason: "Not Found" };
      }
      if (validWriter(request.query.get("writer")) === undefined) {
        return { status: 400, reason: "Bad Request" };
      }
      return undefined;
    },
  );

  return {
    manager,
    backend,
    stop: () => manager.shutdown(),
  };
}

interface CreateTerminalRequest {
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly nodeId?: string;
  readonly agent?: { readonly id: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCreate(body: CreateTerminalRequest): string | undefined {
  if (typeof body?.workspaceId !== "string" || body.workspaceId === "") {
    return "缺少 workspaceId";
  }
  if (typeof body.cwd !== "string" || body.cwd === "") return "缺少 cwd";
  if (body.nodeId !== undefined && !UUID.test(body.nodeId)) {
    return "Terminal node id is invalid";
  }
  if (body.agent !== undefined && body.nodeId === undefined) {
    // Without a node there is nothing to attribute hook reports to, and the
    // hook client would refuse to report anyway.
    return "An agent terminal requires the owning nodeId";
  }
  return undefined;
}

/** A backend failure, in the one error shape the core has (contract §5.1). */
function error(failure: unknown): {
  status: number;
  body: { code: string; message: string };
} {
  if (failure instanceof TerminalError) {
    return {
      status: failure.status,
      body: { code: failure.code, message: failure.message },
    };
  }
  return {
    status: 500,
    body: {
      code: "internal",
      message: failure instanceof Error ? failure.message : String(failure),
    },
  };
}

/** Typed asserted by `install`; `CoreContext` is the only thing it needs. */
export type { CoreContext };
