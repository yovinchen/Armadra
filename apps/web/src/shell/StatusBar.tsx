import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { useGatewayState } from "./gateway";

/** 24px status bar — plan §1.2, template.html "状态栏". */
export function StatusBar() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const document = useCanvasStore((state) => state.document);
  const gateway = useGatewayState(workspace?.id);

  const sessions =
    document?.nodes.filter(
      (node) =>
        (node.data.kind === "terminal" || node.data.kind === "agent") &&
        node.data.status === "running" &&
        Boolean(node.data.sessionId),
    ).length ?? 0;

  return (
    <footer className="statusbar">
      <span>{gateway.enabled ? t("app.localGateway") : t("app.local")}</span>
      <span>
        {t("app.sessions", {
          sessions,
          nodes: document?.nodes.length ?? 0,
          edges: document?.edges.length ?? 0,
        })}
      </span>
      <div className="statusbar-spacer" />
      <span
        className="statusbar-gateway"
        style={{ color: gateway.enabled ? "var(--info)" : "var(--muted)" }}
      >
        <span aria-hidden="true">{gateway.glyph}</span>
        {t("gateway.port", { port: gateway.port })}
      </span>
      <span className="statusbar-path" title={workspace?.rootPath}>
        {workspace?.rootPath}
      </span>
    </footer>
  );
}
