import type { CoreContext } from "../main";
import { pendingDir } from "../paths";
import { startApprovalSweep } from "./approvals";
import type { IngestContext } from "./ingest";
import { HookServer } from "./server";
import { HookService, hookService, setHookService } from "./service";
import { markAgentStatusRestored } from "./store";
import { startStaleSweep } from "./sweep";
import { installRoutes } from "./routes";

export { HookService, hookService } from "./service";
export { issueNodeToken } from "./tokens";
export {
  PERM_WAIT_SECONDS,
  sweepOrphans,
  validPendingId,
  writeAnswerFile,
} from "./approvals";
export { registerCollabDispatcher } from "./collab";
export type {
  CollabAnswer,
  CollabCaller,
  CollabDispatcher,
  CollabRequest,
} from "./collab";
export { answerApproval, getApproval } from "./store";

/**
 * The hook domain's one assembly point.
 *
 * The start-up order is the Rust `hook::start`'s and is not arbitrary:
 *
 *   1. mark every surviving `agent_status` row as restored — a row read back
 *      after a restart is not live knowledge;
 *   2. bind the socket;
 *   3. publish the endpoint file, and withdraw it again if the bind failed.
 *
 * Publishing last is what keeps the file from ever naming an address nothing
 * answers on (W0.3). Every failure is logged rather than thrown: the core is
 * still useful without a hook surface, and a hard failure here would mean no
 * canvas at all.
 */
export interface HookDomain {
  readonly service: HookService;
  readonly server: HookServer;
  stop(): Promise<void>;
}

export function install(context: CoreContext): HookDomain {
  const service = new HookService(context.dataDir, undefined, (message, detail) =>
    context.log.warn(message, { error: describe(detail) }),
  );
  setHookService(service);

  const ingestContext: IngestContext = {
    database: context.db.database,
    bus: context.bus,
    hooks: service,
    log: {
      warn: (message, detail) =>
        context.log.warn(message, { detail: describe(detail) }),
      debug: (message, detail) =>
        context.log.debug(message, { detail: describe(detail) }),
    },
  };

  markAgentStatusRestored(context.db.database);
  installRoutes(context, service);

  const server = new HookServer({ ...ingestContext });
  const socketPath = service.socketPath();
  const stopSweeps: (() => void)[] = [
    startStaleSweep(ingestContext),
    // Contract §5.5: pending permission files left by a client that was killed
    // mid-wait are cleared at start-up and hourly.
    startApprovalSweep(context.dataDir, (removed) =>
      context.log.info("cleared orphaned permission requests", { removed }),
    ),
  ];

  const start = async (): Promise<void> => {
    let bound = false;
    if (socketPath !== undefined) {
      try {
        await server.listen({ kind: "unix", path: socketPath });
        bound = true;
        context.log.info("hook socket is listening", { path: socketPath });
      } catch (error) {
        context.log.warn("could not bind the hook socket", {
          path: socketPath,
          error: describe(error),
        });
      }
    }
    try {
      service.publishEndpoint(undefined);
      if (!bound) {
        // The endpoint file would otherwise advertise a socket that will never
        // accept a connection, and a hook client only moves on from a
        // *transport* failure — every attempt would burn its connect budget
        // here first (W0.3).
        service.withdrawSocket();
      }
    } catch (error) {
      context.log.warn("hook clients will not find this core", {
        error: describe(error),
      });
      // A stale file from a previous run must not go on describing a process
      // that never actually started serving hooks.
      service.withdraw();
    }
    context.log.debug("hook pending directory", {
      path: pendingDir(context.dataDir),
    });
  };
  void start();

  return {
    service,
    server,
    stop: async () => {
      for (const stop of stopSweeps) stop();
      await server.close();
      service.withdraw();
      if (hookService() === service) setHookService(undefined);
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
