import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  GitIntegrationSnapshot,
  GitReflogEntry,
  GitReflogPage,
  GitRepositoryAction,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Check, Field, ReadError, selectClass } from "./forms";
import { Input } from "../../ui/input";
import { writeClipboard } from "../../terminal/TerminalSurface";
import {
  branchFromCommit,
  checkoutCommit,
  resetToCommit,
} from "./actions/commit";

export interface ReflogProps {
  workspaceId: string;
  repositoryKey: string;
  busy: boolean;
  loadPage: (
    reference: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<GitReflogPage>;
  /**
   * 当前的合并/冲突状态。reset 要拿它的 `stateToken`，也用它判断现在能不能
   * 动——在一次没结束的 rebase 中间 reset 回去，是把两个序列叠在一起。
   */
  loadState: (signal: AbortSignal) => Promise<GitIntegrationSnapshot>;
  request: (action: GitRepositoryAction) => void;
}

/**
 * 引用日志（Git 设计 §3「Reflog」）。
 *
 * 这是**找回**的入口，不是第二份历史：一次 reset 或 rebase 之后，被丢下的
 * 那个提交不再被任何引用指到，reflog 是唯一还记得它的地方。所以这一页的每
 * 一行都能直接接上现成的恢复动作——游离检出、从这里建分支、reset 回去——
 * 而且全部经同一个确认门，和历史页那些行动作一模一样。
 *
 * 分页按位置数，不按锚点：reflog 是往前面插的，没有一个不动的锚可以钉住窗
 * 口。每一行自己带 `loggedAt`，所以窗口滑动了是看得出来的。
 */
export function Reflog({
  workspaceId,
  repositoryKey,
  busy,
  loadPage,
  loadState,
  request,
}: ReflogProps) {
  const t = useT();
  const integration = useQuery({
    queryKey: ["git-repository-integration", workspaceId, repositoryKey],
    queryFn: ({ signal }) => loadState(signal),
    retry: false,
  });
  const state = integration.data;
  const [input, setInput] = useState("HEAD");
  const [reference, setReference] = useState("HEAD");
  const [selected, setSelected] = useState<string | null>(null);
  const log = useInfiniteQuery({
    queryKey: ["git-repository-reflog", workspaceId, repositoryKey, reference],
    queryFn: ({ pageParam, signal }) => loadPage(reference, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <div className="min-w-0 space-y-2 p-3 text-xs">
      <p className="text-muted-foreground">{t("gitRepo.reflogSafety")}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim()) return;
          setReference(input.trim());
          setSelected(null);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label={t("gitRepo.reflogReference")}>
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              required
            />
          </Field>
        </div>
        <Button size="sm" type="submit" disabled={!input.trim()}>
          {t("gitRepo.reflogLoad")}
        </Button>
      </form>
      {log.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {log.error && (
        <ReadError error={log.error} retry={() => void log.refetch()} />
      )}
      {log.data && entries.length === 0 && <p>{t("gitRepo.reflogEmpty")}</p>}
      <ol className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.selector} className="min-w-0">
            <button
              type="button"
              className="w-full rounded-md border border-border p-2 text-left hover:bg-accent"
              aria-expanded={selected === entry.selector}
              onClick={() =>
                setSelected(selected === entry.selector ? null : entry.selector)
              }
            >
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono">{entry.selector}</span>
                {entry.action && (
                  <span className="rounded bg-muted px-1">{entry.action}</span>
                )}
                <span className="min-w-0 flex-1 break-words">
                  {entry.message}
                </span>
              </span>
              <span className="flex flex-wrap gap-2 text-muted-foreground">
                <span className="font-mono">{entry.oid.slice(0, 12)}</span>
                <span>{entry.loggedAt}</span>
                <span>{entry.committerName}</span>
              </span>
            </button>
            {selected === entry.selector && (
              <ReflogActions
                entry={entry}
                state={state}
                busy={busy}
                request={request}
              />
            )}
          </li>
        ))}
      </ol>
      {log.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t("gitRepo.reflogMore")}
        </Button>
      )}
    </div>
  );
}

/**
 * 一条 reflog 上能做的三件事。
 *
 * 全部用**这一行自己的 OID**，不是选择器：`HEAD@{3}` 会随着新条目往前挤而
 * 指向别的东西，而 OID 是不动的。选择器留在界面上是给人看的，因为那才是他
 * 认出「就是这一刻」的凭据。
 */
function ReflogActions({
  entry,
  state,
  busy,
  request,
}: {
  entry: GitReflogEntry;
  state: GitIntegrationSnapshot | undefined;
  busy: boolean;
  request: (action: GitRepositoryAction) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [resetMode, setResetMode] = useState<"soft" | "mixed" | "hard">("soft");
  const [discardChanges, setDiscardChanges] = useState(false);
  // 只有 hard 会丢未提交的内容；工作区脏时必须先明确勾选确认。和历史页同一
  // 条规则，因为它就是同一个动作。
  const resetBlocked =
    busy ||
    !state ||
    state.kind !== "none" ||
    (resetMode === "hard" && state.dirty && !discardChanges);
  return (
    <div className="space-y-2 border-l border-border py-2 pl-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            writeClipboard(entry.oid);
            setCopied(true);
          }}
        >
          {t(copied ? "gitRepo.copiedOid" : "gitRepo.copyOid")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => request(checkoutCommit(entry.oid))}
        >
          {t("gitRepo.checkoutCommit")}
        </Button>
      </div>
      <p className="text-muted-foreground">{t("gitRepo.detachedSafety")}</p>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && branchName.trim())
            request(branchFromCommit(branchName.trim(), entry.oid, false));
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.branchFromCommit")}>
            <Input
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Button size="sm" type="submit" disabled={!branchName.trim()}>
            {t("gitRepo.createBranch")}
          </Button>
        </fieldset>
      </form>
      <form
        className="space-y-2 border-t border-border pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (resetBlocked || !state) return;
          request(
            resetToCommit(
              resetMode,
              entry.oid,
              state.stateToken,
              discardChanges,
            ),
          );
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.resetMode")}>
            <select
              className={selectClass}
              value={resetMode}
              onChange={(event) => {
                setResetMode(event.target.value as "soft" | "mixed" | "hard");
                setDiscardChanges(false);
              }}
            >
              {(["soft", "mixed", "hard"] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {t(`gitRepo.reset.${mode}`)}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-muted-foreground">
            {t(`gitRepo.resetSafety.${resetMode}`)}
          </p>
          {resetMode === "hard" && state?.dirty && (
            <Check
              label={t("gitRepo.resetDiscard")}
              checked={discardChanges}
              onChange={setDiscardChanges}
            />
          )}
          <Button
            size="sm"
            variant={resetMode === "hard" ? "destructive" : "outline"}
            type="submit"
            disabled={resetBlocked}
          >
            {t("gitRepo.reset")}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
