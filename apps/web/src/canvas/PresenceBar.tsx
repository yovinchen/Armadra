import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { noDragProps } from "@/shell/window-region";
import { useCanvasStore } from "@/store/canvas-store";
import {
  applyPresence,
  currentPresence,
  isReadOnly,
  presenceClientId,
  presenceDeviceName,
} from "@/store/canvas/presence";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/**
 * 画布右上、工具簇左边的在线设备条（core JSON §9）。
 *
 * **只有自己时什么都不画**：单设备、单窗口是最常见的用法，那时这里一个像素
 * 都不占。有别的设备在看时每台一个小圆点，持有写租约的那台是主色；租约在
 * 别人手里时多一句「某设备正在编辑」和一个「接管」，接管要二次确认。
 * 这个人对这块工作空间没有写权限（服务器壳上的只读共享）时，哪怕只有自己
 * 也要画出来，写一句「只读」，不给「接管」——接管了也存不进去。
 */

/** 工具簇 14px 边距 + 38px 宽 + 8px 间距。 */
const RIGHT_OFFSET = "right-[60px]";

export function PresenceBar() {
  const t = useT();
  const queryClient = useQueryClient();
  const presence = useCanvasStore(currentPresence);
  const readOnly = useCanvasStore(isReadOnly);
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const [confirming, setConfirming] = React.useState(false);
  const me = presenceClientId();

  const others = presence?.clients.filter((client) => client.clientId !== me);
  const denied = presence?.writable === false;
  if (!presence || !others || (others.length === 0 && !denied)) return null;

  const lease = presence.lease;
  const nameOf = (deviceName: string) =>
    deviceName === "" ? t("presence.unnamed") : deviceName;
  const holder = lease ? nameOf(lease.deviceName) : "";
  const self = presence.clients.find((client) => client.clientId === me);
  const clients = self ? [self, ...others] : others;

  const takeOver = () => {
    if (!workspaceId) return;
    void runtimeApi
      .acquireLease(workspaceId, presence.boardId, {
        clientId: me,
        deviceName: presenceDeviceName(),
        takeover: true,
      })
      .then((snapshot) => {
        // 拿到租约的这一刻按远端重载：只读期间手里那份可能落后。
        if (applyPresence(snapshot).gained) {
          void queryClient.invalidateQueries({
            queryKey: ["board", workspaceId],
          });
        }
      })
      .catch(() => undefined);
  };

  return (
    <>
      <div
        data-slot="presence-bar"
        {...noDragProps()}
        aria-label={t("presence.label")}
        className={`absolute top-[14px] ${RIGHT_OFFSET} z-[var(--z-cluster)] flex h-[38px] items-center gap-2 rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 px-2.5 shadow-[var(--shadow-pill)] backdrop-blur-[12px]`}
      >
        <div className="flex items-center gap-1.5">
          {clients.map((client) => {
            const editing = lease?.clientId === client.clientId;
            const label =
              client.clientId === me
                ? t("presence.thisDevice")
                : nameOf(client.deviceName);
            return (
              <Tooltip key={client.clientId} delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="inline-flex p-0.5" aria-label={label}>
                    <ColorDot
                      size={8}
                      color={
                        editing ? "var(--primary)" : "var(--muted-foreground)"
                      }
                      selected={editing}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {editing ? t("presence.editing", { device: label }) : label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {denied ? (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t("presence.readOnly")}
          </span>
        ) : readOnly && lease ? (
          <>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {t("presence.editing", { device: holder })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setConfirming(true)}
            >
              {t("presence.takeover")}
            </Button>
          </>
        ) : null}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("presence.takeoverTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("presence.takeoverDescription", { device: holder })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={takeOver}>
              {t("presence.takeover")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
