import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { runtimeApi } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";

export function LegacyArchives() {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [visibleLabels, setVisibleLabels] = useState(30);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archives = useInfiniteQuery({
    queryKey: ["legacy-kanban-archives"],
    queryFn: ({ pageParam, signal }) =>
      runtimeApi.legacyKanbanArchives(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["legacy-kanban-archive", selected],
    queryFn: ({ signal }) => runtimeApi.legacyKanbanArchive(selected!, signal),
    enabled: selected !== null,
    retry: false,
  });
  const download = async () => {
    if (selected === null || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const value = await runtimeApi.exportLegacyKanbanArchive(selected);
      const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `legacy-kanban-${value.archive.canvasId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}.json`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("legacyArchive.exportFailed"),
      );
    } finally {
      setExporting(false);
    }
  };
  return (
    <section
      aria-label={t("legacyArchive.title")}
      className="min-w-0 space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {t("legacyArchive.title")}
        </h3>
        <Badge variant="outline">{t("legacyArchive.readonly")}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("legacyArchive.description")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("legacyArchive.localScope")}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void archives.refetch()}
        disabled={archives.isFetching}
      >
        {t("legacyArchive.refresh")}
      </Button>
      {archives.isPending && (
        <p role="status" className="text-xs">
          {t("legacyArchive.loading")}
        </p>
      )}
      {(archives.error || detail.error || error) && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error ??
            archives.error?.message ??
            detail.error?.message ??
            t("legacyArchive.failed")}
        </p>
      )}
      {archives.data?.pages
        .flatMap((page) => page.archives)
        .map((archive) => (
          <div
            key={archive.canvasId}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border p-3 text-xs"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-words font-medium">
                {archive.workspaceName || t("legacyArchive.unknownName")} /{" "}
                {archive.canvasName || t("legacyArchive.unknownName")}
              </p>
              <p className="break-all text-muted-foreground">
                {archive.archivedAt} · {archive.kanbanBytes} B ·{" "}
                {archive.labelCount}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSelected(archive.canvasId);
                setVisibleLabels(30);
                setError(null);
              }}
            >
              {t("legacyArchive.view")}
            </Button>
          </div>
        ))}
      {archives.data?.pages.every((page) => page.archives.length === 0) && (
        <p className="text-xs text-muted-foreground">
          {t("legacyArchive.empty")}
        </p>
      )}
      {archives.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={archives.isFetching}
          onClick={() => void archives.fetchNextPage()}
        >
          {t("legacyArchive.more")}
        </Button>
      )}
      {selected !== null && detail.isPending && (
        <p role="status" className="text-xs">
          {t("legacyArchive.loading")}
        </p>
      )}
      {detail.data && (
        <div className="min-w-0 space-y-3 border-t border-border pt-3">
          <dl className="space-y-2 text-xs">
            {[
              [t("legacyArchive.workspace"), detail.data.workspaceName],
              [t("legacyArchive.canvas"), detail.data.canvasName],
              [t("legacyArchive.workspaceId"), detail.data.workspaceId],
              [t("legacyArchive.canvasId"), detail.data.canvasId],
              [t("legacyArchive.captured"), detail.data.archivedAt],
              [t("legacyArchive.sha"), detail.data.kanbanSha256],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
          <Button
            size="sm"
            variant="outline"
            disabled={exporting}
            onClick={() => void download()}
          >
            {t("legacyArchive.export")}
          </Button>
          <h4 className="text-xs font-medium">{t("legacyArchive.raw")}</h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 text-[11px]">
            {detail.data.kanbanJson}
          </pre>
          <h4 className="text-xs font-medium">
            {t("legacyArchive.labels")} ({detail.data.labels.length})
          </h4>
          {detail.data.labels.slice(0, visibleLabels).map((label) => (
            <details
              key={label.nodeId}
              className="min-w-0 rounded-md border border-border p-2 text-xs"
            >
              <summary className="cursor-pointer break-words">
                {label.nodeTitle || label.nodeId}
              </summary>
              <p className="break-all py-2">
                {t("legacyArchive.nodeId")}: {label.nodeId}
              </p>
              <p>{t("legacyArchive.labelsJson")}</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all py-2">
                {label.labelsJson}
              </pre>
              <p>{t("legacyArchive.note")}</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all py-2">
                {label.note}
              </pre>
            </details>
          ))}
          {visibleLabels < detail.data.labels.length && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setVisibleLabels((count) => count + 30)}
            >
              {t("legacyArchive.moreLabels")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
