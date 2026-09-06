/**
 * 快捷键注册表 —— docs/contracts/v3-agent-terminal-plan.md §8。
 *
 * 这是 Phase 1 四个界面 agent 的跨模块接口：命令面板、Dock、右键菜单、
 * 设置页都从这里读 id 与默认键，谁都不许再各自 `addEventListener("keydown")`。
 *
 * 三条规则决定了这份表的形状：
 *  1. **只有一个监听器。** `useKeybindings` 在捕获阶段装一个 keydown，
 *     命中就 `preventDefault`。多个监听器互相抢 ⌘W 是上一版的老问题。
 *  2. **终端优先。** 节点里跑的是真 CLI，绝大多数组合键必须原样进 xterm；
 *     只有 `allowInTerminal` 的少数几条会被应用截走（§8 明确列了 7 条）。
 *  3. **输入框区别对待。** `allowWhileTyping` 单独一位，因为“在便签里打字”
 *     和“在终端里打字”要放行的集合并不一样（⌘Z 在输入框里必须留给浏览器）。
 */

/**
 * 命令分组。设置页按这个分节，`useKeybindings` 按它筛选。
 *
 * `editor` / `browser` 是节点**内部**的键：它们以前散在 CodeMirror 的
 * `keymap.of([...])` 与一个手写的 `onKeyDown` 里，改不了也看不见。现在同样
 * 登记在这张表里，靠 `when` 限定在自己的节点内生效。
 *
 * `global` 是操作系统级热键（`tauri-plugin-global-shortcut`）：它在应用没有
 * 焦点时也会触发，所以默认一个都不绑——抢走整台机器的一个组合键必须是用户
 * 明确要求的事，不能是安装后才发现的。
 */
export type CommandScope =
  | "app"
  | "canvas"
  | "terminal"
  | "editor"
  | "browser"
  | "scm"
  | "global";

/** 会在 DOM 上用 `data-keybinding-scope` 标出来的那两个。 */
export const NODE_SCOPES = ["editor", "browser"] as const;

export type NodeScope = (typeof NODE_SCOPES)[number];

/**
 * 一个平台上的默认按键。
 *
 * 语法：`Mod+Shift+K`。修饰键 `Mod` / `Ctrl` / `Shift` / `Alt` / `Meta`，
 * `Mod` 在 macOS 展开成 ⌘、其余平台展开成 Ctrl。
 * 逗号分隔多个等价写法（`Backspace,Delete`），任一命中即可。
 * `null` 表示该平台默认不绑定。
 */
export type KeyChords = string | null;

export interface PlatformKeys {
  mac: KeyChords;
  other: KeyChords;
}

export interface CommandSpec {
  id: string;
  /**
   * i18n 键（`i18n/commands.ts`），不是文案。
   *
   * 这张表是模块级常量、在任何 React 之外求值，存文案就等于把语言定死在
   * 加载那一刻；命令面板与设置页在渲染时 `t(labelKey)`，切语言立刻跟着变。
   */
  labelKey: string;
  scope: CommandScope;
  defaultKeys: PlatformKeys;
  /** 焦点在终端（`.xterm`）里时是否仍然由应用接管。 */
  allowInTerminal: boolean;
  /** 焦点在输入框 / textarea / contenteditable 里时是否仍然由应用接管。 */
  allowWhileTyping: boolean;
  /**
   * 生效条件，`when.ts` 的表达式；不写就是「哪儿都算数」。
   *
   * 与上面两个布尔位分工明确：那两个回答「终端 / 输入框里放不放行」，
   * 每条命令都得回答；`when` 回答「只在什么地方」，只有少数命令需要。
   */
  when?: string;
  /**
   * 命中之后**放行**：不 `preventDefault`，也不派发 handler。
   *
   * 只有一条这样的命令（⌘V）。浏览器原生的 `paste` 事件是唯一能拿到剪贴板
   * 里图片与文件的通道——异步剪贴板 API 读不到 Finder 复制的文件，打包壳的
   * WebView 上连 `read()` 都可能没有。所以这一条只登记键位（命令面板与设置
   * 页照样显示 ⌘V），真正的落地在 `canvas/dnd/os-drop.usePasteToCanvas`。
   */
  native?: boolean;
}

/** 两个平台绑同一套键时的简写。 */
function both(chords: KeyChords): PlatformKeys {
  return { mac: chords, other: chords };
}

export const COMMANDS = [
  // ── app：全局壳，终端里也放行 ────────────────────────────────────
  {
    id: "app.commandPalette",
    labelKey: "cmd.app.commandPalette",
    scope: "app",
    defaultKeys: both("Mod+K"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.settings",
    labelKey: "cmd.app.settings",
    scope: "app",
    defaultKeys: both("Mod+Comma"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.sidebar",
    labelKey: "cmd.app.sidebar",
    scope: "app",
    defaultKeys: both("Mod+Shift+L"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.explorer",
    labelKey: "cmd.app.explorer",
    scope: "app",
    defaultKeys: both("Mod+Shift+E"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.sourceControl",
    labelKey: "cmd.app.sourceControl",
    scope: "app",
    defaultKeys: both("Mod+Shift+G"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.resources",
    labelKey: "cmd.app.resources",
    scope: "app",
    defaultKeys: both("Mod+Shift+U"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  // GitHub 页没有默认键位：剩下的 ⌘⇧ 组合都被终端里的东西用着，
  // 而这一页的入口在右上工具簇与命令面板里，不靠快捷键。
  {
    id: "app.github",
    labelKey: "cmd.app.github",
    scope: "app",
    defaultKeys: both(null),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  // 问题面板同样没有默认键位：入口是编辑器状态栏上的诊断计数与命令面板，
  // 剩下的 ⌘⇧ 组合都被终端里的东西用着。
  {
    id: "app.problems",
    labelKey: "cmd.app.problems",
    scope: "app",
    defaultKeys: both(null),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  // 文件工作流（E01/M4）。⌘P 是快速打开的通用键位；项目搜索让给
  // `canvas.focusMode` 占着的 ⌘⇧F，改用 ⌘⇧H——两条都在终端里也放行，
  // 因为它们打开的是应用面板，不是终端里的东西。
  // 引用面板：它的入口是编辑器里的 ⇧F12，这一条只是让命令面板能把已经
  // 算好的结果重新打开，不需要再占一个全局组合键。
  {
    id: "app.references",
    labelKey: "cmd.app.references",
    scope: "app",
    defaultKeys: both(null),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "app.quickOpen",
    labelKey: "cmd.app.quickOpen",
    scope: "app",
    defaultKeys: both("Mod+P"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.projectSearch",
    labelKey: "cmd.app.projectSearch",
    scope: "app",
    defaultKeys: both("Mod+Shift+H"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },

  // ── canvas：画布与节点 ──────────────────────────────────────────
  {
    id: "canvas.newTerminal",
    labelKey: "cmd.canvas.newTerminal",
    scope: "canvas",
    defaultKeys: both("Mod+T"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.newAgent",
    labelKey: "cmd.canvas.newAgent",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+C"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusMode",
    labelKey: "cmd.canvas.focusMode",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+F"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.maximize",
    labelKey: "cmd.canvas.maximize",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+Enter"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.closeNode",
    labelKey: "cmd.canvas.closeNode",
    scope: "canvas",
    // Window close belongs to the native shell/browser.
    defaultKeys: both(null),
    allowInTerminal: true,
    allowWhileTyping: false,
  },
  {
    id: "canvas.undo",
    labelKey: "cmd.canvas.undo",
    scope: "canvas",
    defaultKeys: both("Mod+Z"),
    allowInTerminal: false,
    // 输入框里的 ⌘Z 必须留给浏览器的文本撤销
    allowWhileTyping: false,
  },
  {
    id: "canvas.redo",
    labelKey: "cmd.canvas.redo",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+Z"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tidy",
    labelKey: "cmd.canvas.tidy",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+A"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.zoomIn",
    labelKey: "cmd.canvas.zoomIn",
    scope: "canvas",
    // ⌘= 与 ⌘+ 是同一个物理键，收两种写法（⇧ 与否都算）。
    defaultKeys: both("Mod+Equal,Mod+Shift+Equal"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.zoomOut",
    labelKey: "cmd.canvas.zoomOut",
    scope: "canvas",
    defaultKeys: both("Mod+Minus"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.zoom100",
    labelKey: "cmd.canvas.zoom100",
    scope: "canvas",
    defaultKeys: both("Mod+0"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.fitView",
    labelKey: "cmd.canvas.fitView",
    scope: "canvas",
    defaultKeys: both("Mod+1"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusLeft",
    labelKey: "cmd.canvas.focusLeft",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowLeft"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusRight",
    labelKey: "cmd.canvas.focusRight",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowRight"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusUp",
    labelKey: "cmd.canvas.focusUp",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowUp"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusDown",
    labelKey: "cmd.canvas.focusDown",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowDown"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.delete",
    labelKey: "cmd.canvas.delete",
    scope: "canvas",
    // macOS 上 ⌫ 是主删除键，⌦ 只有全尺寸键盘才有；两个都收
    defaultKeys: { mac: "Backspace,Delete", other: "Delete,Backspace" },
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── canvas：剪贴板（React Flow 计划 F19） ────────────────────────
  //
  // 三条都不在终端与输入框里生效：⌘C / ⌘X / ⌘V 在那两处是系统行为，
  // 截走就等于把复制粘贴弄坏。
  //
  // ⌘C / ⌘X 命中即 `preventDefault`：我们要写进剪贴板的是自己的 JSON
  // （`whiteboard/clipboard.ts`），放行会让浏览器拿文档选区把它盖掉。
  // ⌘V 相反，是 `native` 的——见 `CommandSpec.native`。
  {
    id: "canvas.copy",
    labelKey: "cmd.canvas.copy",
    scope: "canvas",
    defaultKeys: both("Mod+C"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.cut",
    labelKey: "cmd.canvas.cut",
    scope: "canvas",
    defaultKeys: both("Mod+X"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.paste",
    labelKey: "cmd.canvas.paste",
    scope: "canvas",
    defaultKeys: both("Mod+V"),
    allowInTerminal: false,
    allowWhileTyping: false,
    native: true,
  },

  // ── canvas：画布偏好（2026-09-05 用户反馈：偏好要能在系统里配） ──
  //
  // 键位沿用 v3 / 旧引擎的那一组（Q / ⌘\' / ⌘.），换引擎不改肌肉记忆，
  // 按下去是同一件事。三条都写 `preferences-store` 的 `whiteboard` 段，
  // 偏好菜单与设置页读的是同一个值。
  {
    id: "canvas.toggleToolLock",
    labelKey: "cmd.canvas.toggleToolLock",
    scope: "canvas",
    defaultKeys: both("Q"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.toggleGrid",
    labelKey: "cmd.canvas.toggleGrid",
    scope: "canvas",
    defaultKeys: both("Mod+Quote"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.toggleFocus",
    labelKey: "cmd.canvas.toggleFocus",
    scope: "canvas",
    defaultKeys: both("Mod+Period"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── canvas：白板工具（React Flow 计划 F21 的工具键表） ───────────
  //
  // 键位沿用 V / H / D / ⇧D / R / L / A / T / F，与其它白板一致，这样从
  // 别的白板过来的人不用重学；`allowInTerminal` 与 `allowWhileTyping`
  // 全是 false —— 单字母键在终端里就是普通输入，绝不能被应用截走。
  {
    id: "canvas.tool.select",
    labelKey: "cmd.canvas.tool.select",
    scope: "canvas",
    defaultKeys: both("V"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.hand",
    labelKey: "cmd.canvas.tool.hand",
    scope: "canvas",
    defaultKeys: both("H"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.draw",
    labelKey: "cmd.canvas.tool.draw",
    scope: "canvas",
    defaultKeys: both("D"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.highlight",
    labelKey: "cmd.canvas.tool.highlight",
    scope: "canvas",
    defaultKeys: both("Shift+D"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.geo",
    labelKey: "cmd.canvas.tool.geo",
    scope: "canvas",
    defaultKeys: both("R"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.line",
    labelKey: "cmd.canvas.tool.line",
    scope: "canvas",
    defaultKeys: both("L"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.arrow",
    labelKey: "cmd.canvas.tool.arrow",
    scope: "canvas",
    defaultKeys: both("A"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.text",
    labelKey: "cmd.canvas.tool.text",
    scope: "canvas",
    defaultKeys: both("T"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.frame",
    labelKey: "cmd.canvas.tool.frame",
    scope: "canvas",
    defaultKeys: both("F"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── terminal ───────────────────────────────────────────────────
  {
    id: "terminal.search",
    labelKey: "cmd.terminal.search",
    scope: "terminal",
    defaultKeys: both("Mod+F"),
    allowInTerminal: true,
    allowWhileTyping: false,
  },

  // ── editor：编辑器节点内部（E01 / LSP） ─────────────────────────
  //
  // 这几条以前是硬编码的：⌘S 在 `nodes/editor/use-save.ts` 里手写比对
  // `metaKey || ctrlKey`，F2 / F12 / ⇧F12 / ⇧⌥F 写死在 CodeMirror 的
  // `keymap.of([...])` 里。登记进来之后设置页看得见、改得动，而 `when`
  // 保证它们只在编辑器节点内部抢键。
  //
  // `allowWhileTyping: true` 是必须的：编辑器的代码区就是 contenteditable，
  // 「正在打字」永远为真，不放行等于全都不生效。
  {
    id: "editor.save",
    labelKey: "cmd.editor.save",
    scope: "editor",
    defaultKeys: both("Mod+S"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "editorFocus",
  },
  {
    id: "editor.rename",
    labelKey: "cmd.editor.rename",
    scope: "editor",
    defaultKeys: both("F2"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "editorFocus",
  },
  {
    id: "editor.format",
    labelKey: "cmd.editor.format",
    scope: "editor",
    defaultKeys: both("Shift+Alt+F"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "editorFocus",
  },
  {
    id: "editor.goToDefinition",
    labelKey: "cmd.editor.goToDefinition",
    scope: "editor",
    defaultKeys: both("F12"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "editorFocus",
  },
  {
    id: "editor.findReferences",
    labelKey: "cmd.editor.findReferences",
    scope: "editor",
    defaultKeys: both("Shift+F12"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "editorFocus",
  },
  {
    id: "editor.codeActions",
    labelKey: "cmd.editor.codeActions",
    scope: "editor",
    defaultKeys: both("Mod+."),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "editorFocus",
  },

  // ── browser：浏览器节点内部（B01） ──────────────────────────────
  //
  // 浏览器节点的画面是一个透明 textarea，按键原样转发给远端 CDP 会话，
  // 所以这几条必须 `allowWhileTyping`，并且必须靠 `when` 限死在节点内——
  // 在别处截走 ⌘R / ⌘L 就是把浏览器的键从整个应用里偷走。
  //
  // 键位沿用真实浏览器的那一组，从浏览器过来的人不用重学。
  {
    id: "browser.reload",
    labelKey: "cmd.browser.reload",
    scope: "browser",
    defaultKeys: both("Mod+R"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "browserFocus",
  },
  {
    id: "browser.back",
    labelKey: "cmd.browser.back",
    scope: "browser",
    // mac 上是 ⌘[，其余平台是 Alt+←，两边都是各自系统里的写法。
    defaultKeys: { mac: "Mod+BracketLeft", other: "Alt+ArrowLeft" },
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "browserFocus",
  },
  {
    id: "browser.forward",
    labelKey: "cmd.browser.forward",
    scope: "browser",
    defaultKeys: { mac: "Mod+BracketRight", other: "Alt+ArrowRight" },
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "browserFocus",
  },
  {
    id: "browser.focusAddress",
    labelKey: "cmd.browser.focusAddress",
    scope: "browser",
    defaultKeys: both("Mod+L"),
    allowInTerminal: false,
    allowWhileTyping: true,
    when: "browserFocus",
  },

  // ── global：操作系统热键（仅桌面壳） ────────────────────────────
  //
  // 默认都不绑。一个全局热键在**别的应用**里也会触发，所以把它装上必须是
  // 用户在设置页里明确做的事；装上之后由 `tauri-plugin-global-shortcut`
  // 注册，与页面里的这一套监听器完全无关——`when` 与 `allowInTerminal`
  // 对它们没有意义，浏览器里这一组整节不显示。
  {
    id: "global.toggleWindow",
    labelKey: "cmd.global.toggleWindow",
    scope: "global",
    defaultKeys: both(null),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "global.newTerminal",
    labelKey: "cmd.global.newTerminal",
    scope: "global",
    defaultKeys: both(null),
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── scm ────────────────────────────────────────────────────────
  {
    id: "scm.commit",
    labelKey: "cmd.scm.commit",
    scope: "scm",
    defaultKeys: both("Mod+Enter"),
    allowInTerminal: false,
    // 提交信息输入框里按 ⌘⏎ 就是这条命令的主要用法，必须放行
    allowWhileTyping: true,
  },
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]["id"];

export type Command = CommandSpec & { id: CommandId };

export const COMMAND_BY_ID = Object.fromEntries(
  COMMANDS.map((command) => [command.id, command]),
) as Record<CommandId, Command>;

export function commandsInScope(scope: CommandScope): readonly Command[] {
  return COMMANDS.filter((command) => command.scope === scope);
}
