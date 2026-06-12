import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { formatBytes, guessLanguage } from "./helpers";
import type { NodeContentProps, OfKind } from "./types";

const PREVIEW_LIMIT = 4_000;

/** File body: mono preview on the card2 surface, language guess as subtitle. */
export function FileNode({ id, data }: NodeContentProps) {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const updateNode = useCanvasStore((state) => state.updateNode);
  const file = data as OfKind<"file">;

  const preview = useQuery({
    queryKey: ["file-preview", workspace?.id, file.path],
    queryFn: () => runtimeApi.readFile(workspace!.id, file.path),
    enabled: Boolean(workspace) && file.path !== ".",
    retry: false,
  });

  const language = file.language ?? guessLanguage(file.path);
  useEffect(() => {
    if (language && file.subtitle !== language)
      updateNode(id, { subtitle: language, language });
  }, [file.subtitle, id, language, updateNode]);

  return (
    <div className="file-body nodrag nowheel">
      <div className="file-meta">
        <code title={file.path}>{file.path}</code>
        <span>
          {language ? `${language} · ` : ""}
          {formatBytes(preview.data?.size ?? file.size)}
        </span>
      </div>
      {preview.isPending && file.path !== "." ? (
        <p className="file-hint">{t("file.reading")}</p>
      ) : preview.isError ? (
        <p className="file-hint">{preview.error.message}</p>
      ) : (
        <pre className="file-preview">
          {(preview.data?.content ?? "").slice(0, PREVIEW_LIMIT)}
        </pre>
      )}
    </div>
  );
}
