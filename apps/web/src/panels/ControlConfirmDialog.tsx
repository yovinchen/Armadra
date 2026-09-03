import { useEffect, useState } from "react";
import { toast } from "sonner";

import { runtimeApi } from "../api/client";
import { onWorkspaceEvent } from "../api/events";
import { useT } from "../app/preferences-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

/**
 * 画布控制的人工确认（§5.8）。
 *
 * Runtime 的 `close` 动词不会自己动手：它发一条 `control.confirm`，然后**阻塞
 * 在一个 oneshot 上最多 130 秒**，等这里的「允许 / 拒绝」。所以：
 *
 *  - 关掉对话框 = 拒绝，不是「稍后再说」。让 Agent 挂满 130 秒再超时，
 *    只会让它以为是网络问题然后重试。
 *  - 摘要是 Runtime 生成的（`「谁」请求关闭「谁」`），不是 Agent 写的正文：
 *    请求方不能往这个对话框里塞话。
 *  - 一次只显示一条；等待中的其余请求排队，答完一条立刻显示下一条。
 */

export interface ControlConfirmRequest {
  requestId: string;
  verb: string;
  nodeId: string;
  summary: string;
}

export function ControlConfirmDialog() {
  const t = useT();
  const [queue, setQueue] = useState<ControlConfirmRequest[]>([]);
  const current = queue[0];

  useEffect(
    () =>
      onWorkspaceEvent("control.confirm", (event) => {
        setQueue((pending) =>
          pending.some((item) => item.requestId === event.requestId)
            ? pending
            : [
                ...pending,
                {
                  requestId: event.requestId,
                  verb: event.verb,
                  nodeId: event.nodeId,
                  summary: event.summary,
                },
              ],
        );
      }),
    [],
  );

  const answer = (approve: boolean) => {
    if (!current) return;
    const { requestId } = current;
    setQueue((pending) =>
      pending.filter((item) => item.requestId !== requestId),
    );
    void runtimeApi
      .confirmControl(requestId, approve)
      .then((result) => {
        // 那边已经等超时了：说一声，不然用户会以为自己刚点的那下生效了。
        if (!result.accepted) toast.info(t("confirm.expired"));
      })
      .catch((cause: Error) => toast.error(cause.message));
  };

  return (
    <AlertDialog
      open={Boolean(current)}
      // 关掉即拒绝：Runtime 那边正阻塞着，没有「什么都不做」这个选项。
      onOpenChange={(open) => {
        if (!open) answer(false);
      }}
    >
      <AlertDialogContent className="z-[var(--z-dialog)]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>{current?.summary}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>
            {t("confirm.deny")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>
            {t("confirm.allow")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
