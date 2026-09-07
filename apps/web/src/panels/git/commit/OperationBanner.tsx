/**
 * 提交页顶部的操作横幅（Git 工具窗口设计 §2.3）。
 *
 * merge / rebase / cherry-pick / revert 卡在半路时，这条横幅说清三件事：卡在
 * 哪一步、还差什么、以及那三个出口。判断本身在 `actions/integration.ts`——
 * 页签版的整合页用的是同一组函数，两处不该对「什么时候能继续」各有一套说法。
 */
import type { GitIntegrationSnapshot } from "@armadra/shared";
import { AlertTriangle } from "lucide-react";
import { useT } from "../../../app/preferences-store";
import { Button } from "../../../ui/button";
import {
  integrationStatusKey,
  offersSkip,
  recoveryLabel,
  resumeAction,
  type IntegrationResume,
  type RepositoryRequest,
} from "../actions/integration";

export interface OperationBannerEntry {
  /** 工作空间相对路径。 */
  repositoryPath: string;
  name: string;
  state: GitIntegrationSnapshot;
}

export interface OperationBannerProps {
  entries: readonly OperationBannerEntry[];
  /** 有写在跑：三个出口一律先关掉，而不是排第二条命令。 */
  busy: boolean;
  showRepositories: boolean;
  onResume: (repositoryPath: string, request: RepositoryRequest) => void;
}

function Banner({
  entry,
  busy,
  showRepository,
  onResume,
}: {
  entry: OperationBannerEntry;
  busy: boolean;
  showRepository: boolean;
  onResume: (repositoryPath: string, request: RepositoryRequest) => void;
}) {
  const t = useT();
  const { state } = entry;
  const label = recoveryLabel(state.kind);
  const resume = (mode: IntegrationResume) => {
    const request = resumeAction(state, mode);
    if (request && !busy) onResume(entry.repositoryPath, request);
  };
  return (
    <section
      aria-label={t(`gitIntegration.kind.${state.kind}`)}
      className="min-w-0 space-y-2 border-b border-border bg-[color-mix(in_oklab,var(--warn)_12%,transparent)] px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AlertTriangle
          aria-hidden
          className="size-4 shrink-0 text-[var(--warn)]"
        />
        <span className="font-medium">
          {t(`gitIntegration.kind.${state.kind}`)}
        </span>
        {showRepository && (
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={entry.repositoryPath}
          >
            {entry.name}
          </span>
        )}
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {state.head.branch ?? t("gitRepo.detached")}
        </span>
        {state.conflicts.length > 0 && (
          <span className="text-[var(--danger)] tabular-nums">
            {t("gitCommit.group.conflicts")} {state.conflicts.length}
          </span>
        )}
      </div>
      {state.owned ? (
        <>
          <p role="status">{t(integrationStatusKey(state))}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !state.canContinue}
              onClick={() => resume("continue")}
            >
              {t(`gitIntegration.continue${label}`)}
            </Button>
            {offersSkip(state) && (
              <Button
                size="sm"
                variant={state.kind === "rebase" ? "destructive" : "outline"}
                disabled={busy || !state.canSkip}
                onClick={() => resume("skip")}
              >
                {t(
                  state.kind === "rebase"
                    ? "gitRepo.skipReplayedCommit"
                    : "gitRepo.skipIntegration",
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => resume("abort")}
            >
              {t(`gitIntegration.abort${label}`)}
            </Button>
          </div>
          {/* 跳过一个被重放的提交是丢弃它，不是「先放着」。 */}
          {state.kind === "rebase" && state.canSkip && (
            <p className="text-muted-foreground">
              {t("gitRepo.skipReplayedCommitHint")}
            </p>
          )}
        </>
      ) : (
        // 别的 Git 工具开的会话：这里没有它的 sessionId，按下去只会被拒。
        <div role="alert" className="space-y-1 text-[var(--warn)]">
          <p>{t("gitIntegration.external")}</p>
          <p>{t("gitIntegration.restart")}</p>
        </div>
      )}
    </section>
  );
}

export function OperationBanner({
  entries,
  busy,
  showRepositories,
  onResume,
}: OperationBannerProps) {
  if (entries.length === 0) return null;
  return (
    <div className="shrink-0">
      {entries.map((entry) => (
        <Banner
          key={entry.repositoryPath}
          entry={entry}
          busy={busy}
          showRepository={showRepositories}
          onResume={onResume}
        />
      ))}
    </div>
  );
}
