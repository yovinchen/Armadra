import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./app/App";
import { PreferencesProvider } from "./preferences/Preferences";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
    >
      <QueryClientProvider client={queryClient}>
        <PreferencesProvider>
          <ReactFlowProvider>
            <App />
          </ReactFlowProvider>
        </PreferencesProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
