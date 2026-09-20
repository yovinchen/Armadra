import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

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
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [draft, setDraft] = React.useState<Record<string, string>>({});

  React.useEffect(
    () =>
      onNodeNamesRequest((nodeIds) => {
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
