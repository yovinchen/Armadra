import * as React from "react";
import type { EditorView } from "codemirror";
import type { Compartment } from "@codemirror/state";

import type { EditorCore } from "./codemirror";

/**
 * 编辑器节点用到的全部可变引用。
 *
 * 换文件（`identity` 变了）时把「这一次保存」的令牌清掉：拆分前这一段就写在
 * 组件里，位置和时机都不变——渲染期间生效，而不是等一次 effect。
 */
export interface EditorRefs {
  hostRef: React.RefObject<HTMLDivElement | null>;
  viewRef: React.RefObject<EditorView | null>;
  languageRef: React.RefObject<Compartment | null>;
  accessRef: React.RefObject<Compartment | null>;
  baselineRef: React.RefObject<string>;
  /** 磁盘上这个文件的字节数，读到时记下、每次保存成功后更新（仅用于显示与旧接口兼容）。 */
  sizeRef: React.RefObject<number | undefined>;
  versionRef: React.RefObject<string | undefined>;
  /** 文件原本带 BOM，保存时要原样写回去（E01/M4）。 */
  bomRef: React.RefObject<boolean>;
  coreRef: React.RefObject<EditorCore | null>;
  /** 磁盘上的文件已经没了，下一次保存按「新建」提交（不带内容版本）。 */
  recreateRef: React.RefObject<boolean>;
  dirtyRef: React.RefObject<boolean>;
  identityRef: React.RefObject<string>;
  viewIdentityRef: React.RefObject<string | null>;
  pendingSaveRef: React.RefObject<object | null>;
  writableRef: React.RefObject<boolean>;
}

export function useEditorRefs(identity: string): EditorRefs {
  const refs = React.useRef<EditorRefs | null>(null);
  refs.current ??= {
    hostRef: React.createRef<HTMLDivElement>(),
    viewRef: { current: null },
    languageRef: { current: null },
    accessRef: { current: null },
    baselineRef: { current: "" },
    sizeRef: { current: undefined },
    versionRef: { current: undefined },
    bomRef: { current: false },
    coreRef: { current: null },
    recreateRef: { current: false },
    dirtyRef: { current: false },
    identityRef: { current: identity },
    viewIdentityRef: { current: null },
    pendingSaveRef: { current: null },
    writableRef: { current: false },
  };
  const bundle = refs.current;
  if (bundle.identityRef.current !== identity) {
    bundle.identityRef.current = identity;
    bundle.pendingSaveRef.current = null;
  }
  return bundle;
}
