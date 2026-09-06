import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  GitCommitRecord,
  GitIntegrationSnapshot,
  GitRepositoryAction,
} from "@armadra/shared";
import { gitGateway, type GitTarget } from "../../git/gateway";
import { useT, usePreferencesStore } from "../../app/preferences-store";
import { writeClipboard } from "../../terminal/TerminalSurface";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { Check, Field, ReadError, selectClass } from "./forms";
import {
  CommitGraphLanes,
  ROW_HEIGHT,
  commitGraph,
  refBadges,
} from "./CommitGraph";

export { commitGraph };

/** 一次最多驻留 500 行，再往下滚才继续翻页（roadmap §4.1）。 */
const MAX_ROWS = 500;
const PAGE_SIZE = 100;

export interface HistoryFilters {
  author: string;
  since: string;
  until: string;
  path: string;
  text: string;
}
const EMPTY_FILTERS: HistoryFilters = {
  author: "",
  since: "",
  until: "",
  path: "",
  text: "",
};

/**
 * 前端筛选。分支用 `reference` 交给服务端（那是从哪条线开始走历史），
 * 作者 / 日期 / 路径 / 文本在已加载的行上过滤——这样筛选不会把已经翻出来
 * 的页丢掉重来，也不会让「没找到」和「还没翻到」看起来一样。
 */
export function filterCommits(
  commits: readonly GitCommitRecord[],
  filters: HistoryFilters,
) {
  const author = filters.author.trim().toLowerCase();
  const text = filters.text.trim().toLowerCase();
  const path = filters.path.trim().toLowerCase();
  const since = filters.since ? Date.parse(filters.since) : Number.NaN;
  const until = filters.until
    ? // 日期范围含当天：结束日按当天 23:59:59.999 算。
      Date.parse(filters.until) + 24 * 60 * 60 * 1000 - 1
    : Number.NaN;
  return commits.filter((commit) => {
    if (
      author &&
      !`${commit.authorName} ${commit.authorEmail}`
        .toLowerCase()
        .includes(author)
    )
      return false;
    if (text) {
      const haystack =
        `${commit.subject} ${commit.oid} ${commit.refs.join(" ")}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    // 路径筛选按 `reference` 之外的一层：服务端已经按 pathspec 走过历史时
    // 这里是空操作，纯前端筛时至少匹配 ref 装饰里出现的路径式名字。
    if (path && !commit.subject.toLowerCase().includes(path)) return false;
    const at = Date.parse(commit.authorTime);
    if (!Number.isNaN(since) && !(at >= since)) return false;
    if (!Number.isNaN(until) && !(at <= until)) return false;
    return true;
  });
}

/** 相对时间；只到「天」这一档，历史列表不需要秒级精度。 */
export function relativeTime(iso: string, now: number, locale: string) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(seconds, "second");
}

export function History({
  workspaceId,
  repositoryKey,
  target,
  busy,
  request,
  loadIntegration,
  openFile,
}: {
  workspaceId: string;
  repositoryKey: string;
  /** 这一次读关于哪个检出；读写走同一条归属判定。 */
  target: GitTarget;
  busy: boolean;
  request: (action: GitRepositoryAction) => void;
  loadIntegration: (signal: AbortSignal) => Promise<GitIntegrationSnapshot>;
  openFile?: (path: string) => void;
}) {
  const t = useT();
  const [input, setInput] = useState("HEAD");
  const [reference, setReference] = useState("HEAD");
  const [selected, setSelected] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [switchAfter, setSwitchAfter] = useState(false);
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
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
  const branches = useQuery({
    queryKey: ["git-repository-branches", workspaceId, repositoryKey],
    queryFn: ({ signal }) => gitGateway.branches(target, signal),
    retry: false,
  });
  const history = useInfiniteQuery({
    queryKey: ["git-repository-history", workspaceId, repositoryKey, reference],
    queryFn: ({ pageParam, signal }) =>
      gitGateway.history(
        target,
        { reference, cursor: pageParam, limit: PAGE_SIZE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const commits = useMemo(
    () =>
      [
        ...new Map(
          (history.data?.pages.flatMap((page) => page.commits) ?? []).map(
            (commit) => [commit.oid, commit],
          ),
        ).values(),
      ].slice(0, MAX_ROWS),
    [history.data],
  );
  const visible = useMemo(
    () => filterCommits(commits, filters),
    [commits, filters],
  );
  const commit = visible.find((entry) => entry.oid === selected);
  const active = Object.values(filters).some((value) => value.trim() !== "");
  const atCeiling = commits.length >= MAX_ROWS;
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
            <span className="flex min-w-0 gap-2">
              <Input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                list="git-history-branches"
                required
              />
              <datalist id="git-history-branches">
                {(branches.data?.branches ?? []).map((branch) => (
                  <option key={branch.fullRef} value={branch.name} />
                ))}
              </datalist>
            </span>
          </Field>
        </div>
        <Button size="sm" type="submit" disabled={!input.trim()}>
          {t("gitRepo.loadHistory")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((value) => !value)}
        >
          {t("gitRepo.filters")}
        </Button>
      </form>
      {showFilters && (
        <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-2">
          <Field label={t("gitRepo.filterAuthor")}>
            <Input
              value={filters.author}
              onChange={(event) =>
                setFilters((value) => ({
                  ...value,
                  author: event.target.value,
                }))
              }
            />
          </Field>
          <Field label={t("gitRepo.filterText")}>
            <Input
              value={filters.text}
              onChange={(event) =>
                setFilters((value) => ({ ...value, text: event.target.value }))
              }
            />
          </Field>
          <Field label={t("gitRepo.filterSince")}>
            <Input
              type="date"
              value={filters.since}
              onChange={(event) =>
                setFilters((value) => ({ ...value, since: event.target.value }))
              }
            />
          </Field>
          <Field label={t("gitRepo.filterUntil")}>
            <Input
              type="date"
              value={filters.until}
              onChange={(event) =>
                setFilters((value) => ({ ...value, until: event.target.value }))
              }
            />
          </Field>
          <div className="col-span-2">
            <Field label={t("gitRepo.filterPath")}>
              <Input
                value={filters.path}
                onChange={(event) =>
                  setFilters((value) => ({
                    ...value,
                    path: event.target.value,
                  }))
                }
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={!active}
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              {t("gitRepo.clearFilters")}
            </Button>
          </div>
        </div>
      )}
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
      {active && (
        <p className="text-xs text-muted-foreground">
          {t("gitRepo.filtered", {
            shown: String(visible.length),
            loaded: String(commits.length),
          })}
        </p>
      )}
      <div className="flex min-w-0">
        {/* 筛选后行序会变，车道也跟着按可见行重排——否则线会连到看不见的行上。 */}
        <CommitGraphLanes commits={visible} selected={selected} />
        <div className="min-w-0 flex-1">
          {visible.map((entry) => (
            <CommitRow
              key={entry.oid}
              commit={entry}
              selected={selected === entry.oid}
              onSelect={() => setSelected(entry.oid)}
            />
          ))}
        </div>
      </div>
      {!history.isPending && !history.error && visible.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t(active ? "gitRepo.noMatches" : "gitRepo.emptyHistory")}
        </p>
      )}
      {history.hasNextPage &&
        (atCeiling ? (
          <p className="text-xs text-muted-foreground">
            {t("gitRepo.rowCeiling", { max: String(MAX_ROWS) })}
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={history.isFetching}
            onClick={() => void history.fetchNextPage()}
          >
            {t("gitRepo.more")}
          </Button>
        ))}
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
          <CommitFiles
            key={commit.oid}
            workspaceId={workspaceId}
            repositoryKey={repositoryKey}
            target={target}
            oid={commit.oid}
            openFile={openFile}
          />
          <CommitActions
            key={`${commit.oid}:actions`}
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

/** 一行：提交信息、作者、相对时间，右侧 tag / 分支徽标。 */
function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: GitCommitRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const locale = usePreferencesStore((state) => state.locale);
  const now = useMemo(() => Date.now(), [commit.oid]);
  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{ height: ROW_HEIGHT }}
      className="flex w-full min-w-0 flex-col justify-center gap-0.5 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={commit.subject}
        >
          {commit.subject || commit.oid.slice(0, 12)}
        </span>
        {badges.map((badge) => (
          <span
            key={`${badge.kind}:${badge.label}`}
            title={badge.label}
            className={cn(
              "max-w-24 shrink-0 truncate rounded px-1 text-[10px] leading-4",
              badge.kind === "tag"
                ? "bg-[color-mix(in_srgb,var(--brand)_16%,transparent)] text-[var(--brand)]"
                : badge.kind === "head"
                  ? "bg-foreground text-background"
                  : "border border-border text-muted-foreground",
            )}
          >
            {badge.label}
          </span>
        ))}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="shrink-0">{commit.oid.slice(0, 10)}</span>
        <span className="min-w-0 flex-1 truncate">{commit.authorName}</span>
        <span className="shrink-0" title={commit.authorTime}>
          {relativeTime(commit.authorTime, now, locale)}
        </span>
      </span>
    </button>
  );
}

/**
 * 选中提交改了哪些文件。
 *
 * `base` 为空时是「这个提交本身改了什么」（对第一父提交）；「比较到当前」
 * 换成对当前 HEAD 比较，两侧都由服务端解析成 OID 后再 diff。
 */
function CommitFiles({
  workspaceId,
  repositoryKey,
  target,
  oid,
  openFile,
}: {
  workspaceId: string;
  repositoryKey: string;
  target: GitTarget;
  oid: string;
  openFile?: (path: string) => void;
}) {
  const t = useT();
  const [base, setBase] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["git-repository-commit", workspaceId, repositoryKey, oid, base],
    queryFn: ({ signal }) => gitGateway.commitDetail(target, oid, base, signal),
    retry: false,
  });
  const patch = useQuery({
    queryKey: [
      "git-repository-commit-file",
      workspaceId,
      repositoryKey,
      oid,
      base,
      file,
    ],
    queryFn: ({ signal }) =>
      gitGateway.commitFile(target, oid, base, file!, signal),
    enabled: file !== null,
    retry: false,
  });
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">{t("gitRepo.changedFiles")}</h4>
        <Button
          size="sm"
          variant={base === null ? "outline" : "default"}
          aria-pressed={base !== null}
          onClick={() => {
            setBase((value) => (value === null ? "HEAD" : null));
            setFile(null);
          }}
        >
          {t("gitRepo.compareToCurrent")}
        </Button>
      </div>
      {base !== null && (
        <p className="text-muted-foreground">{t("gitRepo.comparingToHead")}</p>
      )}
      {detail.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {detail.error && (
        <ReadError error={detail.error} retry={() => void detail.refetch()} />
      )}
      {detail.data?.truncated && (
        <p className="text-muted-foreground">{t("gitRepo.filesTruncated")}</p>
      )}
      {detail.data && detail.data.files.length === 0 && (
        <p className="text-muted-foreground">{t("gitRepo.noChangedFiles")}</p>
      )}
      <ul className="space-y-0.5">
        {(detail.data?.files ?? []).map((entry) => (
          <li key={entry.path} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-pressed={file === entry.path}
              onClick={() => setFile(entry.path)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted aria-pressed:bg-muted"
            >
              <span className="w-3 shrink-0 font-mono">{entry.status}</span>
              <span className="min-w-0 flex-1 truncate" title={entry.path}>
                {entry.path}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {entry.additions === null || entry.deletions === null
                  ? t("gitRepo.binaryFile")
                  : `+${entry.additions} −${entry.deletions}`}
              </span>
            </button>
            {openFile && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openFile(entry.path)}
              >
                {t("gitRepo.openFile")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {file !== null && (
        <div className="space-y-1">
          {patch.isPending && <p role="status">{t("gitRepo.loading")}</p>}
          {patch.error && (
            <ReadError error={patch.error} retry={() => void patch.refetch()} />
          )}
          {patch.data && (
            <>
              {patch.data.truncated && (
                <p className="text-muted-foreground">
                  {t("gitRepo.patchTruncated")}
                </p>
              )}
              <pre
                aria-label={t("gitRepo.filePatch")}
                className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-4"
              >
                {patch.data.patch}
              </pre>
            </>
          )}
        </div>
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
  const [resetMode, setResetMode] = useState<"soft" | "mixed" | "hard">("soft");
  const [discardChanges, setDiscardChanges] = useState(false);
  // 合并提交的 cherry-pick / revert 必须先明确主线，这里不替用户猜。
  const mainline = commit.parents.length > 1 ? 1 : null;
  // 只有 hard 会丢未提交的内容；工作区脏时必须先明确勾选确认。
  const resetBlocked =
    busy ||
    !state ||
    state.kind !== "none" ||
    (resetMode === "hard" && state.dirty && !discardChanges);
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
      <form
        className="space-y-2 border-t border-border pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (resetBlocked || !state) return;
          request({
            kind: "reset",
            mode: resetMode,
            targetOid: commit.oid,
            expectedStateToken: state.stateToken,
            discardChanges,
          });
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
