import { join } from "node:path";
import type { HandlerResult } from "../http/router";
import type { CoreContext } from "../main";
import { validNodeId } from "./auth";
import { InstallError } from "./install/shared";
import {
  type IntegrationOptions,
  install as installIntegration,
  state as integrationState,
  uninstall as uninstallIntegration,
} from "./install/integration";
import { repair as repairIntegration } from "./install/repair";
import type { HookService } from "./service";

/**
 * The hook domain's routes on the *main* surface.
 *
 * Only two things reach the hook service from the front end: the per-node
 * credential a terminal was created with, and the integration installer. Both
 * are here rather than in the terminal or agent domains because both are
 * statements about files this domain owns.
 *
 * The three integration routes are one unit with one revision (§2): reading
 * says what is on disk and what a fresh install would write, installing
 * writes both halves, and repairing is the *only* thing that touches a file an
 * earlier product name left behind — start-up scans and logs, it never edits.
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

  installRoutesFor(context);
}

function error(status: number, code: string, message: string): HandlerResult {
  return { status, body: { code, message } };
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function installRoutesFor(context: CoreContext): void {
  const options = (): IntegrationOptions => ({ dataDir: context.dataDir });
  const guard = (run: () => unknown): HandlerResult => {
    try {
      return { status: 200, body: run() };
    } catch (failure) {
      if (failure instanceof InstallError) {
        return error(failure.status, failure.code, failure.message);
      }
      return error(500, "internal", describe(failure));
    }
  };

  context.server.router.handle(
    "GET",
    "/api/agents/{agentId}/integration",
    (match) =>
      guard(() => integrationState(match.params.agentId ?? "", options())),
  );
  context.server.router.handle(
    "POST",
    "/api/agents/{agentId}/integration/install",
    (match) =>
      guard(() => installIntegration(match.params.agentId ?? "", options())),
  );
  context.server.router.handle(
    "POST",
    "/api/agents/{agentId}/integration/uninstall",
    (match) =>
      guard(() => uninstallIntegration(match.params.agentId ?? "", options())),
  );
  context.server.router.handle(
    "POST",
    "/api/agents/{agentId}/integration/repair",
    (match) => guard(() => repairIntegration(match.params.agentId ?? "")),
  );
}
