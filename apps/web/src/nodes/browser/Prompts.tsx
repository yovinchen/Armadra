import * as React from "react";
import { toast } from "sonner";
import type { BrowserDialog, BrowserFileChooser } from "@armadra/shared";

import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { isDesktop, pickFiles } from "@/platform";

import { relativeToRoot } from "./geometry";

/**
 * 页面弹出的 `alert` / `confirm` / `prompt` / `beforeunload`（设计 §2.4）。
 *
 * 在它被答复之前，这个标签上的输入一律 409 `DIALOG_PENDING`——所以这不是
 * 一个可关可不关的提示，而是页面继续往下走的唯一出口。文本原样显示，前面
 * 带上是哪个地址弹的：一个只写着「确定吗」的框，人无从判断该点什么。
 */
export function DialogPrompt({
  workspaceId,
  sessionId,
  dialog,
  onAnswered,
}: {
  workspaceId: string | undefined;
  sessionId: string | null;
  dialog: BrowserDialog | null;
  onAnswered: () => void;
}) {
  const t = useT();
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => setText(dialog?.defaultPrompt ?? ""), [dialog]);

  if (!dialog || !workspaceId || !sessionId) return null;
  const cancellable = dialog.kind !== "alert";

  const answer = (accept: boolean) => {
    setBusy(true);
    void runtimeApi
      .browserDialog(workspaceId, sessionId, {
        tabId: dialog.tabId,
        dialogId: dialog.dialogId,
        accept,
        ...(dialog.kind === "prompt" && accept ? { promptText: text } : {}),
      })
      .then(onAnswered)
      .catch((cause: unknown) => {
        // 已经被别人答复了，或者超时被 dismiss 了。收起来就是正确的结果。
        onAnswered();
        toast.error(
          cause instanceof Error ? cause.message : t("browser.dialog.failed"),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 关掉这个弹层等于「不接受」，而不是「当作没看见」——页面还停在
        // 那里，收起界面却不答复只会让它永远等到超时。
        if (!open && !busy) answer(false);
      }}
    >
      <DialogContent
        className="z-[var(--z-dialog)]"
        data-slot="browser-dialog-prompt"
      >
        <DialogHeader>
          <DialogTitle>{t(`browser.dialog.${dialog.kind}`)}</DialogTitle>
          <DialogDescription className="break-all font-mono text-[11px]">
            {dialog.url}
          </DialogDescription>
        </DialogHeader>
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm">
          {dialog.message}
        </p>
        {dialog.kind === "prompt" && (
          <Input
            autoFocus
            aria-label={t("browser.dialog.answer")}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) answer(true);
            }}
          />
        )}
        <DialogFooter>
          {cancellable && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => answer(false)}
            >
              {t(
                dialog.kind === "beforeunload"
                  ? "browser.dialog.stay"
                  : "browser.dialog.dismiss",
              )}
            </Button>
          )}
          <Button type="button" disabled={busy} onClick={() => answer(true)}>
            {t(
              dialog.kind === "beforeunload"
                ? "browser.dialog.leave"
                : "browser.dialog.accept",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 页面开了 `<input type="file">`（设计 §2.3）。
 *
 * 两条路，因为两端能拿到的东西不同。桌面端有系统选择器，拿得到执行主机上
 * 的绝对路径，换算成工作空间相对路径直接回填——文件不必进项目。浏览器端
 * 只拿得到字节，所以先导入到 `.armadra/imports/` 再按导入后的路径回填；
 * 这一步是可见的副作用，文案里写明。
 *
 * 远端工作空间即使在桌面端也走后一条：`rootPath` 是**那台**主机上的路径，
 * 本机选择器选出来的文件在那边并不存在。
 */
export function FileChooserPrompt({
  workspaceId,
  workspaceRoot,
  remote,
  sessionId,
  chooser,
  onAnswered,
}: {
  workspaceId: string | undefined;
  workspaceRoot: string;
  remote: boolean;
  sessionId: string | null;
  chooser: BrowserFileChooser | null;
  onAnswered: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  if (!chooser || !workspaceId || !sessionId) return null;
  // Asked only when a page is actually waiting: nothing about the platform is
  // worth touching for a node that has no chooser open.
  const native = isDesktop() && !remote && workspaceRoot.length > 0;

  const fill = (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy(true);
    void runtimeApi
      .browserUpload(workspaceId, sessionId, {
        chooserId: chooser.chooserId,
        paths,
      })
      .then(() => {
        toast(t("browser.chooser.filled", { count: paths.length }));
        onAnswered();
      })
      .catch((cause: unknown) =>
        toast.error(
          cause instanceof Error ? cause.message : t("browser.chooser.failed"),
        ),
      )
      .finally(() => setBusy(false));
  };

  const chooseNative = () => {
    setBusy(true);
    void pickFiles({ multiple: chooser.multiple, defaultPath: workspaceRoot })
      .then((absolute) => {
        if (absolute.length === 0) return;
        const relative = absolute.map((path) =>
          relativeToRoot(workspaceRoot, path),
        );
        // 一个越界就整批拒绝：只上传「合法的那几个」是人没要求过的事，页面
        // 也分不出少了哪一个。
        if (relative.some((path) => path === null)) {
          toast.error(t("browser.chooser.outsideRoot"));
          return;
        }
        fill(relative as string[]);
      })
      .finally(() => setBusy(false));
  };

  const chooseWeb = (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    if (picked.length === 0) return;
    setBusy(true);
    void runtimeApi
      .importFiles(
        workspaceId,
        picked.map((file) => ({ file, path: file.name })),
      )
      .then((imported) => fill(imported.files.map((entry) => entry.path)))
      .catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : t("browser.chooser.failed"),
        );
        setBusy(false);
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 关掉不等于答复：页面还在等，Runtime 60 秒后会回填一个空列表。
        // 说明这件事比假装选了什么要诚实。
        if (!open && !busy) onAnswered();
      }}
    >
      <DialogContent
        className="z-[var(--z-dialog)]"
        data-slot="browser-file-chooser"
      >
        <DialogHeader>
          <DialogTitle>{t("browser.chooser.title")}</DialogTitle>
          <DialogDescription>
            {t(
              native
                ? "browser.chooser.nativeHint"
                : "browser.chooser.importHint",
            )}
          </DialogDescription>
        </DialogHeader>
        {!native && (
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            multiple={chooser.multiple}
            aria-label={t("browser.chooser.input")}
            onChange={(event) => chooseWeb(event.target.files)}
          />
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onAnswered}
          >
            {t("browser.chooser.later")}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              native ? chooseNative() : inputRef.current?.click()
            }
          >
            {t("browser.chooser.choose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
