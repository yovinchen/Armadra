import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@xterm/xterm/css/xterm.css";
// Tailwind v4 入口；它自己 @import 了 tokens.css，这里不再单独引入
import "./styles/app.css";
import "./styles/nodes.css";
import { App } from "./app/App";

/**
 * tldraw 的导航面板把「缩略图收起」记在 localStorage 的 `minimap` 键里，
 * 默认是收起。我们的画布一直有右下角缩略图（原 `StatusMiniMap`），
 * 所以首次运行时把默认翻成展开；用户之后收起的选择照旧生效。
 */
try {
  if (localStorage.getItem("minimap") === null) {
    localStorage.setItem("minimap", "false");
  }
} catch {
  // 隐私模式下没有 localStorage，缩略图退回 tldraw 的默认收起状态
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
    >
      <App />
    </MotionConfig>
  </StrictMode>,
);
