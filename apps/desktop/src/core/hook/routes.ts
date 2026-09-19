import { join } from "node:path";
import type { HandlerResult } from "../http/router";
import type { CoreContext } from "../main";
import { validNodeId } from "./auth";
import type { HookService } from "./service";

/**
 * The hook domain's routes on the *main* surface.
 *
 * Only two things reach the hook service from the front end: the per-node
 * credential a terminal was created with, and the integration installer. Both
 * are here rather than in the terminal or agent domains because both are
 * statements about files this domain owns.
 */
export function installRoutes(
  context: CoreContext,
  service: HookService,
): void {
  context.server.router.handle(
    "POST",
    "/api/terminals/{sessionId}/node-token/refresh",
    (match) => {
      const sessionId = match.params.sessionId ?? "";
      const row = context.db.database
        .prepare("SELECT owner_node_id FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as Record<string, unknown> | undefined;
      if (row === undefined) {
        return error(404, "not_found", "没有这个终端会话");
      }
      const nodeId = row.owner_node_id;
      if (typeof nodeId !== "string" || nodeId === "") {
        return error(400, "bad_request", "This session has no owning node");
      }
      if (!validNodeId(nodeId)) {
        return error(400, "bad_request", "Node id is not path safe");
      }
      try {
        service.issueNodeToken(nodeId);
      } catch (failure) {
        return error(
          500,
          "internal",
          `Could not write the node token: ${describe(failure)}`,
        );
      }
      return {
        status: 200,
        body: {
          nodeId,
          tokenFile: join(service.nodeTokenDir(), nodeId),
        },
      };
    },
  );
}

function error(status: number, code: string, message: string): HandlerResult {
  return { status, body: { code, message } };
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
