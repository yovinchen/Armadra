import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  GitCommitRecord,
  GitIntegrationSnapshot,
  GitRepositoryAction,
} from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { writeClipboard } from "../../terminal/TerminalSurface";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { Check, Field, ReadError } from "./forms";

/** A lane represents a pending parent identity, never a row's ordinal number. */
export function commitGraph(commits: readonly GitCommitRecord[]) {
  const lanes: (string | null)[] = [];
  const points = new Map<string, { row: number; lane: number }>();
  for (const [row, commit] of commits.entries()) {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
    }
    points.set(commit.oid, { row, lane });
    lanes[lane] = null;
    for (const parent of commit.parents) {
      if (lanes.includes(parent) || points.has(parent)) continue;
      let slot = lanes.indexOf(null);
      if (slot < 0) slot = lanes.length;
      lanes[slot] = parent;
    }
  }
  const edges = commits.flatMap((commit) =>
    commit.parents.map((parent) => ({
      child: commit.oid,
      parent,
      from: points.get(commit.oid)!,
      to: points.get(parent),
    })),
  );
  return {
    points,
    edges,
    lanes: Math.max(1, ...[...points.values()].map((point) => point.lane + 1)),
  };
}

function HistoryGraph({ commits }: { commits: GitCommitRecord[] }) {
  const t = useT();
  const graph = useMemo(() => commitGraph(commits), [commits]);
  const x = (lane: number) => lane * 16 + 12;
  const y = (row: number) => row * 64 + 32;
  return (
    <div className="max-w-28 shrink-0 overflow-x-auto">
      <svg
        role="img"
        aria-label={t("gitRepo.graph")}
        width={graph.lanes * 16 + 16}
        height={commits.length * 64}
        className="text-[var(--brand)]"
      >
        {graph.edges.map((edge) => (
          <path
            key={`${edge.child}:${edge.parent}`}
            data-child={edge.child}
            data-parent={edge.parent}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={edge.to ? undefined : "3 3"}
            d={
              edge.to
                ? `M${x(edge.from.lane)},${y(edge.from.row)} C${x(edge.from.lane)},${y(edge.from.row) + 24} ${x(edge.to.lane)},${y(edge.to.row) - 24} ${x(edge.to.lane)},${y(edge.to.row)}`
                : `M${x(edge.from.lane)},${y(edge.from.row)} v20`
            }
          >
            <title>
              {edge.parent}
              {!edge.to ? ` — ${t("gitRepo.outsidePage")}` : ""}
            </title>
          </path>
        ))}
        {[...graph.points].map(([oid, point]) => (
          <circle
            key={oid}
            data-commit={oid}
            cx={x(point.lane)}
            cy={y(point.row)}
            r="3.5"
            fill="var(--background)"
            stroke="currentColor"
            strokeWidth="2"
          >
            <title>{oid}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export function History({
  workspaceId,
  repositoryKey,
  busy,
  request,
  loadIntegration,
}: {
  workspaceId: string;
  repositoryKey: string;
  busy: boolean;
  request: (action: GitRepositoryAction) => void;
  loadIntegration: (signal: AbortSignal) => Promise<GitIntegrationSnapshot>;
}) {
  const t = useT();
  const [input, setInput] = useState("HEAD");
  const [reference, setReference] = useState("HEAD");
  const [selected, setSelected] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [switchAfter, setSwitchAfter] = useState(false);
  // Cherry-pick and revert are confirmed against the repository state token,
  // which lives on the integration snapshot — the same one the Integrations
  // tab reads, so both entry points confirm against the same observation.
  const integration = useQuery({
    queryKey: ["git-repository-integration", workspaceId, repositoryKey],
    queryFn: ({ signal }) => loadIntegration(signal),
    retry: false,
  });
  const state = integration.data;
  const idle =
    !busy &&
    state?.kind === "none" &&
    !state.dirty &&
    state.conflicts.length === 0 &&
    Boolean(state.head.branch) &&
    Boolean(state.head.headOid);
  const history = useInfiniteQuery({
    queryKey: ["git-repository-history", workspaceId, repositoryKey, reference],
    queryFn: ({ pageParam, signal }) =>
      runtimeApi.gitRepositoryHistory(
        workspaceId,
        reference,
        pageParam,
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const commits = useMemo(
    () => [
      ...new Map(
        (history.data?.pages.flatMap((page) => page.commits) ?? []).map(
          (commit) => [commit.oid, commit],
        ),
      ).values(),
    ],
    [history.data],
  );
  const commit = commits.find((commit) => commit.oid === selected);
  return (
    <div className="space-y-3 p-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) {
            setReference(input.trim());
            setSelected(null);
          }
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label={t("gitRepo.reference")}>
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              required
            />
          </Field>
        </div>
        <Button size="sm" type="submit" disabled={!input.trim()}>
          {t("gitRepo.loadHistory")}
        </Button>
      </form>
      {history.isPending && (
        <p role="status" className="text-xs">
          {t("gitRepo.loading")}
        </p>
      )}
      {history.error && (
        <ReadError error={history.error} retry={() => void history.refetch()} />
      )}
      {history.data?.pages[0]?.shallow && (
        <p className="text-xs text-muted-foreground">{t("gitRepo.shallow")}</p>
      )}
      <div className="flex min-w-0">
        <HistoryGraph commits={commits} />
        <div className="min-w-0 flex-1">
          {commits.map((commit) => (
            <button
              key={commit.oid}
              type="button"
              aria-pressed={selected === commit.oid}
              onClick={() => setSelected(commit.oid)}
              className="flex h-16 w-full min-w-0 flex-col justify-center gap-1 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted"
            >
              <span
                className="w-full truncate text-xs font-medium"
                title={commit.subject}
              >
                {commit.subject || commit.oid.slice(0, 12)}
              </span>
              <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                {commit.oid.slice(0, 10)} · {commit.authorName}
              </span>
            </button>
          ))}
        </div>
      </div>
      {!history.isPending && !history.error && commits.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("gitRepo.emptyHistory")}
        </p>
      )}
      {history.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={history.isFetching}
          onClick={() => void history.fetchNextPage()}
        >
          {t("gitRepo.more")}
        </Button>
      )}
      {commit && (
        <section
          aria-label={t("gitRepo.details")}
          className="space-y-2 rounded-md border border-border p-3 text-xs"
        >
          <h3 className="break-words font-semibold">{commit.subject}</h3>
          <p className="break-all font-mono">{commit.oid}</p>
          <dl className="space-y-2">
            {[
              [
                t("gitRepo.author"),
                `${commit.authorName} <${commit.authorEmail}>`,
              ],
              [t("gitRepo.authorTime"), commit.authorTime],
              [t("gitRepo.committerTime"), commit.committerTime],
              [t("gitRepo.refs"), commit.refs.join(", ")],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-muted-foreground">{t("gitRepo.parents")}</dt>
              <dd>
                {commit.parents.length === 0
                  ? t("gitRepo.rootCommit")
                  : commit.parents.map((parent) => (
                      <p className="break-all font-mono" key={parent}>
                        {parent}
                      </p>
                    ))}
              </dd>
            </div>
          </dl>
          <CommitActions
            key={commit.oid}
            commit={commit}
            busy={busy}
            idle={idle}
            state={state}
            branchName={branchName}
            setBranchName={setBranchName}
            switchAfter={switchAfter}
            setSwitchAfter={setSwitchAfter}
            request={request}
          />
        </section>
      )}
    </div>
  );
}

/**
 * 历史行操作。每个动作都带上这一行的不可变 OID：界面上看到哪个提交，
 * 请求里就是哪个提交，服务再按 HEAD / state token 复核一次。
 */
function CommitActions({
  commit,
  busy,
  idle,
  state,
  branchName,
  setBranchName,
  switchAfter,
  setSwitchAfter,
  request,
}: {
  commit: GitCommitRecord;
  busy: boolean;
  idle: boolean;
  state: GitIntegrationSnapshot | undefined;
  branchName: string;
  setBranchName: (value: string) => void;
  switchAfter: boolean;
  setSwitchAfter: (value: boolean) => void;
  request: (action: GitRepositoryAction) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // 合并提交的 cherry-pick / revert 必须先明确主线，这里不替用户猜。
  const mainline = commit.parents.length > 1 ? 1 : null;
  const sequence = (kind: "startCherryPick" | "revert") => {
    if (!idle || !state) return;
    request(
      kind === "revert"
        ? {
            kind: "revert",
            targetOid: commit.oid,
            mainline,
            expectedStateToken: state.stateToken,
          }
        : {
            kind: "startCherryPick",
            targetOid: commit.oid,
            mainline,
            recordOrigin: true,
            expectedStateToken: state.stateToken,
          },
    );
  };
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            writeClipboard(commit.oid);
            setCopied(true);
          }}
        >
          {t(copied ? "gitRepo.copiedOid" : "gitRepo.copyOid")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            request({ kind: "checkoutCommit", targetOid: commit.oid })
          }
        >
          {t("gitRepo.checkoutCommit")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!idle}
          onClick={() => sequence("startCherryPick")}
        >
          {t("gitRepo.startCherryPick")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!idle}
          onClick={() => sequence("revert")}
        >
          {t("gitRepo.revert")}
        </Button>
      </div>
      <p className="text-muted-foreground">{t("gitRepo.detachedSafety")}</p>
      {!idle && <p className="text-muted-foreground">{t("gitRepo.notIdle")}</p>}
      {mainline !== null && (
        <p className="text-muted-foreground">{t("gitRepo.mergeMainline")}</p>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && branchName.trim())
            request({
              kind: "createBranch",
              name: branchName.trim(),
              startPoint: commit.oid,
              switch: switchAfter,
            });
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
          <Check
            label={t("gitRepo.switchAfterCreate")}
            checked={switchAfter}
            onChange={setSwitchAfter}
          />
          <Button size="sm" type="submit" disabled={!branchName.trim()}>
            {t("gitRepo.createBranch")}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
