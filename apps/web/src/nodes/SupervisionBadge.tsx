import type { CanvasNode } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { supervisionBadge, supervisionFor } from "@/canvas/supervision";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";

/**
 * 主从关系在节点头上的那一枚（连线角色）。
 *
 * 对等的节点什么都不画：对等是常态，把它写出来等于每个节点头多一个词。主画
 * 「主 · N 从」，从画「从 @某某」，上级已经不在画布上时画「主已离开」——那
 * 不是「没有上级」，是上级刚刚消失，而后者是人要知道的。
 */
export function SupervisionBadge({ node }: { node: CanvasNode }) {
  const t = useT();
  const document = useCanvasStore((state) => state.document);
  const badge = supervisionBadge(
    supervisionFor(node.id, document?.edges ?? [], document?.nodes ?? []),
  );
  if (badge === undefined) return null;
  const label =
    badge.kind === "supervisor"
      ? t("edge.role.supervisorBadge", { count: badge.count })
      : badge.kind === "subordinate"
        ? t("edge.role.subordinateBadge", { name: badge.name })
        : t("edge.role.orphanBadge");
  return (
    <Badge
      variant={badge.kind === "orphan" ? "outline" : "secondary"}
      className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
      data-slot="supervision-badge"
      data-role={badge.kind}
      title={label}
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}
