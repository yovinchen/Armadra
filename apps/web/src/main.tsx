import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@xterm/xterm/css/xterm.css";
// Tailwind v4 入口；它自己 @import 了 tokens.css，这里不再单独引入
import "./styles/app.css";
import "./styles/nodes.css";
import { App } from "./app/App";

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
