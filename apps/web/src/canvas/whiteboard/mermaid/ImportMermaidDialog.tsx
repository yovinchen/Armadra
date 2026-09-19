import * as React from "react";
import { toast } from "sonner";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Textarea } from "@/ui/textarea";

import { createImageShapes } from "../../dnd/external-content";
import { viewportCentre } from "../../interaction/pointer";
import { importMermaidText } from "./import";
import { closeMermaidImport, useMermaidDialog } from "./open";
import { MermaidParseError } from "./parse";
import { renderMermaidSvg, svgToFile } from "./render";

/**
 * 导入 Mermaid 对话框（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §4.2）。
 *
 * 左输入右预览，确认后落到视口中心。四个入口（加号菜单、⌘⇧M、粘贴、拖入
 * `.mmd`）打开的都是这一个组件，状态在 `open.ts` 里。
 *
 * 这个文件是 mermaid 与 dagre 唯一的进入点：`ToolLayer` 经 `React.lazy`
 * 挂它，并且只在对话框打开时渲染，所以两个大依赖都不会进首屏（设计 D2）。
 *
 * 失败不产生半成品：解析错时确认钮禁用，错误行显示在输入框下面（设计 §6）。
 */

/** 输入停下多久之后跑一次解析与预览。 */
const DEBOUNCE_MS = 400;

export function ImportMermaidDialog() {
  const t = useT();
  const dialog = useMermaidDialog();
  const [text, setText] = React.useState(dialog.text);
  const [svg, setSvg] = React.useState("");
  const [error, setError] = React.useState<MermaidParseError | null>(null);
  const [busy, setBusy] = React.useState(false);

  // 每次打开都用带进来的预填文本重置（粘贴与拖放会带内容进来）。
  React.useEffect(() => {
    if (!dialog.open) return;
    setText(dialog.text);
    setSvg("");
    setError(null);
  }, [dialog.open, dialog.text]);

  // 去抖预览：`mermaid.render` 不便宜，每敲一个字跑一次会卡。
  React.useEffect(() => {
    const source = text.trim();
    if (!source) {
      setSvg("");
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void renderMermaidSvg(source).then(
        (result) => {
          if (cancelled) return;
          setSvg(result);
          setError(null);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setSvg("");
          setError(
            cause instanceof MermaidParseError
              ? cause
              : new MermaidParseError(String(cause), null),
          );
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  const ready = text.trim().length > 0 && !error && !busy;

  const confirm = async () => {
    const source = text.trim();
    if (!source) return;
    const at = dialog.at ?? viewportCentre();
    setBusy(true);
    try {
      const outcome = await importMermaidText(source, at);
      if (outcome.kind === "graph") {
        toast.success(t("mermaid.imported", { count: outcome.ids.length }));
      } else {
        // 非 flowchart：渲染成 SVG 之后交给现成的资产导入路径（它会先
        // 栅格化成 PNG 再上传，内容寻址与 8 MiB 上限都归它管）。
        const rendered = svg || (await renderMermaidSvg(source));
        await createImageShapes(
          [svgToFile(rendered, outcome.diagramType || "diagram")],
          at,
        );
        toast.success(
          t("mermaid.importedImage", { type: outcome.diagramType }),
        );
      }
      closeMermaidImport();
    } catch (cause) {
      if (cause instanceof MermaidParseError) setError(cause);
      else toast.error(t("mermaid.renderFailed"));
    } finally {
      setBusy(false);
    }
  };

  const message = error
    ? error.line === null
      ? error.message
      : t("mermaid.errorAt", { line: error.line, message: error.message })
    : null;

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open) closeMermaidImport();
      }}
    >
      <DialogContent className="z-[var(--z-dialog)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("mermaid.title")}</DialogTitle>
          <DialogDescription>{t("mermaid.description")}</DialogDescription>
        </DialogHeader>

        {/* 宽屏并排，窄屏切页签——并排在 390px 上两边都没法用。 */}
        <div className="hidden gap-3 sm:grid sm:grid-cols-2">
          <Source
            text={text}
            onChange={setText}
            placeholder={t("mermaid.placeholder")}
          />
          <Preview svg={svg} empty={t("mermaid.empty")} />
        </div>
        <Tabs defaultValue="source" className="sm:hidden">
          <TabsList>
            <TabsTrigger value="source">{t("mermaid.source")}</TabsTrigger>
            <TabsTrigger value="preview">{t("mermaid.preview")}</TabsTrigger>
          </TabsList>
          <TabsContent value="source">
            <Source
              text={text}
              onChange={setText}
              placeholder={t("mermaid.placeholder")}
            />
          </TabsContent>
          <TabsContent value="preview">
            <Preview svg={svg} empty={t("mermaid.empty")} />
          </TabsContent>
        </Tabs>

        {message ? (
          <p className="text-destructive text-sm break-words">{message}</p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={closeMermaidImport}>
            {t("mermaid.cancel")}
          </Button>
          <Button disabled={!ready} onClick={() => void confirm()}>
            {t("mermaid.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Source({
  text,
  onChange,
  placeholder,
}: {
  text: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <Textarea
      value={text}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="h-72 resize-none font-mono text-xs"
    />
  );
}

/**
 * 预览。
 *
 * `dangerouslySetInnerHTML` 在这里是安全的：`securityLevel: "strict"` 与
 * `htmlLabels: false` 已经让 Mermaid 把标签里的 HTML 剥掉、把 `click`
 * 指令禁掉，产出的是一棵纯 SVG（设计 §5）。
 */
function Preview({ svg, empty }: { svg: string; empty: string }) {
  return (
    <div className="bg-muted/40 flex h-72 items-center justify-center overflow-auto rounded-md border p-2">
      {svg ? (
        <div
          className="[&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <span className="text-muted-foreground text-xs">{empty}</span>
      )}
    </div>
  );
}

export default ImportMermaidDialog;
