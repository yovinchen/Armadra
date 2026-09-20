import type { CanvasNode } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { nodeName, requestNodeNames } from "./node-names";

/**
 * 节点头上的 `@名字`（设计 §2.3）。
 *
 * 没起名就什么都不画：名字是给协作用的，一块只有一个 Agent 的画布不需要它，
 * 而一个「未命名」占位会让每个节点头都多一个词。点一下就是改名——这个徽标是
 * 名字在界面上唯一的常驻位置，所以它也该是改名最近的那扇门。
 */
export function NodeNameBadge({ node }: { node: CanvasNode }) {
  const t = useT();
  const name = nodeName(node);
  if (name === undefined) return null;
  return (
    <Badge
      asChild
      variant="ghost"
      className="text-[var(--muted-foreground)]"
      data-no-drag="true"
    >
      <button
        type="button"
        aria-label={t("node.name.edit")}
        title={t("node.name.edit")}
        onClick={(event) => {
          event.stopPropagation();
          requestNodeNames([node.id]);
        }}
      >
        @{name}
      </button>
    </Badge>
  );
}
