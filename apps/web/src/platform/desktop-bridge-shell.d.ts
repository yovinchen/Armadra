/**
 * `window.armadra`，壳的系统集成那一半（迁移设计 §2.2 的 dialog / shell /
 * shortcuts / window / app 五个域，外加 `pathForFile`）。
 *
 * 声明分两个文件，用的是**同一个 `ArmadraBridge` 名字**：TypeScript 的接口
 * 合并会把两份拼成一个。传输与身份那一半在 `desktop-bridge.d.ts`，和这一份
 * 各改各的——两批改动落在同一个文件上只会互相踩。
 *
 * 这里只描述 preload 真正暴露的东西（`apps/desktop/src/preload/index.ts`）。
 * 多写一个方法不会让它存在，只会让调用处在运行时拿到 `undefined`。
 */

interface ArmadraDialogOptions {
  multiple?: boolean;
  defaultPath?: string;
}

/** 一条系统热键的注册结果，和 `shell-core/shortcut-rules.ts` 的状态一致。 */
interface ArmadraShortcutOutcome {
  id: string;
  state: "bound" | "unbound" | "invalid" | "taken";
}

interface ArmadraBridge {
  readonly dialog: {
    /** 选目录，返回绝对路径；用户取消是空数组。 */
    pickDirectory(options?: ArmadraDialogOptions): Promise<string[]>;
    /** 选文件，返回绝对路径而不是字节——读文件是 Runtime 的事。 */
    pickFiles(options?: ArmadraDialogOptions): Promise<string[]>;
  };
  readonly shell: {
    /** 只放行 `http` / `https`，其余以 `scheme_not_allowed` 拒绝。 */
    openExternal(url: string): Promise<void>;
  };
  readonly shortcuts: {
    /** 全量替换：活着的热键集合就等于最后一次 apply 的那张表。 */
    apply(
      bindings: readonly { id: string; accelerator: string }[],
    ): Promise<ArmadraShortcutOutcome[]>;
    onTriggered(listener: (id: string) => void): () => void;
  };
  readonly window: {
    isFocused(): Promise<boolean>;
    /** 主进程从应用菜单手里抢回来的和弦（封闭清单）。 */
    onKeyIntent(listener: (intent: string) => void): () => void;
    /** 主进程发的通知被点了，页面自己决定选中哪个节点。 */
    onNotificationClick(
      listener: (event: { nodeId: string }) => void,
    ): () => void;
  };
  readonly app: {
    locale(): Promise<string>;
  };
  /**
   * 一个被拖进来或选中的 `File` 的绝对路径（`webUtils.getPathForFile`）。
   * 页面把路径交给 Runtime，字节从不经过渲染进程。
   */
  readonly pathForFile: (file: File) => string;
}

interface Window {
  readonly armadra?: ArmadraBridge;
}
