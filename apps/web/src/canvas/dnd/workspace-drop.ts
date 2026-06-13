/**
 * Launcher drop zone (SPEC §5, last row: “拖到窗口（启动页）→ 新建工作空间”).
 *
 * Only the desktop build learns a real folder path: Tauri reports OS drops
 * through `platform.onFileDrop`. In the browser a `DataTransfer` never exposes
 * a filesystem path, so the hook reports that through `unsupportedMessage`
 * instead of pretending the drop worked (plan rule §7.4: no fake data).
 *
 * B4 owns `app/Launcher.tsx`; this hook is the whole interface it needs.
 */
import { useCallback, useEffect, useState, type DragEvent } from "react";
import { isTauri, onFileDrop } from "../../platform";
import { usePreferences } from "../../preferences/Preferences";

export interface WorkspaceFolderDrop {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  isOver: boolean;
  /** `null` on desktop; the “use the picker instead” copy on the web. */
  unsupportedMessage: string | null;
}

export function useWorkspaceFolderDrop(
  onFolder: (path: string) => void,
): WorkspaceFolderDrop {
  const { t } = usePreferences();
  const [isOver, setIsOver] = useState(false);
  const [rejected, setRejected] = useState(false);
  const desktop = isTauri();

  useEffect(() => {
    if (!desktop) return;
    return onFileDrop((paths) => {
      setIsOver(false);
      const first = paths.find((path) => path.trim().length > 0);
      if (first) onFolder(first);
    });
  }, [desktop, onFolder]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setIsOver(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setIsOver(false);
      // Tauri delivers the real paths through its own event; the browser
      // branch can only tell the user why nothing happened.
      if (!desktop) setRejected(true);
    },
    [desktop],
  );

  return {
    onDragOver,
    onDragLeave,
    onDrop,
    isOver,
    unsupportedMessage:
      !desktop && rejected ? t("dnd.launcherUnsupported") : null,
  };
}
