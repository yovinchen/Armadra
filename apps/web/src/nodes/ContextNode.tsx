import { useQuery, useQueryClient } from "@tanstack/react-query";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { NODE_COMMANDS } from "./actions";
import { estimateTokens, formatTokens } from "./helpers";
import { useNodeCommand } from "./useNodeCommand";
import type { NodeContentProps, OfKind } from "./types";

const CHIP_LIMIT = 3;

/** Context body: path, first children as chips and a rough token estimate. */
export function ContextNode({ id, data }: NodeContentProps) {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const context = data as OfKind<"context">;
  const queryClient = useQueryClient();

  const key = ["context-listing", workspace?.id, context.path];
  const listing = useQuery({
    queryKey: key,
    queryFn: () => runtimeApi.listFiles(workspace!.id, context.path),
    enabled: Boolean(workspace),
    retry: false,
  });

  useNodeCommand(NODE_COMMANDS.contextRefresh, id, () => {
    void queryClient.invalidateQueries({ queryKey: key });
  });

  const entries = listing.data?.entries ?? [];
  const visible = entries.slice(0, CHIP_LIMIT);
  const overflow = entries.length - visible.length;
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);

  return (
    <div className="context-body nodrag nowheel">
      <code className="context-path" title={context.path}>
        {context.path}
      </code>
      <div className="context-chips">
        {visible.map((entry) => (
          <span className="context-chip" key={entry.path}>
            {entry.name}
            {entry.kind === "directory" ? "/" : ""}
          </span>
        ))}
        {overflow > 0 && <span className="context-more">+{overflow}</span>}
        {listing.isPending && (
          <span className="context-more">{t("context.loading")}</span>
        )}
        {listing.isError && (
          <span className="context-more">{t("context.failed")}</span>
        )}
      </div>
      {entries.length > 0 && (
        <div className="context-tokens">
          {t("context.tokens", { count: formatTokens(estimateTokens(bytes)) })}
        </div>
      )}
      {context.excludePatterns.length > 0 && (
        <div className="context-excludes">
          {t("context.excludes", {
            patterns: context.excludePatterns.join(" · "),
          })}
        </div>
      )}
    </div>
  );
}
