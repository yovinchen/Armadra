import * as React from "react";
import type { CanvasEdgeRole, CanvasNode } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { useCanvasStore } from "@/store/canvas-store";
import {
  holderOf,
  nodeName,
  normalizeName,
  onNodeNamesRequest,
  suggestName,
} from "./node-names";

/**
 * 起名的那一个对话框（设计 §2.2）。
 *
 * 规矩三条：
 *
 *   * **可以跳过。** 名字是给协作用的；跳过之后连线照样建立，`--to` 仍然收 id
 *     与标题。所以「取消」不是失败，默认按钮也不抢焦点之外的注意力。
 *   * **已经有名字的那一端不问。** 连线时两端各自缺名字的才出现在表单里——
 *     一条新线不该成为改掉旧名字的理由。
 *   * **撞名当场说是谁**，并把建议值换成下一个空位，不静默改写。
 */
export function NodeNameDialog() {
  const t = useT();
  const [asking, setAsking] = React.useState<readonly string[]>([]);
  // 这次是不是「刚拉完一条线」。只有那时才问角色——对等还是主从是一条边的
  // 属性，从节点菜单点开时没有边可问。
  const [edgeId, setEdgeId] = React.useState<string | undefined>();
  const [role, setRole] = React.useState<CanvasEdgeRole>("peer");
  const setEdgeRole = useCanvasStore((state) => state.setEdgeRole);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [draft, setDraft] = React.useState<Record<string, string>>({});

  React.useEffect(
    () =>
      onNodeNamesRequest((nodeIds, request) => {
        const board = useCanvasStore.getState().document?.nodes ?? [];
        // 一次请求里已经有名字的那些：只有被单独点开时才编辑它，连线时跳过。
        const wanted = nodeIds.filter((id) =>
          board.some((node) => node.id === id),
        );
        const fresh =
          wanted.length > 1
            ? wanted.filter((id) => {
                const node = board.find((entry) => entry.id === id);
                return node !== undefined && nodeName(node) === undefined;
              })
            : wanted;
        if (fresh.length === 0) return;
        const seeded: Record<string, string> = {};
        for (const id of fresh) {
          const node = board.find((entry) => entry.id === id);
          if (node === undefined) continue;
          seeded[id] = nodeName(node) ?? suggestName(board, node);
        }
        setDraft(seeded);
        setAsking(fresh);
        setEdgeId(request.edgeId);
        // 默认对等：主从是一句更强的话，要人自己说出口。
        setRole("peer");
      }),
    [],
  );

  const board = nodes ?? [];
  const editing = asking
    .map((id) => board.find((node) => node.id === id))
    .filter((node): node is CanvasNode => node !== undefined);

  const close = (): void => {
    setAsking([]);
    setDraft({});
    setEdgeId(undefined);
    setRole("peer");
  };

  /** 每一端各自的判定：空=清掉名字，形状不合法或撞名=不能确认。 */
  const verdicts = editing.map((node) => {
    const raw = draft[node.id] ?? "";
    if (raw.trim() === "") return { node, handle: undefined, problem: null };
    const handle = normalizeName(raw);
    if (handle === undefined) {
      return { node, handle: undefined, problem: t("node.name.invalid") };
    }
    const holder = holderOf(board, handle, node.id);
    const clash = editing.find(
      (other) =>
        other.id !== node.id && normalizeName(draft[other.id] ?? "") === handle,
    );
    if (holder !== undefined || clash !== undefined) {
      return {
        node,
        handle: undefined,
        problem: t("node.name.taken").replace(
          "{title}",
          (holder ?? clash)?.title ?? "",
        ),
      };
    }
    return { node, handle, problem: null };
  });
  const ready = verdicts.every((entry) => entry.problem === null);

  const confirm = (): void => {
    if (!ready) return;
    // 角色先落，名字后落：两者在同一次确认里，但角色属于那条边，与某一端的
    // 名字合法与否无关。
    if (edgeId !== undefined && role === "supervises") {
      setEdgeRole(edgeId, "supervises");
    }
    for (const entry of verdicts) {
      const current = nodeName(entry.node);
      if (current === entry.handle) continue;
      updateNodeData(entry.node.id, {
        handle: entry.handle,
      } as never);
    }
    close();
  };

  return (
    <Dialog open={editing.length > 0} onOpenChange={(open) => !open && close()}>
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{t("node.name.title")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          {verdicts.map((entry, index) => (
            <div key={entry.node.id} className="flex flex-col gap-1">
              <label
                className="text-xs text-[var(--muted-foreground)]"
                htmlFor={`node-name-${entry.node.id}`}
              >
                {entry.node.title}
              </label>
              <Input
                id={`node-name-${entry.node.id}`}
                autoFocus={index === 0}
                value={draft[entry.node.id] ?? ""}
                placeholder={t("node.name.placeholder")}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [entry.node.id]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  confirm();
                }}
              />
              {entry.problem === null ? null : (
                <span className="text-xs text-[var(--danger)]">
                  {entry.problem}
                </span>
              )}
            </div>
          ))}
          {/*
            这条线是对等还是主从（`source` 是主）。只在刚拉完一条线时出现，
            默认对等——主从是一句更强的话，要人自己说出口。
          */}
          {edgeId === undefined ? null : (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted-foreground)]">
                {t("edge.role.title")}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={role}
                onValueChange={(next) => {
                  if (next === "peer" || next === "supervises") setRole(next);
                }}
                aria-label={t("edge.role.title")}
              >
                <ToggleGroupItem value="peer">
                  {t("edge.role.peer")}
                </ToggleGroupItem>
                <ToggleGroupItem value="supervises">
                  {t("edge.role.supervisesOption")}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t("node.name.skip")}
            </Button>
            <Button type="submit" disabled={!ready}>
              {t("dialog.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
