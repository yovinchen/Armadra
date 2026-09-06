/**
 * 样式面板的转发口（React Flow 计划 §4.1，归属 whiteboard）。
 *
 * 面板本体在 `whiteboard/StylePanel.tsx`——它和色板、模型、store 是同一个
 * 包的东西。`FlowWorkspace` 的 import 路径由 B0 定下，所以这里留一行
 * re-export，装配文件一个字都不用改。
 */
export { CanvasStylePanel } from "./whiteboard/StylePanel";
