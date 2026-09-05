import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCw, X } from "lucide-react";
import {
  HostAutomationError,
  type AutomationPlanSnapshot,
} from "@armadra/host-client";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useAutomationSession } from "@/host/automation-session";
import { useCanvasStore } from "@/store/canvas-store";
import { currentViewportCenter } from "../viewport";
import { CreatePlanForm, type CreatePlanRequest } from "./CreatePlanForm";
import { PlanRow } from "./PlanRow";
import { RunHistory } from "./RunHistory";
import { useAutomationFocus } from "./open";
import { allPlans, automationKeys } from "./queries";
import { scheduleKind } from "./model";

/** Turns a client failure into the one sentence that says what to do next. */
export function failureKey(error: unknown): string {
  if (!(error instanceof HostAutomationError))
    return "automation.error.network";
  if (error.outcomeUnknown) return "automation.error.unknownOutcome";
  return `automation.error.${error.failure}`;
}

/**
 * 右侧工作面板的「自动化」页（画布平台设计 §4）。
 *
 * Host 没连上或没认证时整页只显示原因和去设置的入口——不画一个点了会 401 的
 * 「新建计划」按钮。计划、运行历史、创建向导三个页签共用同一个会话。
 */
export function AutomationDrawer() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const mode = useCanvasStore((state) => state.panels.automation);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const focusPlanId = useAutomationFocus((store) => store.planId);
  const reveal = useAutomationFocus((store) => store.reveal);
  const focus = useAutomationFocus((store) => store.focus);
  const revealRuns = useAutomationFocus((store) => store.revealRuns);
  const prefill = useAutomationFocus((store) => store.prefill);
  const compose = useAutomationFocus((store) => store.compose);
  const clearPrefill = useAutomationFocus((store) => store.clearPrefill);
  const state = useAutomationSession((store) => store.state);
  const connect = useAutomationSession((store) => store.connect);
  const queryClient = useQueryClient();

  const open = mode === "drawer";
  const workspaceId = workspace?.id ?? null;
  const [tab, setTab] = React.useState<"plans" | "runs" | "create">("plans");

  React.useEffect(() => {
    if (open) void connect(workspaceId);
  }, [connect, open, workspaceId]);
  // Only an explicit "show me this plan's runs" navigates; selecting a plan
  // (creating one, say) must leave the reader where they are.
  React.useEffect(() => {
    if (open && reveal > 0) setTab("runs");
  }, [open, reveal]);
  // "Turn into a platform plan" opens the create form on its prefilled draft.
  React.useEffect(() => {
    if (open && compose > 0) setTab("create");
  }, [open, compose]);

  const client = state.status === "ready" ? state.client : null;
  const canManage = state.status === "ready" && state.canManage;
  const hostId = state.status === "ready" ? state.hello.hostId : "";

  const plans = useQuery({
    queryKey: automationKeys.plans(workspaceId ?? ""),
    queryFn: () => allPlans(client!),
    enabled: open && Boolean(client),
    retry: false,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["automation"] });
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const activate = useMutation({
    mutationFn: (snapshot: AutomationPlanSnapshot) =>
      client!.activatePlan({
        planId: snapshot.plan!.id,
        expectedRevision: snapshot.revision,
        configVersion: snapshot.plan!.configVersion,
        configSha256: snapshot.configSha256,
      }),
    onSuccess: invalidate,
    onError: fail,
  });
  const pause = useMutation({
    mutationFn: (snapshot: AutomationPlanSnapshot) =>
      client!.pausePlan({
        planId: snapshot.plan!.id,
        expectedRevision: snapshot.revision,
      }),
    onSuccess: invalidate,
    onError: fail,
  });
  const runNow = useMutation({
    mutationFn: (snapshot: AutomationPlanSnapshot) =>
      client!.runNow({
        planId: snapshot.plan!.id,
        expectedRevision: snapshot.revision,
      }),
    onSuccess: invalidate,
    onError: fail,
  });
  const createPlan = useMutation({
    mutationFn: async (request: CreatePlanRequest) => {
      if (request.session) await client!.defineCommandSession(request.session);
      return client!.definePlan({
        planId: request.planId,
        config: request.config,
        payload: request.payload,
        expectedRevision: 0n,
      });
    },
    onSuccess: (snapshot) => {
      invalidate();
      setTab("plans");
      focus(snapshot.plan?.id ?? null);
    },
    onError: fail,
  });

  /** Cards on this board that reference a plan, so removal can be offered. */
  const cardFor = React.useCallback(
    (planId: string) =>
      nodes?.find(
        (node) =>
          node.data.kind === "automation" && node.data.planId === planId,
      ) ?? null,
    [nodes],
  );

  function showOnCanvas(snapshot: AutomationPlanSnapshot) {
    const plan = snapshot.plan;
    if (!plan || !workspaceId) return;
    const kind = scheduleKind(plan.config);
    const zone =
      plan.config?.schedule?.kind?.case === "cron"
        ? plan.config.schedule.kind.value.timezone
        : undefined;
    addNode("automation", {
      title: plan.config?.title || plan.id,
      position: currentViewportCenter(),
      data: {
        kind: "automation",
        planId: plan.id,
        planWorkspaceId: workspaceId,
        executionHostId: hostId,
        ...(kind ? { scheduleKind: kind } : {}),
        ...(zone ? { timezone: zone } : {}),
      },
    });
  }

  const busy =
    activate.isPending ||
    pause.isPending ||
    runNow.isPending ||
    createPlan.isPending;

  const blocked = state.status === "blocked" ? state.reason : null;
  const focused = plans.data?.find(
    (snapshot) => snapshot.plan?.id === focusPlanId,
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setPanel("automation", "closed");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-w-full gap-0 p-0 data-[side=right]:w-[min(100vw,var(--scm-w))] data-[side=right]:sm:max-w-none"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
            {t("automation.title")}
          </SheetTitle>
          {state.status === "ready" && !canManage && (
            <Badge variant="outline" className="ml-2 truncate">
              {t("automation.readOnly")}
            </Badge>
          )}
          <div className="flex-1" />
          {client && (
            <IconButton label={t("automation.reload")} onClick={invalidate}>
              <RotateCw />
            </IconButton>
          )}
          <IconButton
            label={t("automation.cancel")}
            onClick={() => setPanel("automation", "closed")}
          >
            <X />
          </IconButton>
        </div>

        {blocked ? (
          <div
            role="status"
            className="min-w-0 space-y-3 p-4 text-[13px] leading-5"
          >
            <p className="text-muted-foreground">
              {t(`automation.blocked.${blocked}`)}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="min-h-10"
              onClick={() => {
                setPanel("automation", "closed");
                usePreferencesStore.getState().setLastSettingsSection("host");
                setPanel("settings", true);
              }}
            >
              {t("automation.blocked.action")}
            </Button>
          </div>
        ) : !client ? (
          <p role="status" className="p-4 text-[13px] text-muted-foreground">
            {t("automation.loading")}
          </p>
        ) : (
          <Tabs
            value={tab}
            onValueChange={(value) =>
              setTab(value as "plans" | "runs" | "create")
            }
            className="min-h-0 min-w-0 flex-1 gap-0"
          >
            <TabsList
              className="h-10 w-full shrink-0 rounded-none border-b border-border"
              variant="line"
            >
              {(["plans", "runs", "create"] as const).map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="min-w-0 text-xs"
                  disabled={value === "create" && !canManage}
                >
                  {t(`automation.tab.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent
              value="plans"
              className="mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden"
            >
              <ScrollArea className="min-h-0 flex-1">
                <div className="min-w-0 space-y-2 p-3">
                  {plans.isError && (
                    <p role="status" className="text-[12px] text-destructive">
                      {t(failureKey(plans.error))}
                    </p>
                  )}
                  {plans.isSuccess && plans.data.length === 0 && (
                    <p className="text-[12px] text-muted-foreground">
                      {t("automation.empty")}
                    </p>
                  )}
                  {plans.data?.map((snapshot) => (
                    <PlanRow
                      key={snapshot.plan?.id}
                      snapshot={snapshot}
                      locale={locale}
                      canManage={canManage}
                      busy={busy}
                      hasCard={Boolean(cardFor(snapshot.plan?.id ?? ""))}
                      onActivate={() => activate.mutate(snapshot)}
                      onPause={() => pause.mutate(snapshot)}
                      onRunNow={() => runNow.mutate(snapshot)}
                      onViewRuns={() => revealRuns(snapshot.plan?.id ?? "")}
                      onShowOnCanvas={() => showOnCanvas(snapshot)}
                      onDetach={() => {
                        const card = cardFor(snapshot.plan?.id ?? "");
                        if (card) removeNodes([card.id]);
                      }}
                      onDisableAndDetach={async () => {
                        await pause.mutateAsync(snapshot).catch(() => null);
                        const card = cardFor(snapshot.plan?.id ?? "");
                        if (card) removeNodes([card.id]);
                      }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent
              value="runs"
              className="mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden"
            >
              <ScrollArea className="min-h-0 flex-1">
                <RunHistory
                  client={client}
                  workspaceId={workspaceId ?? ""}
                  plans={plans.data ?? []}
                  planId={focused?.plan?.id ?? focusPlanId}
                  locale={locale}
                  onSelect={(planId) => focus(planId)}
                />
              </ScrollArea>
            </TabsContent>

            <TabsContent
              value="create"
              className="mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden"
            >
              <ScrollArea className="min-h-0 flex-1">
                {canManage && workspaceId ? (
                  <CreatePlanForm
                    // A prefilled draft is one request, not a mode: remounting
                    // on `compose` is what makes a second request start over
                    // instead of quietly reusing the first one's state.
                    key={`create-${compose}`}
                    client={client}
                    hostId={hostId}
                    workspaceId={workspaceId}
                    busy={busy}
                    prefill={prefill}
                    onCreate={(request) => {
                      clearPrefill();
                      createPlan.mutate(request);
                    }}
                  />
                ) : (
                  <p className="p-3 text-[12px] text-muted-foreground">
                    {t("automation.readOnly")}
                  </p>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}
