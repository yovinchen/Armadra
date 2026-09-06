import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCw, X } from "lucide-react";
import {
  GithubIssueState,
  GithubReferenceKind,
  type GithubIssue,
  type GithubPullRequest,
} from "@armadra/host-client";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { WorkPanelSheet } from "../WorkPanelSheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useGithubSession } from "@/host/github-session";
import { useCanvasStore } from "@/store/canvas-store";
import { CreateIssueForm, type CreateIssueRequest } from "./CreateIssueForm";
import { CreatePullForm, type CreatePullRequestInput } from "./CreatePullForm";
import {
  EMPTY_FILTER,
  FilterBar,
  filterKey,
  issueFilter,
  pullFilter,
  type GithubFilterState,
} from "./Filters";
import { IssueDetail } from "./IssueDetail";
import { IssueList, type MoveIssueRequest } from "./IssueList";
import { PullDetail } from "./PullDetail";
import { PullList } from "./PullList";
import { RepositoryPicker } from "./RepositoryPicker";
import { StatusMappingEditor } from "./StatusMappingEditor";
import { linkReferenceTo } from "./link-targets";
import { failureKey, pollInterval, writeStateKey } from "./model";
import { useGithubFocus, type GithubTab } from "./open";
import { allIssues, allPulls, githubKeys } from "./queries";

/**
 * 右侧工作面板的「GitHub」页（Git/GitHub 设计 §1，画布平台设计 §4）。
 *
 * Host 没连上、没配对、没凭据时整页只显示原因和去设置的入口——不画一个点了
 * 会 401 的按钮。仓库来自解析一个 git 远端地址：解析结果说 host 不匹配时就
 * 停在那里，绝不改用公共服务再试一次。
 */
export function GithubDrawer() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const mode = useCanvasStore((state) => state.panels.github);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const state = useGithubSession((store) => store.state);
  const connect = useGithubSession((store) => store.connect);
  const focusTab = useGithubFocus((store) => store.tab);
  const focusNumber = useGithubFocus((store) => store.number);
  const reveal = useGithubFocus((store) => store.reveal);
  const focus = useGithubFocus((store) => store.focus);
  const queryClient = useQueryClient();

  const open = mode === "drawer";
  const workspaceId = workspace?.id ?? null;
  const [tab, setTab] = React.useState<GithubTab>("issues");
  const [remoteUrl, setRemoteUrl] = React.useState("");
  const [resolveUrl, setResolveUrl] = React.useState("");
  const [draft, setDraft] = React.useState<GithubFilterState>(EMPTY_FILTER);
  const [applied, setApplied] = React.useState<GithubFilterState>(EMPTY_FILTER);

  React.useEffect(() => {
    if (open) void connect(workspaceId);
  }, [connect, open, workspaceId]);
  React.useEffect(() => {
    if (open && reveal > 0) setTab(focusTab);
  }, [focusTab, open, reveal]);

  const client = state.status === "ready" ? state.client : null;
  const canWrite = state.status === "ready" && state.canWrite;
  const blocked = state.status === "blocked" ? state.reason : null;

  const resolved = useQuery({
    queryKey: githubKeys.repository(workspaceId ?? "", resolveUrl),
    queryFn: () => client!.resolveRepository(resolveUrl),
    enabled: open && Boolean(client) && resolveUrl.length > 0,
    retry: false,
  });
  const repository = resolved.data?.hostMismatch
    ? undefined
    : resolved.data?.repository?.ref;

  const mapping = useQuery({
    queryKey: githubKeys.mapping(workspaceId ?? "", repository),
    queryFn: () => client!.getStatusMapping(repository!),
    enabled: open && Boolean(client) && Boolean(repository),
    retry: false,
  });

  const issues = useQuery({
    queryKey: githubKeys.issues(
      workspaceId ?? "",
      repository,
      filterKey("issues", applied),
    ),
    queryFn: () => allIssues(client!, repository!, issueFilter(applied)),
    enabled: open && tab === "issues" && Boolean(client) && Boolean(repository),
    retry: false,
    // No webhook on a local Host: the panel polls at the interval the Host
    // asked for, and never while the panel is closed.
    refetchInterval: (query) =>
      open && tab === "issues"
        ? pollInterval(query.state.data?.pollIntervalMs)
        : false,
  });

  const pulls = useQuery({
    queryKey: githubKeys.pulls(
      workspaceId ?? "",
      repository,
      filterKey("pulls", applied),
    ),
    queryFn: () => allPulls(client!, repository!, pullFilter(applied)),
    enabled: open && tab === "pulls" && Boolean(client) && Boolean(repository),
    retry: false,
    refetchInterval: (query) =>
      open && tab === "pulls"
        ? pollInterval(query.state.data?.pollIntervalMs)
        : false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const move = useMutation({
    mutationFn: (request: MoveIssueRequest) =>
      client!.moveIssue({
        repository: repository!,
        number: request.issue.number,
        toGroupId: request.toGroupId,
        fromGroupId: request.fromGroupId,
        expectedUpdatedAtUnixMs: request.expectedUpdatedAtUnixMs,
        expectedMappingRevision: request.expectedMappingRevision,
      }),
    onSuccess: (result) => {
      // Every write is reported per item: a partly applied move must not read
      // as a clean success.
      for (const item of result.outcomes)
        toast.message(`${item.target} · ${t(writeStateKey(item.state))}`, {
          description: item.reasonCode || undefined,
        });
      invalidate();
    },
    onError: fail,
  });

  const setIssueState = useMutation({
    mutationFn: (input: { issue: GithubIssue; state: GithubIssueState }) =>
      client!.setIssueState({
        repository: repository!,
        number: input.issue.number,
        state: input.state,
        expectedUpdatedAtUnixMs: input.issue.updatedAtUnixMs,
      }),
    onSuccess: invalidate,
    onError: fail,
  });

  const createIssue = useMutation({
    mutationFn: (request: CreateIssueRequest) =>
      client!.createIssue({ repository: repository!, ...request }),
    onSuccess: invalidate,
    onError: fail,
  });

  const createPull = useMutation({
    mutationFn: async ({ target, ...input }: CreatePullRequestInput) => {
      const pull = await client!.createPull({
        repository: repository!,
        ...input,
      });
      // Only a target the user picked is linked, and a link that fails never
      // turns the created pull request into a reported failure.
      if (!target) return { pull, link: null };
      try {
        return {
          pull,
          link: await linkReferenceTo(client!, {
            repository: repository!,
            kind: GithubReferenceKind.PULL_REQUEST,
            number: pull.number,
            title: pull.title,
            target,
          }),
        };
      } catch {
        return { pull, link: "failed" as const };
      }
    },
    onSuccess: (result) => {
      if (result.link === "failed") toast.error(t("github.link.failed"));
      else if (result.link)
        toast.success(
          t(
            result.link === "already"
              ? "github.link.already"
              : "github.link.linked",
          ),
        );
      invalidate();
    },
    onError: fail,
  });

  const busy =
    move.isPending ||
    setIssueState.isPending ||
    createIssue.isPending ||
    createPull.isPending;

  const openIssue = (issue: GithubIssue) => focus("issues", issue.number);
  const openPull = (pull: GithubPullRequest) => focus("pulls", pull.number);

  return (
    <WorkPanelSheet
      panel="github"
      open={open}
      onClose={() => setPanel("github", "closed")}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
          {t("github.title")}
        </SheetTitle>
        {state.status === "ready" && !canWrite && (
          <Badge variant="outline" className="ml-2 truncate">
            {t("github.readOnly")}
          </Badge>
        )}
        <div className="flex-1" />
        {client && (
          <IconButton label={t("github.reload")} onClick={invalidate}>
            <RotateCw />
          </IconButton>
        )}
        <IconButton
          label={t("github.close")}
          onClick={() => setPanel("github", "closed")}
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
            {t(`github.blocked.${blocked}`)}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10"
            onClick={() => {
              setPanel("github", "closed");
              usePreferencesStore
                .getState()
                .setLastSettingsSection(
                  blocked === "noCredential" ? "github" : "host",
                );
              setPanel("settings", true);
            }}
          >
            {t(
              blocked === "noCredential"
                ? "github.blocked.credentialAction"
                : "github.blocked.action",
            )}
          </Button>
        </div>
      ) : !client ? (
        <p role="status" className="p-4 text-[13px] text-muted-foreground">
          {t("github.loading")}
        </p>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as GithubTab);
            focus(value as GithubTab, null);
          }}
          className="min-h-0 min-w-0 flex-1 gap-0"
        >
          <TabsList
            className="h-10 w-full shrink-0 rounded-none border-b border-border"
            variant="line"
          >
            {(["issues", "pulls"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="min-w-0 text-xs"
              >
                {t(`github.tab.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          <ScrollArea className="min-h-0 flex-1">
            <RepositoryPicker
              remoteUrl={remoteUrl}
              onRemoteUrl={setRemoteUrl}
              onResolve={() => setResolveUrl(remoteUrl.trim())}
              busy={resolved.isFetching}
              resolved={resolved.data}
            />
            {resolved.isError && (
              <p
                role="status"
                className="px-3 py-2 text-[12px] text-destructive"
              >
                {t(failureKey(resolved.error))}
              </p>
            )}
            {repository && (
              <FilterBar
                tab={tab}
                value={draft}
                onChange={setDraft}
                onApply={() => setApplied(draft)}
                busy={busy}
              />
            )}

            <TabsContent
              value="issues"
              className="mt-0 min-w-0 data-[state=inactive]:hidden"
            >
              {!repository ? (
                <p className="p-3 text-[12px] text-muted-foreground">
                  {t("github.noRepository")}
                </p>
              ) : focusNumber !== null && focusTab === "issues" ? (
                <IssueDetail
                  client={client}
                  workspaceId={workspaceId ?? ""}
                  repository={repository}
                  number={focusNumber}
                  locale={locale}
                  canWrite={canWrite}
                  open={open}
                  onBack={() => focus("issues", null)}
                />
              ) : (
                <>
                  <div className="min-w-0 px-3 pt-3">
                    <StatusMappingEditor
                      client={client}
                      repository={repository}
                      mapping={mapping.data}
                      canWrite={canWrite}
                    />
                  </div>
                  {issues.isError && (
                    <p
                      role="status"
                      className="px-3 pt-3 text-[12px] text-destructive"
                    >
                      {t(failureKey(issues.error))}
                    </p>
                  )}
                  {issues.data && (
                    <IssueList
                      page={issues.data}
                      mapping={mapping.data}
                      locale={locale}
                      canWrite={canWrite}
                      busy={busy}
                      onOpen={openIssue}
                      onMove={(request) => move.mutate(request)}
                      onSetState={(issue, next) =>
                        setIssueState.mutate({ issue, state: next })
                      }
                    />
                  )}
                  {canWrite && (
                    <div className="min-w-0 p-3 pt-0">
                      <CreateIssueForm
                        busy={busy}
                        onCreate={(request) => createIssue.mutate(request)}
                      />
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent
              value="pulls"
              className="mt-0 min-w-0 data-[state=inactive]:hidden"
            >
              {!repository ? (
                <p className="p-3 text-[12px] text-muted-foreground">
                  {t("github.noRepository")}
                </p>
              ) : focusNumber !== null && focusTab === "pulls" ? (
                <PullDetail
                  client={client}
                  workspaceId={workspaceId ?? ""}
                  repository={repository}
                  number={focusNumber}
                  locale={locale}
                  canWrite={canWrite}
                  open={open}
                  onBack={() => focus("pulls", null)}
                />
              ) : (
                <>
                  {pulls.isError && (
                    <p
                      role="status"
                      className="px-3 pt-3 text-[12px] text-destructive"
                    >
                      {t(failureKey(pulls.error))}
                    </p>
                  )}
                  {pulls.data && (
                    <PullList
                      page={pulls.data}
                      locale={locale}
                      onOpen={openPull}
                    />
                  )}
                  {canWrite && (
                    <div className="min-w-0 p-3 pt-0">
                      <CreatePullForm
                        busy={busy}
                        workspaceId={workspaceId ?? ""}
                        defaultBaseRef={
                          resolved.data?.repository?.defaultBranch ?? ""
                        }
                        onCreate={(input) => createPull.mutate(input)}
                      />
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>
      )}
    </WorkPanelSheet>
  );
}
