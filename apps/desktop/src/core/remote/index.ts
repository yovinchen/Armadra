/**
 * The SSH and remote-execution domain's one assembly point.
 *
 * It owns two things that only exist together: the `ssh` a terminal runs, and
 * the `ssh` a remote Worker runs. They share the host registry, the host-key
 * file, the askpass helper and the prompt registry, so splitting them into two
 * `install`s would mean two copies of each or a fifth thing to thread between
 * them.
 *
 * Nine routes are claimed here:
 *
 *   * `POST /api/ssh/hosts/{id}/test` — reachability;
 *   * `POST /api/ssh/hosts/{id}/worker/test` — reachability *and* handshake;
 *   * `POST /api/ssh/hosts/{id}/host-keys/scan` — scan and show;
 *   * `POST|DELETE /api/ssh/hosts/{id}/host-keys` — trust and forget;
 *   * `GET /api/ssh/prompts` — what is still waiting;
 *   * `POST|DELETE /api/ssh/hosts/{id}/prompts/{promptId}` — answer, cancel;
 *   * `POST /api/execution-hosts/{id}/validate` — the settings page's button.
 *
 * What is **not** claimed, and why, is as much a part of this file:
 *
 *   * `/api/ssh/askpass/prompts` and `…/{id}` stay 501. The helper reaches
 *     this core over a 0600 unix socket of its own (`terminal/ssh/askpass.ts`),
 *     so the prompt-opening endpoint is not on the general HTTP surface at
 *     all. Nothing else ever called those paths.
 *
 * It also registers the {@link setRemoteCaller} every workspace-scoped domain
 * reaches its execution host through. `POST /api/workspaces/remote` and
 * `PATCH …/execution-host` belong to the workspace domain; they prove a root
 * through that same caller before a row may name it.
 */

import { VERSION } from "../instance";
import { coreError } from "../http/errors";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import {
  parseHosts,
  type SshHost,
  type SshWorker,
} from "../settings/ssh-hosts";
import { AskpassService } from "../terminal/ssh/askpass";
import {
  answerPrompt,
  asError,
  cancelPrompt,
  forgetHostKeys,
  listPrompts,
  scanHostKeys,
  testHost,
  testWorker,
  trustHostKey,
  type SshRouteDeps,
} from "../terminal/ssh/routes";
import {
  probeHost,
  validateExecutionHost,
  ValidationRefused,
} from "./validate";
import {
  type RemoteChannel,
  remoteConnected,
  remoteDisconnected,
  remotePushed,
  executeRemote,
  listenRemote,
  setLanguageCaller,
  setRemoteCaller,
} from "./execute";
import { LANGUAGE_CAPABILITY } from "./language";
import { remoteResources } from "../resources/remote";
import { missingCapability } from "./handshake";
import { capabilityOf } from "./operations";
import { RemoteWorker, RemoteWorkers, unsupported } from "./worker";
import { RemoteIntegration } from "./integration";

/**
 * Substitutes argv[0] of every `ssh` this domain starts.
 *
 * The same variable the Rust Runtime reads, so a person who reaches their
 * hosts through a wrapper — and the integration tests, which reach a temporary
 * sshd — configure both implementations the same way.
 */
export const LAUNCHER_OVERRIDE = "ARMADRA_REMOTE_WORKER_LAUNCHER";

export interface RemoteDomain {
  readonly askpass: AskpassService;
  readonly workers: RemoteWorkers;
  /** 每台主机的语言连接（`worker --stdio --language-link`），按需建立。 */
  readonly languageLinks: RemoteWorkers;
  /** 画布 SSH 终端的远端注入与 Hook 中继。 */
  readonly integration: RemoteIntegration;
  /** The registry read fresh, so a settings edit is visible immediately. */
  readonly host: (hostId: string) => SshHost | undefined;
  stop(): Promise<void>;
}

let assembled: RemoteDomain | undefined;

/**
 * The remote domain of the running core.
 *
 * A module-level handle for the same reason `settingsDomain()` is one: the
 * terminal domain needs the askpass service and the host registry to decorate
 * an SSH terminal, and threading a fifth thing through `CoreContext` would put
 * it in every domain's signature to serve one. It is `undefined` until
 * `install` runs, which is exactly the window in which no terminal exists.
 *
 * `main`'s `DOMAINS` therefore installs this **before** the terminal domain.
 */
export function remoteDomain(): RemoteDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): RemoteDomain {
  const launcher = accepted(process.env[LAUNCHER_OVERRIDE]);
  const askpass = new AskpassService({
    dataDir: context.dataDir,
    // A prompt is broadcast rather than answered: the secret belongs to a
    // person, and the text is already redacted by the time it gets here. There
    // is no workspace on an `ssh` child, so it goes to every workspace stream
    // — which is what the Rust `EventHub::publish_all` does with it too.
    onPrompt: (prompt) => {
      context.bus.emit("workspace.event", {
        workspaceId: "",
        // Spread into a plain record: the bus carries the payload as an opaque
        // JSON object, and a readonly interface is not one by assignment.
        event: { type: "ssh.prompt", prompt: { ...prompt } },
      });
      context.log.info("ssh is asking for a secret", {
        hostId: prompt.hostId,
        kind: prompt.kind,
      });
    },
  });

  const host = (hostId: string): SshHost | undefined => {
    const settings = settingsDomain();
    if (settings === undefined) return undefined;
    return parseHosts(settings.settings.snapshot()).find(
      (entry) => entry.id === hostId,
    );
  };

  // 每台主机两条连接：控制连接（文件、Git、资源、监听）与语言连接。两者的推送
  // 与起落都交给同一个事件口，各域按 `channel` 取自己的那部分。
  const make =
    (channel: RemoteChannel) =>
    (entry: SshHost, worker: SshWorker): RemoteWorker =>
      new RemoteWorker({
        dataDir: context.dataDir,
        host: entry,
        worker,
        askpass,
        version: VERSION,
        ...(launcher === undefined ? {} : { launcher }),
        languageLink: channel === "language",
        onEvent: (event) => remotePushed(entry.id, channel, event),
        onConnected: () => remoteConnected(entry.id, channel),
        onDisconnected: () => remoteDisconnected(entry.id, channel),
      });
  const workers = new RemoteWorkers(make("control"));
  const languageLinks = new RemoteWorkers(make("language"));

  const deps: SshRouteDeps = {
    dataDir: context.dataDir,
    askpass,
    host,
    probe: async (entry) => await probeHost(context.dataDir, entry, launcher),
    workerTest: async (entry) => {
      // The askpass socket has to exist before an `ssh` child is told to use
      // it, and nothing else in this path starts it.
      await askpass.start();
      return await workers.get(entry, entry.id).probe();
    },
  };

  const { router } = context.server;
  const answered =
    <T extends unknown[]>(
      handler: (...args: T) => Promise<unknown> | unknown,
    ) =>
    async (...args: T) => {
      try {
        return (await handler(...args)) as never;
      } catch (failure) {
        return asError(failure) as never;
      }
    };

  router.handle(
    "POST",
    "/api/ssh/hosts/{hostId}/test",
    answered((match) => testHost(deps, match.params.hostId ?? "")),
  );
  router.handle(
    "POST",
    "/api/ssh/hosts/{hostId}/worker/test",
    answered((match) => testWorker(deps, match.params.hostId ?? "")),
  );
  router.handle(
    "POST",
    "/api/ssh/hosts/{hostId}/host-keys/scan",
    answered((match) => scanHostKeys(deps, match.params.hostId ?? "")),
  );
  router.handle(
    "POST",
    "/api/ssh/hosts/{hostId}/host-keys",
    answered((match, request) =>
      trustHostKey(deps, match.params.hostId ?? "", request),
    ),
  );
  router.handle(
    "DELETE",
    "/api/ssh/hosts/{hostId}/host-keys",
    answered((match) => forgetHostKeys(deps, match.params.hostId ?? "")),
  );
  router.handle(
    "GET",
    "/api/ssh/prompts",
    answered(() => listPrompts(deps)),
  );
  router.handle(
    "POST",
    "/api/ssh/hosts/{hostId}/prompts/{promptId}",
    answered((match, request) =>
      answerPrompt(
        deps,
        match.params.hostId ?? "",
        match.params.promptId ?? "",
        request,
      ),
    ),
  );
  router.handle(
    "DELETE",
    "/api/ssh/hosts/{hostId}/prompts/{promptId}",
    answered((match) => cancelPrompt(deps, match.params.promptId ?? "")),
  );

  router.handle(
    "POST",
    "/api/execution-hosts/{hostId}/validate",
    async (match) => {
      const hostId = match.params.hostId ?? "";
      try {
        await askpass.start();
        return {
          status: 200,
          body: await validateExecutionHost(hostId, {
            dataDir: context.dataDir,
            host: host(hostId),
            worker: (entry) => workers.get(entry, entry.id),
            ...(launcher === undefined ? {} : { launcher }),
          }),
        };
      } catch (failure) {
        if (failure instanceof ValidationRefused) {
          return coreError(failure.status, failure.code, failure.message);
        }
        return asError(failure);
      }
    },
  );

  const call: Parameters<typeof setRemoteCaller>[0] = async (
    hostId,
    operation,
    payload,
    replay,
  ) => {
    const entry = host(hostId);
    const worker = workers.get(entry, hostId);
    // The askpass socket has to exist before an `ssh` child is told to use it.
    await askpass.start();
    const capability = capabilityOf(operation);
    // Only a Worker that has already said what it offers can be refused here;
    // before the first handshake the request itself opens the connection.
    if (capability !== undefined && worker.capability(capability) === false) {
      throw unsupported(missingCapability(entry?.name ?? hostId, capability));
    }
    return await worker.request(operation, payload, replay);
  };
  setRemoteCaller(call);
  // SSH 会话与远端进程树按连接端口对上；设置里写了端口就按它筛。
  remoteResources.setHostPort((hostId) => host(hostId)?.port);
  // 资源读取只问已经连着的语言连接，不为它新建一条。
  remoteResources.setLanguageLive((hostId) => {
    try {
      return (
        languageLinks
          .get(host(hostId), hostId)
          .capability(LANGUAGE_CAPABILITY) === true
      );
    } catch {
      return false;
    }
  });

  const callLanguage: Parameters<typeof setLanguageCaller>[0] = async (
    hostId,
    action,
    payload,
    replay,
  ) => {
    const entry = host(hostId);
    const link = languageLinks.get(entry, hostId);
    await askpass.start();
    if (link.capability(LANGUAGE_CAPABILITY) === false) {
      throw unsupported(
        missingCapability(entry?.name ?? hostId, LANGUAGE_CAPABILITY),
      );
    }
    return await link.request(action, payload, replay);
  };
  setLanguageCaller(callLanguage);

  const integration = new RemoteIntegration({
    dataDir: context.dataDir,
    version: VERSION,
    call: async (hostId, operation, args) =>
      await executeRemote(hostId, operation, "/", args),
    log: (message, fields) => context.log.warn(message, fields),
  });
  const unlisten = listenRemote(integration);

  const domain: RemoteDomain = {
    askpass,
    workers,
    languageLinks,
    integration,
    host,
    stop: async () => {
      unlisten();
      integration.stop();
      if (assembled === domain) assembled = undefined;
      const current = setRemoteCaller(undefined);
      if (current !== call) setRemoteCaller(current);
      const currentLanguage = setLanguageCaller(undefined);
      if (currentLanguage !== callLanguage) setLanguageCaller(currentLanguage);
      languageLinks.closeAll();
      workers.closeAll();
      await askpass.stop();
    },
  };
  assembled = domain;
  return domain;
}

/**
 * Only an absolute path with no whitespace replaces the program: a bare name
 * would resolve through `PATH`, and an argument smuggled through a space would
 * become part of the command line rather than part of the program name. The
 * same rule `known-hosts` applies to its own override.
 */
function accepted(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith("/") && !/\s/u.test(value) ? value : undefined;
}

export { SshBackend } from "../terminal/ssh/backend";
export type { SshTerminalSpec } from "../terminal/ssh/backend";
