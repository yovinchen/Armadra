import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@xterm/xterm/css/xterm.css";
// Tailwind v4 入口；它自己 @import 了 tokens.css，这里不再单独引入
import "./styles/app.css";
import "./styles/nodes.css";
import { App } from "./app/App";
import { initRuntimeSockets } from "./api/client";

/**
 * 终端与事件流的 WebSocket 地址在桌面壳里不等于 HTTP 地址（roadmap §4.4），
 * 先问一次壳再挂载：这一步只有一次本地请求，失败也会回退到 HTTP 基址，
 * 所以不用挡住渲染之外的任何东西。
 */
initRuntimeSockets().finally(() => {
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
});
