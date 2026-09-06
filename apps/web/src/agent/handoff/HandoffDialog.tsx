import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HandoffView } from "@armadra/shared";
import { toast } from "sonner";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { t, useT } from "@/app/preferences-store";
import { agentLabel } from "@/agent/launch";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import {
  handoffTargets,
  onHandoffRequest,
  type HandoffRequestDetail,
  type HandoffTarget,
} from "./handoff-targets";

/**
 * 交接预览与确认（docs/design/agent-automation-design.md §7.3）。
 *
 * 三步走，界面上也是三步，因为它们的授权含义完全不同：
 *
 *  1. **编辑**：选目标、选预算、填模板。此时什么都还没发生。
 *  2. **预览**：`prepare` 冻结了材料并算好指纹。仍然没有通知任何人；
 *     「返回编辑」会把这份冻结的包撤掉，不留悬空记录。
 *  3. **确认**：`accept` 是唯一的用户授权，带上预览那一份的 `digest`——
 *     看到的和批准的必须是同一份。之后只能等目标空闲，或者撤回。
 *
 * 界面从不替用户确认，也从不把「通知已写入」说成「对方已经在做了」。
 */

const BUDGETS = [8192, 16384, 32768] as const;
const SECTION_KEYS = [
  "goal",
  "constraints",
  "completed",
  "pending",
  "decisions",
  "toolSummary",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

/** 还能撤回的状态：收件箱那条还在，目标尚未确认。 */
export function canWithdraw(state: string): boolean {
  return state === "prepared" || state === "queued";
}
/** 还会变的状态：值得继续轮询。等的是目标自己去确认那条收件箱消息。 */
export function isSettled(state: string): boolean {
  return ["acknowledged", "cancelled"].includes(state);
}

export function HandoffDialog() {
  const t = useT();
  const client = useQueryClient();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const document = useCanvasStore((state) => state.document);
  const [source, setSource] = React.useState<HandoffRequestDetail | null>(null);
  const [targetNodeId, setTargetNodeId] = React.useState("");
  const [budget, setBudget] = React.useState<number>(BUDGETS[0]);
  const [includeTranscript, setIncludeTranscript] = React.useState(true);
  const [filePaths, setFilePaths] = React.useState("");
  const [sections, setSections] = React.useState<Record<SectionKey, string>>(
    () => blankSections(),
  );
  const [view, setView] = React.useState<HandoffView | null>(null);

  React.useEffect(
    () =>
      onHandoffRequest((detail) => {
        setSource(detail);
        setView(null);
        setTargetNodeId("");
        setBudget(BUDGETS[0]);
        setIncludeTranscript(true);
        setFilePaths("");
        setSections(blankSections());
      }),
    [],
  );

  const targets: HandoffTarget[] = React.useMemo(
    () => (source ? handoffTargets(document, source.nodeId) : []),
    [document, source],
  );

  // 冻结之后状态还会变（排队 → 写入 → 结果），所以跟着投递事件重取；
  // 事件可能因为断线漏掉，未定状态再补一个 3 秒的轮询兜底。
  const tracked = view?.bundle.handoffId ?? source?.handoffId ?? null;
  const status = useQuery({
    queryKey: ["handoff", workspaceId, tracked],
    enabled: Boolean(workspaceId && tracked),
    queryFn: ({ signal }) => runtimeApi.handoff(workspaceId!, tracked!, signal),
    refetchInterval: view && !isSettled(view.state) ? 3_000 : false,
    retry: false,
  });
  React.useEffect(() => {
    if (status.data) setView(status.data);
  }, [status.data]);
  React.useEffect(
    () =>
      onWorkspaceEvent("agent.delivery", (event) => {
        if (!tracked || !view) return;
        if (event.targetNodeId !== view.bundle.target.nodeId) return;
        void client.invalidateQueries({
          queryKey: ["handoff", workspaceId, tracked],
        });
      }),
    [client, tracked, view, workspaceId],
  );

  const prepare = useMutation({
    mutationFn: () => {
      const target = targets.find((entry) => entry.nodeId === targetNodeId);
      if (!workspaceId || !source || !target)
        throw new Error(t("handoff.noTargets"));
      return resolveBinding(target.nodeId, workspaceId).then((binding) =>
        runtimeApi.prepareHandoff(workspaceId, {
          sourceNodeId: source.nodeId,
          sourceSessionId: source.sessionId,
          sourceGeneration: source.generation,
          targetNodeId: target.nodeId,
          targetSessionId: binding.sessionId,
          targetGeneration: binding.generation,
          sections: { ...sections },
          filePaths: filePaths
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
          byteBudget: budget as 8192 | 16384 | 32768,
          includeTranscript,
        }),
      );
    },
    onSuccess: setView,
    onError: (cause: Error) => toast.error(cause.message),
  });

  const accept = useMutation({
    mutationFn: () =>
      runtimeApi.acceptHandoff(
        workspaceId!,
        view!.bundle.handoffId,
        view!.digest,
      ),
    onSuccess: (next) => {
      setView(next);
      toast.success(t("handoff.accepted"));
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const withdraw = useMutation({
    mutationFn: (back: boolean) =>
      runtimeApi
        .cancelHandoff(workspaceId!, view!.bundle.handoffId, view!.digest)
        .then((next) => ({ next, back })),
    onSuccess: ({ next, back }) => {
      if (back) setView(null);
      else {
        setView(next);
        toast.success(t("handoff.cancelledToast"));
      }
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const busy = prepare.isPending || accept.isPending || withdraw.isPending;
  const open = source !== null;
  const close = () => {
    setSource(null);
    setView(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="z-[var(--z-dialog)] sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("handoff.title")}</DialogTitle>
        </DialogHeader>
        <p className="text-[length:var(--text-caption)] text-muted-foreground">
          {t("handoff.trust")} {t("handoff.sourceRunning")}
        </p>
        <ScrollArea className="max-h-[52vh] pr-3">
          {view ? (
            <HandoffPreview view={view} />
          ) : source?.handoffId ? null : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-target"
                >
                  {t("handoff.target")}
                </label>
                {targets.length === 0 ? (
                  <p className="text-[length:var(--text-caption)] text-muted-foreground">
                    {t("handoff.noTargets")}
                  </p>
                ) : (
                  <Select value={targetNodeId} onValueChange={setTargetNodeId}>
                    <SelectTrigger id="handoff-target">
                      <SelectValue placeholder={t("handoff.target")} />
                    </SelectTrigger>
                    <SelectContent className="z-[var(--z-dialog)]">
                      {targets.map((target) => (
                        <SelectItem key={target.nodeId} value={target.nodeId}>
                          {target.title} · {agentLabel(target.agentId)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-budget"
                >
                  {t("handoff.budget")}
                </label>
                <Select
                  value={String(budget)}
                  onValueChange={(next) => setBudget(Number(next))}
                >
                  <SelectTrigger id="handoff-budget">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[var(--z-dialog)]">
                    {BUDGETS.map((tier) => (
                      <SelectItem key={tier} value={String(tier)}>
                        {tier}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-transcript"
                >
                  {t("handoff.includeTranscript")}
                </label>
                <Switch
                  id="handoff-transcript"
                  checked={includeTranscript}
                  onCheckedChange={setIncludeTranscript}
                />
              </div>
              {SECTION_KEYS.map((key) => (
                <div className="flex flex-col gap-1.5" key={key}>
                  <label
                    className="text-muted-foreground"
                    htmlFor={`handoff-${key}`}
                  >
                    {t(`handoff.${key}`)}
                  </label>
                  <Textarea
                    id={`handoff-${key}`}
                    rows={key === "goal" ? 3 : 2}
                    value={sections[key]}
                    onChange={(event) =>
                      setSections((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground"
                  htmlFor="handoff-files"
                >
                  {t("handoff.filePaths")}
                </label>
                <Textarea
                  id="handoff-files"
                  rows={3}
                  value={filePaths}
                  onChange={(event) => setFilePaths(event.target.value)}
                />
              </div>
            </div>
          )}
        </ScrollArea>
        <DialogFooter>
          {!view && !source?.handoffId && (
            <Button
              disabled={
                busy || !targetNodeId || sections.goal.trim().length === 0
              }
              onClick={() => prepare.mutate()}
            >
              {t("handoff.preview")}
            </Button>
          )}
          {view?.state === "prepared" && (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => withdraw.mutate(true)}
              >
                {t("handoff.back")}
              </Button>
              <Button disabled={busy} onClick={() => accept.mutate()}>
                {t("handoff.accept")}
              </Button>
            </>
          )}
          {view && view.state !== "prepared" && (
            <>
              {canWithdraw(view.state) && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => withdraw.mutate(false)}
                >
                  {t("handoff.cancel")}
                </Button>
              )}
              <Button variant="outline" onClick={close}>
                {t("handoff.close")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HandoffPreview({ view }: { view: HandoffView }) {
  const t = useT();
  const { bundle } = view;
  return (
    <div className="flex flex-col gap-3 text-[length:var(--text-caption)]">
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.target")}</span>
        <span className="text-muted-foreground">
          {t("handoff.targetSummary", {
            agent: agentLabel(bundle.target.agentId),
            model: bundle.target.modelId ?? t("handoff.unknownModel"),
            directory: bundle.target.workingDirectory,
          })}
        </span>
      </section>
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.status")}</span>
        <span className="flex items-center gap-2">
          <Badge variant="outline">{t(`handoff.${view.state}`)}</Badge>
          {view.state === "queued" && (
            <span className="text-muted-foreground">
              {t("handoff.queuedNote")}
            </span>
          )}
        </span>
        {view.errorCode !== null && (
          <span className="text-muted-foreground">
            {t("handoff.reason", { code: view.errorCode })}
          </span>
        )}
        {view.sourceHasNewActivity && (
          <span className="text-muted-foreground">
            {t("handoff.newActivity")}
          </span>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.budget")}</span>
        <span className="text-muted-foreground">
          {t("handoff.budgetUsed", {
            used: bundle.budget.usedBytes,
            limit: bundle.budget.byteLimit,
          })}
          {bundle.budget.truncated ? ` ${t("handoff.truncated")}` : ""}
        </span>
      </section>
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.files")}</span>
        {bundle.files.length === 0 ? (
          <span className="text-muted-foreground">{t("handoff.noFiles")}</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {bundle.files.map((file) => (
              <li key={file.path} className="truncate">
                {file.path} — {t(`handoff.fileStatus.${file.status}`)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.git")}</span>
        <span className="text-muted-foreground">
          {bundle.git.status === "observed" && bundle.git.headOid
            ? t("handoff.gitHead", { oid: bundle.git.headOid.slice(0, 12) })
            : t("handoff.gitUnavailable")}
        </span>
      </section>
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.omitted")}</span>
        <ul className="flex flex-col gap-0.5 text-muted-foreground">
          {bundle.budget.omitted.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1">
        <span className="font-medium">{t("handoff.excerpt")}</span>
        {bundle.transcriptExcerpt.trim().length === 0 ? (
          <span className="text-muted-foreground">
            {t("handoff.noExcerpt")}
          </span>
        ) : (
          <pre className="max-h-40 overflow-auto rounded-[var(--r-input)] bg-muted p-2 whitespace-pre-wrap text-muted-foreground">
            {bundle.transcriptExcerpt}
          </pre>
        )}
      </section>
    </div>
  );
}

function blankSections(): Record<SectionKey, string> {
  return {
    goal: "",
    constraints: "",
    completed: "",
    pending: "",
    decisions: "",
    toolSummary: "",
  };
}

/**
 * 目标那条 PTY 的身份。只有挂载着的终端组件知道自己的 generation，所以这里
 * 向 Runtime 问一次：目标节点未必在视口里，不能指望它的组件正好活着。
 */
async function resolveBinding(
  nodeId: string,
  workspaceId: string,
): Promise<{ sessionId: string; generation: number }> {
  const sessions = await runtimeApi.sessions(workspaceId);
  const session = sessions.find((entry) => entry.nodeId === nodeId);
  if (!session) throw new Error(t("handoff.noTargets"));
  const terminal = await runtimeApi.getTerminal(session.sessionId);
  if (terminal.status !== "running" || terminal.generation === undefined)
    throw new Error(t("handoff.noTargets"));
  return { sessionId: session.sessionId, generation: terminal.generation };
}
