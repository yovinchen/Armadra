import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";
import { instant } from "./model";
import type { ListMeta } from "./queries";

/**
 * What the Host last saw, next to the rows it answered with.
 *
 * Cached rows are labelled as cached and always carry the instant they were
 * observed: a list that silently presents an old answer as a live one is worse
 * than an empty one.
 */
export function Freshness({
  meta,
  locale,
}: {
  meta: ListMeta;
  locale: string;
}) {
  const t = useT();
  const observed = instant(meta.observedAtUnixMs, locale);
  const limit = meta.rateLimit;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      {meta.fromCache && (
        <Badge variant="outline">{t("github.fromCache")}</Badge>
      )}
      {observed && (
        <span className="min-w-0 truncate">
          {t("github.observedAt")} · {observed}
        </span>
      )}
      {limit && limit.limit > 0n && (
        <span className="tabular-nums">
          {t("github.rateLimit")} · {String(limit.remaining)}/
          {String(limit.limit)}
        </span>
      )}
      {limit?.throttled && (
        <span className="text-destructive">{t("github.rateThrottled")}</span>
      )}
      {meta.truncated && <span>{t("github.truncated")}</span>}
    </div>
  );
}
