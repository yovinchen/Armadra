import * as React from "react";
import type { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";

import type { LanguageClient } from "./client";
import type { Ownership } from "./documents";
import { languageIdFor } from "./language-ids";
import { registerOpenFile, unregisterOpenFile } from "./open-files";
import { formatOnSaveEnabled, refreshFormatOnSave } from "./settings";
import { workspaceUri } from "./uri";

/**
 * 把一个编辑器节点接到语言服务上（语言服务设计 §2.3、§2.5、§4.2）。
 *
 * 四条规矩，顺序不能换：
 *
 *  1. **只有能给出内容版本的文本文件才开会话。** 非 UTF-8 与超过 1 MiB 的
 *     文件 Runtime 不给版本，也就没有可核对的正文——这类文件状态栏直接说
 *     「LSP 不适用」，不开会话（§2.3「打开文本文件」）。
 *  2. **LSP 代码是动态加载的。** `EditorNode` 在画布节点注册表里是静态成员，
 *     从这里静态引 `@codemirror/lsp-client` 会把它压进启动 chunk。
 *  3. **会话是异步的，视图不等它。** 语言扩展装在自己的 `Compartment` 里，
 *     会话好了热插进去；这与语法高亮包的加载是同一套做法，光标与撤销栈
 *     都不受影响。
 *  4. **卸载时先撤扩展再放引用。** 反过来会让会话先关，而视图上还挂着一个
 *     指向已关闭客户端的插件。
 */

export interface LanguageServiceHandle {
  /** 会话状态，供状态栏显示；没有会话时为 `null`。 */
  status: LanguageClient["status"] | null;
  /** 这个视图是不是这个 uri 的拥有者（§2.5）。 */
  ownership: Ownership | null;
  /**
   * 保存前的一步。`language.formatOnSave` 关着（默认）时**同步**返回
   * `undefined`，保存路径因此一个微任务都不多花。
   */
  beforeSave: () => Promise<void> | void;
  /** 保存成功后：`didSave`。保存失败（409）时不调用。 */
  afterSave: () => void;
}

export interface LanguageServiceOptions {
  nodeId: string;
  path: string;
  workspaceId: string | undefined;
  /** `[workspaceId, path]`；换文件时一切重来。 */
  identity: string;
  /** 文件已经作为文本读进来、并且有内容版本。 */
  eligible: boolean;
  dirty: boolean;
  sha256: string | undefined;
  viewRef: React.RefObject<EditorView | null>;
  viewIdentityRef: React.RefObject<string | null>;
  serviceRef: React.RefObject<Compartment | null>;
  /** 视图重建后自增，用来重新挂扩展。 */
  viewGeneration: number;
}

type LanguageCore = typeof import("./core");

/**
 * 视图还没被 `destroy()` 掉。
 *
 * CodeMirror 把 `destroyed` 标成私有，但对一个已经销毁的视图 `dispatch`
 * 会抛——所以这里读它，而不是用 try/catch 把「扩展没装上」也一起吞掉。
 */
function alive(view: EditorView): boolean {
  return (view as unknown as { destroyed?: boolean }).destroyed !== true;
}

let corePromise: Promise<LanguageCore> | null = null;

/** 第一次真的需要语言能力时才把 LSP 客户端拉下来。 */
export function loadLanguageCore(): Promise<LanguageCore> {
  corePromise ??= import("./core");
  return corePromise;
}

export function useLanguageService(
  options: LanguageServiceOptions,
): LanguageServiceHandle {
  const {
    nodeId,
    path,
    workspaceId,
    identity,
    eligible,
    dirty,
    sha256,
    viewRef,
    viewIdentityRef,
    serviceRef,
    viewGeneration,
  } = options;

  const languageId = React.useMemo(() => languageIdFor(path), [path]);
  const clientRef = React.useRef<LanguageClient | null>(null);
  const [status, setStatus] = React.useState<LanguageClient["status"] | null>(
    null,
  );
  const [ownership, setOwnership] = React.useState<Ownership | null>(null);

  // 保存路径同步读这个开关，所以挂载时先把它取回来（`./settings`）。
  React.useEffect(() => {
    void refreshFormatOnSave();
  }, []);

  /* --------------------------- 预览与应用的登记 --------------------------- */

  React.useEffect(() => {
    if (!eligible || !path) {
      unregisterOpenFile(nodeId);
      return;
    }
    registerOpenFile(nodeId, {
      path,
      dirty,
      sha256,
      read: () =>
        viewIdentityRef.current === identity
          ? (viewRef.current?.state.sliceDoc() ?? "")
          : "",
    });
    return () => unregisterOpenFile(nodeId);
  }, [nodeId, path, identity, eligible, dirty, sha256]);

  /* -------------------------------- 会话 --------------------------------- */

  React.useEffect(() => {
    if (!workspaceId || !languageId || !eligible) {
      setStatus(null);
      setOwnership(null);
      return;
    }
    let released: (() => void) | null = null;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void loadLanguageCore().then(({ acquireLanguageClient }) => {
      if (cancelled) return;
      const acquired = acquireLanguageClient(workspaceId, languageId);
      released = acquired.release;
      clientRef.current = acquired.client;
      setStatus({ ...acquired.client.status });
      unsubscribe = acquired.client.subscribe(() =>
        setStatus({ ...acquired.client.status }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      clientRef.current = null;
      released?.();
    };
  }, [workspaceId, languageId, eligible]);

  /* ---------------------- 视图 ↔ 会话：热插语言扩展 ---------------------- */

  const state = status?.state;
  React.useEffect(() => {
    const client = clientRef.current;
    const view = viewRef.current;
    const compartment = serviceRef.current;
    if (
      !client ||
      !view ||
      !compartment ||
      !workspaceId ||
      !languageId ||
      viewIdentityRef.current !== identity
    ) {
      return;
    }
    if (!state || state === "unsupported") {
      view.dispatch({ effects: compartment.reconfigure([]) });
      setOwnership(null);
      return;
    }
    const uri = workspaceUri(path);
    let offOwnership: (() => void) | null = null;
    let cancelled = false;
    void loadLanguageCore().then(({ languageEditorExtensions }) => {
      if (cancelled || viewRef.current !== view || !alive(view)) return;
      view.dispatch({
        effects: compartment.reconfigure(languageEditorExtensions(client, uri)),
      });
      const workspace = client.workspace;
      if (!workspace) return;
      setOwnership(workspace.ownershipOf(view));
      offOwnership = workspace.onOwnership((changed) => {
        if (changed !== uri) return;
        setOwnership(workspace.ownershipOf(view));
      });
    });
    return () => {
      cancelled = true;
      offOwnership?.();
      // 视图还活着才撤：卸载路径上视图已经 destroy 了，dispatch 会抛。
      if (viewRef.current === view && alive(view)) {
        view.dispatch({ effects: compartment.reconfigure([]) });
      }
    };
  }, [workspaceId, languageId, identity, path, state, viewGeneration]);

  /* -------------------------------- 保存 --------------------------------- */

  const beforeSave = React.useCallback((): Promise<void> | void => {
    if (!formatOnSaveEnabled()) return;
    const view = viewRef.current;
    const client = clientRef.current;
    if (!view || viewIdentityRef.current !== identity) return;
    if (!client || client.status.state === "unsupported") return;
    return (
      loadLanguageCore()
        .then(({ formatDocumentAndWait }) => formatDocumentAndWait(view))
        .then(() => undefined)
        // 格式化失败不该挡住保存。
        .catch(() => undefined)
    );
  }, [identity]);

  const afterSave = React.useCallback(() => {
    const client = clientRef.current;
    if (!client?.lsp || !path) return;
    client.lsp.notification("textDocument/didSave", {
      textDocument: { uri: workspaceUri(path) },
    });
  }, [path]);

  return { status, ownership, beforeSave, afterSave };
}
