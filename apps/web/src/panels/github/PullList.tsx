import type { GithubPullRequest } from "@armadra/host-client";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useT } from "@/app/preferences-store";
import { Freshness } from "./Freshness";
import { instant, pullStateKey, shortSha } from "./model";
import type { PullPage } from "./queries";

export interface PullListProps {
  page: PullPage;
  locale: string;
  onOpen: (pull: GithubPullRequest) => void;
}

export function PullList({ page, locale, onOpen }: PullListProps) {
  const t = useT();
  return (
    <div className="min-w-0 space-y-2 p-3">
      <Freshness meta={page} locale={locale} />
      {page.pulls.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t("github.pulls.empty")}
        </p>
      )}
      {page.pulls.map((pull) => (
        <article
          key={String(pull.number)}
          data-slot="github-pull"
          data-pull-number={String(pull.number)}
          className="min-w-0 space-y-2 rounded-lg border border-border px-3 py-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              #{String(pull.number)}
            </span>
            <h4 className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {pull.title}
            </h4>
            <Badge variant="secondary">{t(pullStateKey(pull))}</Badge>
            {pull.draft && (
              <Badge variant="outline">{t("github.pull.draft")}</Badge>
            )}
            {pull.fromFork && (
              <Badge variant="outline">{t("github.pull.fork")}</Badge>
            )}
          </div>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">{t("github.pull.base")}</dt>
            <dd className="min-w-0 truncate">{pull.baseRef}</dd>
            <dt className="text-muted-foreground">{t("github.pull.head")}</dt>
            <dd
              className="min-w-0 truncate font-mono"
              title={pull.headSha || undefined}
            >
              {pull.headRef} · {shortSha(pull.headSha)}
            </dd>
            <dt className="text-muted-foreground">
              {t("github.issue.updatedAt")}
            </dt>
            <dd className="min-w-0 truncate">
              {instant(pull.updatedAtUnixMs, locale) ??
                t("github.settings.unknown")}
            </dd>
          </dl>
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10"
            onClick={() => onOpen(pull)}
          >
            {t("github.pull.open")}
          </Button>
        </article>
      ))}
    </div>
  );
}
