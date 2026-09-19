import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useT } from "@/app/preferences-store";
import { checkConclusionKey, failureKey } from "./model";
import { githubKeys } from "./queries";
import {
  GithubApi,
  GithubCheckConclusion,
  GithubCheckSummary,
  GithubRepositoryRef,
  GithubWriteState,
  RerunGithubChecksResponse,
} from "../../api/github";

export interface ChecksSectionProps {
  client: GithubApi;
  repository: GithubRepositoryRef;
  number: bigint;
  headSha: string;
  checks: GithubCheckSummary | undefined;
  canWrite: boolean;
  busy: boolean;
}

/**
 * CI 结果，以及**远端确实开放重跑**的那几个的重跑入口（设计 §8「检查」）。
 *
 * 不是所有 check 都能重启：只有 GitHub Actions 的 workflow run 有这个接口，
 * 所以按钮只出现在 `rerunnable` 为真的行上——这个标记来自产生它的 app，不是
 * 从名字猜的。重跑带着页面上显示的那个 head 发出去，head 变了 Host 会拒绝，
 * 而不是把重跑打到另一个 commit 上。
 */
export function ChecksSection({
  client,
  repository,
  number,
  headSha,
  checks,
  canWrite,
  busy,
}: ChecksSectionProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] =
    React.useState<RerunGithubChecksResponse | null>(null);

  const rerun = useMutation({
    mutationFn: (checkName: string) =>
      client.rerunChecks({
        repository,
        number,
        expectedHeadSha: headSha,
        checkName,
        // 只重跑没过的那些 job：改好一个 job 之后没必要把整条流水线再烧一遍。
        failedOnly: true,
      }),
    onSuccess: (result) => {
      setOutcome(result);
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
    onError: (error: unknown) => toast.error(t(failureKey(error))),
  });

  const runs = checks?.runs ?? [];
  // Only a run that did not succeed is worth restarting, and only one the
  // remote said can be.
  const restartable = runs.filter(
    (run) =>
      run.rerunnable &&
      run.conclusion !== GithubCheckConclusion.SUCCESS &&
      run.conclusion !== GithubCheckConclusion.PENDING,
  );

  return (
    <section className="min-w-0 space-y-1" data-slot="github-checks">
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("github.pull.checks")}
      </h4>
      {runs.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {t("github.pull.noChecks")}
        </p>
      ) : (
        <>
          <p className="text-[12px]">
            {t("github.pull.checkRollup")} ·{" "}
            {t(checkConclusionKey(checks!.rollup))}
          </p>
          <ul className="min-w-0 space-y-1 text-[12px]">
            {runs.map((run) => (
              <li
                key={`${run.app}:${run.name}`}
                className="flex min-w-0 items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">{run.name}</span>
                <Badge variant="outline">
                  {t(checkConclusionKey(run.conclusion))}
                </Badge>
                {/*
                  没有 rerun 接口的 check 不画按钮：一个点了什么都不会发生的
                  「重跑」比没有按钮更糟。
                */}
                {canWrite &&
                  run.rerunnable &&
                  run.conclusion !== GithubCheckConclusion.SUCCESS && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-h-8 shrink-0"
                      data-slot="github-rerun"
                      data-check={run.name}
                      disabled={busy || rerun.isPending || !headSha}
                      onClick={() => rerun.mutate(run.name)}
                    >
                      {t("github.checks.rerun")}
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          {canWrite && restartable.length > 1 && (
            <Button
              size="sm"
              variant="secondary"
              className="min-h-9"
              data-slot="github-rerun-all"
              disabled={busy || rerun.isPending || !headSha}
              onClick={() => rerun.mutate("")}
            >
              {t("github.checks.rerunAll", {
                count: String(restartable.length),
              })}
            </Button>
          )}
          {canWrite && runs.length > 0 && restartable.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t("github.checks.noRerun")}
            </p>
          )}
        </>
      )}

      {outcome && (
        <p
          role="status"
          data-slot="github-rerun-outcome"
          className="text-[11px] text-muted-foreground"
        >
          {outcome.reasonCode
            ? `${t("github.checks.notRerun")} · ${outcome.reasonCode}`
            : t("github.checks.rerunRequested", {
                count: String(
                  outcome.outcomes.filter(
                    (entry) => entry.state === GithubWriteState.APPLIED,
                  ).length,
                ),
              })}
          {/*
            结果没读到的那一条单独说：它可能已经排上了，重发一次就是第二条
            流水线，所以界面不提供「再试一次」。
          */}
          {outcome.outcomes.some(
            (entry) => entry.state === GithubWriteState.PENDING,
          )
            ? ` · ${t("github.checks.rerunUnknown")}`
            : ""}
        </p>
      )}
    </section>
  );
}
