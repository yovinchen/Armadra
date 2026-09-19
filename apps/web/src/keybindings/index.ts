/**
 * 快捷键系统的公开入口。
 *
 * 曾经是一个 941 行的 `keybindings.ts`；`when` 条件与新的两组节点内命令
 * 会把它推到一千五百行以上，所以按职责拆成了这几块：
 *
 * | 文件                | 负责                                             |
 * | ------------------- | ------------------------------------------------ |
 * | `commands.ts`       | 命令表：id、scope、默认键、`when`                |
 * | `chords.ts`         | 写法解析、事件匹配、显示串                       |
 * | `when.ts`           | `when` 表达式的解析、求值与「能否同时成立」      |
 * | `context.ts`        | 焦点在哪里：DOM → `when` 上下文                  |
 * | `active.ts`         | 生效中的键位表与 `commandKeys` / `…Label`        |
 * | `use-keybindings.ts`| 那一个捕获阶段监听器                             |
 * | `accelerator.ts`    | 和弦 → accelerator 写法（系统热键用）           |
 * | `global-shortcuts.ts`| 系统热键的注册请求、结果与触发事件              |
 *
 * 导入路径没变：`from "../keybindings"` 仍然解析到这里。
 */
export * from "./commands";
export * from "./chords";
export * from "./when";
export * from "./context";
export * from "./active";
export * from "./use-keybindings";
export * from "./accelerator";
export * from "./global-shortcuts";
