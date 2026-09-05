import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, PlugZap, TerminalSquare, X } from "lucide-react";
import { runtimeApi } from "../api/client";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";

/** 保存失败时 Dock 的重试钮与通知条走同一个事件（App 监听后重新入队）。 */
export const SAVE_RETRY_EVENT = "armadra:save-retry";

/**
 * 通知条堆栈（§3.1，`top:46` 居中）。
 *
 * 只放“需要用户知道且会持续存在”的三件事：保存失败、Runtime 断开、
 * 终端后端降级。一次性的信息用 sonner toast，不占画布。
 */
export function Banners() {
  const t = useT();
  const saveState = useCanvasStore((state) => state.saveState);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
    // 断开时 5 秒一次，正常时 30 秒一次
    refetchInterval: (query) => (query.state.error ? 5_000 : 30_000),
  });

  const backend = useQuery({
    queryKey: ["terminal-backend"],
    queryFn: runtimeApi.terminalBackend,
    retry: false,
    staleTime: 60_000,
  });

  const items: ReactNode[] = [];

  if (saveState === "error" && !dismissed.includes("save")) {
    items.push(
      <Banner
        key="save"
        tone="danger"
        icon={<AlertTriangle />}
        text={t("banner.saveFailed")}
        actionLabel={t("banner.saveRetry")}
        onAction={() => window.dispatchEvent(new CustomEvent(SAVE_RETRY_EVENT))}
        onDismiss={() => setDismissed((list) => [...list, "save"])}
      />,
    );
  }

  if (health.isError && !dismissed.includes("runtime")) {
    items.push(
      <Banner
        key="runtime"
        tone="danger"
        icon={<PlugZap />}
        text={t("banner.runtimeDown")}
        actionLabel={t("banner.runtimeRetry")}
        onAction={() => void health.refetch()}
        onDismiss={() => setDismissed((list) => [...list, "runtime"])}
      />,
    );
  }

  if (backend.data?.reason && !dismissed.includes("backend")) {
    items.push(
      <Banner
        key="backend"
        tone="warn"
        icon={<TerminalSquare />}
        text={t("banner.tmuxFallback")}
        actionLabel={t("banner.backendSettings")}
        onAction={() => setPanel("settings", true)}
        onDismiss={() => setDismissed((list) => [...list, "backend"])}
      />,
    );
  }

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed top-[46px] left-1/2 z-[var(--z-banners)] flex -translate-x-1/2 flex-col items-center gap-2">
      {items}
    </div>
  );
}

function Banner({
  tone,
  icon,
  text,
  actionLabel,
  onAction,
  onDismiss,
}: {
  tone: "danger" | "warn";
  icon: ReactNode;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div
      role="status"
      data-tone={tone}
      className="pointer-events-auto motion-fade-in flex h-9 items-center gap-2 rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 pr-1.5 pl-3 shadow-[var(--shadow-pill)] backdrop-blur-[12px] data-[tone=danger]:text-danger data-[tone=warn]:text-warn"
    >
      <span className="[&_svg]:size-4 [&_svg]:[stroke-width:1.5]">{icon}</span>
      <span className="text-foreground">{text}</span>
      {actionLabel && onAction && (
        <Button variant="outline" size="xs" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      <IconButton label={t("banner.dismiss")} onClick={onDismiss}>
        <X />
      </IconButton>
    </div>
  );
}
