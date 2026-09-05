import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AutomationCommandSession,
  AutomationPlanConfig,
  CommandLaunchSpec,
  HostAutomationClient,
} from "@armadra/host-client";
import type { AutomationScheduleKind } from "@armadra/shared";

import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { agentTargets, frozenLaunch } from "./agent-targets";
import { timezoneOptions, validCron, validTimezone } from "./model";
import { allCommandSessions, automationKeys } from "./queries";
import {
  buildLaunchSpec,
  buildPlanConfig,
  defaultWizardState,
  type WizardState,
} from "./wizard";

/** A command session the form asks the panel to freeze before saving the plan. */
export interface NewSessionRequest {
  sessionId: string;
  rootPath: string;
  launch: CommandLaunchSpec;
}

export interface CreatePlanRequest {
  planId: string;
  config: AutomationPlanConfig;
  payload: Uint8Array;
  session?: NewSessionRequest;
}

/**
 * What the form should start from. Used by "turn into a platform plan" on a
 * native activity card: the card fills in the target and the origin, the person
 * still reviews and confirms, and the plan is created as a draft.
 */
export interface CreatePlanPrefill {
  targetKind: "agent";
  nodeId: string;
  title: string;
  /** `native` when this came from an observed CLI loop rather than the wizard. */
  origin: "native";
}

export interface CreatePlanFormProps {
  client: HostAutomationClient;
  /** This Host's own id; a plan may only target the Host it is defined on. */
  hostId: string;
  workspaceId: string;
  busy: boolean;
  prefill?: CreatePlanPrefill | null;
  onCreate: (input: CreatePlanRequest) => void;
}

const SCHEDULE_KINDS: AutomationScheduleKind[] = [
  "once",
  "interval",
  "cron",
  "loop",
];

function field(label: string, control: React.ReactNode, help?: string) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block text-[12px] font-medium">{label}</span>
      {control}
      {help ? (
        <span className="block text-[11px] text-destructive">{help}</span>
      ) : null}
    </label>
  );
}

function randomId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "");
  return `${prefix}-${random ?? Date.now().toString(36)}`;
}

/**
 * 创建向导（自动化设计 §4）。
 *
 * 执行位置固定为当前 Host——计划只能派发到定义它的那台 Host，所以这里不给
 * 一个会失败的下拉。命令会话要么选已有的，要么当场定义一个新的；两者都会
 * 冻结 LaunchSpec 与 generation 后再保存计划。
 */
export function CreatePlanForm({
  client,
  hostId,
  workspaceId,
  busy,
  prefill,
  onCreate,
}: CreatePlanFormProps) {
  const t = useT();
  const [state, setState] = React.useState<WizardState>(() =>
    defaultWizardState(),
  );
  const [targetKind, setTargetKind] = React.useState<"command" | "agent">(
    prefill?.targetKind ?? "command",
  );
  const [agentNodeId, setAgentNodeId] = React.useState(prefill?.nodeId ?? "");
  const [coldStart, setColdStart] = React.useState(false);
  const nodes = useCanvasStore((store) => store.document?.nodes);
  const agents = React.useMemo(() => agentTargets(nodes), [nodes]);
  const agentNode = nodes?.find((node) => node.id === agentNodeId);
  const agentOption = agents.find((option) => option.nodeId === agentNodeId);
  const [mode, setMode] = React.useState<"existing" | "new">("existing");
  const [sessionId, setSessionId] = React.useState("");
  const [draft, setDraft] = React.useState({
    sessionId: randomId("session"),
    rootPath: "",
    executable: "",
    args: "",
    timeoutMs: "60000",
  });
  const [error, setError] = React.useState<{
    field: string;
    messageKey: string;
  } | null>(null);
  const zones = React.useMemo(timezoneOptions, []);

  const sessions = useQuery({
    queryKey: automationKeys.sessions(workspaceId),
    queryFn: () => allCommandSessions(client),
    retry: false,
  });
  const ready = React.useMemo(
    () => (sessions.data ?? []).filter((session) => session.state === 1),
    [sessions.data],
  );
  React.useEffect(() => {
    if (!sessionId && ready[0]) setSessionId(ready[0].sessionId);
  }, [ready, sessionId]);
  const selected: AutomationCommandSession | undefined = ready.find(
    (session) => session.sessionId === sessionId,
  );

  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
    setState((current) => ({ ...current, [key]: value }));
  const problem = (name: string) =>
    error?.field === name ? t(error.messageKey) : undefined;

  /**
   * An agent plan writes into a terminal the Runtime owns, so the wizard reads
   * the live generation once and records it. It is a note of what the plan was
   * defined against, not a lock: the executor re-checks the node's identity and
   * the frozen definition at the write itself, and reports what it wrote to.
   */
  async function agentTarget() {
    if (!agentOption) return null;
    let generation = 0n;
    try {
      const session = await runtimeApi.getTerminal(agentOption.sessionId);
      if (session.status === "running")
        generation = BigInt(session.generation ?? 0);
    } catch {
      // No live session is a legitimate state for a plan that cold starts.
    }
    return {
      kind: "agent" as const,
      sessionId: agentOption.sessionId,
      generation,
      nodeId: agentOption.nodeId,
      agentLaunch: frozenLaunch(agentOption, agentNode),
      coldStart,
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (targetKind === "agent") {
      const target = await agentTarget();
      if (!target) {
        setError({
          field: "session",
          messageKey: "automation.wizard.agentTargetRequired",
        });
        return;
      }
      const config = buildPlanConfig(state, {
        workspaceId,
        executionHostId: hostId,
        ...target,
      });
      if (!config.ok) {
        setError({ field: config.field, messageKey: config.messageKey });
        return;
      }
      onCreate({
        planId: randomId("plan"),
        config: config.config,
        payload: new TextEncoder().encode(state.payload),
      });
      return;
    }
    let target = {
      sessionId: selected?.sessionId ?? "",
      generation: selected?.generation ?? 0n,
    };
    let session: NewSessionRequest | undefined;
    if (mode === "new") {
      const launch = buildLaunchSpec(draft);
      if ("messageKey" in launch) {
        setError({ field: "executable", messageKey: launch.messageKey });
        return;
      }
      if (!draft.rootPath.trim().startsWith("/")) {
        setError({
          field: "rootPath",
          messageKey: "automation.wizard.invalidPath",
        });
        return;
      }
      session = {
        sessionId: draft.sessionId,
        rootPath: draft.rootPath.trim(),
        launch,
      };
      // Generation 0 tells the Host to freeze whatever the Worker reports for
      // the session it is about to create.
      target = { sessionId: draft.sessionId, generation: 0n };
    }
    const config = buildPlanConfig(state, {
      kind: "command",
      workspaceId,
      executionHostId: hostId,
      sessionId: target.sessionId,
      generation: target.generation,
    });
    if (!config.ok) {
      setError({ field: config.field, messageKey: config.messageKey });
      return;
    }
    onCreate({
      planId: randomId("plan"),
      config: config.config,
      payload: new TextEncoder().encode(state.payload),
      ...(session ? { session } : {}),
    });
  }

  return (
    <form className="min-w-0 space-y-4 p-3" onSubmit={submit}>
      <fieldset className="min-w-0 space-y-3" disabled={busy}>
        {field(
          t("automation.wizard.location"),
          <p className="truncate rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground select-text">
            {t("automation.wizard.currentHost")} · {hostId}
          </p>,
        )}

        {prefill?.origin === "native" ? (
          <p
            role="status"
            className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground"
          >
            {t("automation.wizard.fromNative")}
          </p>
        ) : null}

        {field(
          t("automation.wizard.targetKind"),
          <Select
            value={targetKind}
            onValueChange={(value) =>
              setTargetKind(value as "command" | "agent")
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value="command">
                {t("automation.wizard.targetKind.command")}
              </SelectItem>
              <SelectItem value="agent" disabled={agents.length === 0}>
                {t("automation.wizard.targetKind.agent")}
              </SelectItem>
            </SelectContent>
          </Select>,
        )}

        {targetKind === "agent" ? (
          <>
            {field(
              t("automation.wizard.agentNode"),
              <Select value={agentNodeId} onValueChange={setAgentNodeId}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-dialog)]">
                  {agents.map((option) => (
                    <SelectItem key={option.nodeId} value={option.nodeId}>
                      {option.title} · {option.agentId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              problem("session"),
            )}
            <label className="flex min-w-0 items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={coldStart}
                onChange={(event) => setColdStart(event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block font-medium">
                  {t("automation.wizard.coldStart")}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {t("automation.wizard.coldStartNote")}
                </span>
              </span>
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t("automation.wizard.agentDeliveryNote")}
            </p>
          </>
        ) : null}

        {targetKind === "command" &&
          field(
            t("automation.wizard.session"),
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as "existing" | "new")}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                <SelectItem value="existing" disabled={ready.length === 0}>
                  {t("automation.wizard.existingSession")}
                </SelectItem>
                <SelectItem value="new">
                  {t("automation.wizard.newSession")}
                </SelectItem>
              </SelectContent>
            </Select>,
            problem("session"),
          )}

        {targetKind === "agent" ? null : mode === "existing" ? (
          field(
            t("automation.wizard.sessionId"),
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {ready.map((session) => (
                  <SelectItem key={session.sessionId} value={session.sessionId}>
                    {session.sessionId} · {session.rootPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>,
          )
        ) : (
          <>
            {field(
              t("automation.wizard.sessionId"),
              <Input
                value={draft.sessionId}
                onChange={(event) =>
                  setDraft({ ...draft, sessionId: event.target.value })
                }
              />,
            )}
            {field(
              t("automation.wizard.rootPath"),
              <Input
                value={draft.rootPath}
                placeholder="/"
                onChange={(event) =>
                  setDraft({ ...draft, rootPath: event.target.value })
                }
              />,
              problem("rootPath"),
            )}
            {field(
              t("automation.wizard.executable"),
              <Input
                value={draft.executable}
                placeholder="/bin/echo"
                onChange={(event) =>
                  setDraft({ ...draft, executable: event.target.value })
                }
              />,
              problem("executable"),
            )}
            {field(
              t("automation.wizard.args"),
              <Textarea
                rows={3}
                value={draft.args}
                onChange={(event) =>
                  setDraft({ ...draft, args: event.target.value })
                }
              />,
            )}
            {field(
              t("automation.wizard.timeout"),
              <Input
                inputMode="numeric"
                value={draft.timeoutMs}
                onChange={(event) =>
                  setDraft({ ...draft, timeoutMs: event.target.value })
                }
              />,
            )}
          </>
        )}

        {field(
          t("automation.wizard.title"),
          <Input
            value={state.title}
            onChange={(event) => set("title", event.target.value)}
          />,
          problem("title"),
        )}

        {field(
          targetKind === "agent"
            ? t("automation.wizard.prompt")
            : t("automation.wizard.payload"),
          <Textarea
            rows={3}
            value={state.payload}
            onChange={(event) => set("payload", event.target.value)}
          />,
          problem("payload"),
        )}

        {field(
          t("automation.wizard.scheduleKind"),
          <Select
            value={state.scheduleKind}
            onValueChange={(value) =>
              set("scheduleKind", value as AutomationScheduleKind)
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {SCHEDULE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`automation.schedule.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>,
        )}

        {state.scheduleKind === "once" &&
          field(
            t("automation.wizard.at"),
            <Input
              type="datetime-local"
              value={state.at}
              onChange={(event) => set("at", event.target.value)}
            />,
            problem("at"),
          )}

        {state.scheduleKind === "interval" && (
          <>
            {field(
              t("automation.wizard.anchor"),
              <Input
                type="datetime-local"
                value={state.anchor}
                onChange={(event) => set("anchor", event.target.value)}
              />,
              problem("anchor"),
            )}
            {field(
              t("automation.wizard.interval"),
              <Input
                inputMode="numeric"
                value={state.intervalMs}
                onChange={(event) => set("intervalMs", event.target.value)}
              />,
              problem("intervalMs"),
            )}
          </>
        )}

        {state.scheduleKind === "cron" && (
          <>
            {field(
              t("automation.wizard.cron"),
              <Input
                spellCheck={false}
                autoCapitalize="none"
                value={state.cron}
                aria-invalid={!validCron(state.cron)}
                onChange={(event) => set("cron", event.target.value)}
              />,
              problem("cron") ??
                (validCron(state.cron)
                  ? undefined
                  : t("automation.wizard.invalidCron")),
            )}
            {field(
              t("automation.wizard.timezone"),
              <Select
                value={state.timezone}
                onValueChange={(value) => set("timezone", value)}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-dialog)]">
                  {zones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              problem("timezone") ??
                (validTimezone(state.timezone)
                  ? undefined
                  : t("automation.wizard.invalidTimezone")),
            )}
          </>
        )}

        {state.scheduleKind === "loop" &&
          field(
            t("automation.wizard.loopDelay"),
            <Input
              inputMode="numeric"
              value={state.loopDelayMs}
              onChange={(event) => set("loopDelayMs", event.target.value)}
            />,
            problem("loopDelayMs"),
          )}

        {field(
          t("automation.wizard.maxRuns"),
          <Input
            inputMode="numeric"
            value={state.maxRuns}
            onChange={(event) => set("maxRuns", event.target.value)}
          />,
          problem("maxRuns"),
        )}
        {field(
          t("automation.wizard.expiresAt"),
          <Input
            type="datetime-local"
            value={state.expiresAt}
            onChange={(event) => set("expiresAt", event.target.value)}
          />,
          problem("expiresAt"),
        )}

        {field(
          t("automation.wizard.misfire"),
          <Select
            value={state.misfire}
            onValueChange={(value) =>
              set("misfire", value as WizardState["misfire"])
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value="skip">
                {t("automation.wizard.misfire.skip")}
              </SelectItem>
              <SelectItem value="coalesce">
                {t("automation.wizard.misfire.coalesce")}
              </SelectItem>
            </SelectContent>
          </Select>,
        )}
        {field(
          t("automation.wizard.concurrency"),
          <Select
            value={state.concurrency}
            onValueChange={(value) =>
              set("concurrency", value as WizardState["concurrency"])
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value="forbid">
                {t("automation.wizard.concurrency.forbid")}
              </SelectItem>
              <SelectItem value="queue">
                {t("automation.wizard.concurrency.queue")}
              </SelectItem>
            </SelectContent>
          </Select>,
        )}
        {field(
          t("automation.wizard.busyTtl"),
          <Input
            inputMode="numeric"
            value={state.busyTtlMs}
            onChange={(event) => set("busyTtlMs", event.target.value)}
          />,
          problem("busyTtlMs"),
        )}

        <p className="text-[11px] text-muted-foreground">
          {t("automation.wizard.created")}
        </p>
        <Button type="submit" size="sm" className="min-h-10" disabled={busy}>
          {t("automation.create")}
        </Button>
      </fieldset>
    </form>
  );
}
