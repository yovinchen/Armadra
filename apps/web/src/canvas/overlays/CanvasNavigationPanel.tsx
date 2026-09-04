import { ChevronDown, Map } from "lucide-react";
import { useT } from "@/app/preferences-store";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { IconButton } from "@/ui/icon-button";
import { StatusMinimap } from "./StatusMinimap";

/** Always available, including below tldraw's tablet breakpoint. */
export function CanvasNavigationPanel() {
  const t = useT();
  const { collapsed, setCollapsed } = useMinimapPreferences();
  return (
    <div
      className="tlui-navigation-panel canvas-navigation"
      data-collapsed={collapsed}
    >
      {!collapsed && <StatusMinimap />}
      <IconButton
        size="cluster"
        className="minimap-toggle"
        label={t(collapsed ? "canvas.expandMinimap" : "canvas.collapseMinimap")}
        title={t(collapsed ? "canvas.expandMinimap" : "canvas.collapseMinimap")}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <Map /> : <ChevronDown />}
      </IconButton>
    </div>
  );
}
