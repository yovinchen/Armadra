import { useEffect, useState, type KeyboardEvent } from "react";
import { MAX_BROWSER_HISTORY } from "@ai-coding-canvas/shared";
import { openExternal } from "../platform";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { sendToAgent } from "./actions";
import { hostnameTitle, normalizeUrl } from "./helpers";
import type { NodeContentProps, OfKind } from "./types";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/** Browser body: toolbar, sandboxed iframe, 截图 (reserved) / @ 发送给 Agent. */
export function BrowserNode({ id, data }: NodeContentProps) {
  const { t } = usePreferences();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const browser = data as OfKind<"browser">;
  const [address, setAddress] = useState(browser.url);
  const [reloads, setReloads] = useState(0);

  useEffect(() => setAddress(browser.url), [browser.url]);

  const empty = !browser.url || browser.url === "https://";
  const canBack = browser.historyIndex > 0;
  const canForward = browser.historyIndex < browser.history.length - 1;

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    const kept = browser.history.slice(0, browser.historyIndex + 1);
    const history = [...kept, url].slice(-MAX_BROWSER_HISTORY);
    updateNode(id, {
      url,
      history,
      historyIndex: history.length - 1,
      title: hostnameTitle(url, t("node.browser")),
    });
  };

  const step = (delta: number) => {
    const index = browser.historyIndex + delta;
    const url = browser.history[index];
    if (!url) return;
    updateNode(id, {
      url,
      historyIndex: index,
      title: hostnameTitle(url, t("node.browser")),
    });
  };

  return (
    <div className="browser-body nodrag nowheel">
      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-nav nodrag"
          aria-label={t("browser.back")}
          disabled={!canBack}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="browser-nav nodrag"
          aria-label={t("browser.forward")}
          disabled={!canForward}
          onClick={() => step(1)}
        >
          ›
        </button>
        <button
          type="button"
          className="browser-nav nodrag"
          aria-label={t("browser.reload")}
          disabled={empty}
          onClick={() => setReloads((value) => value + 1)}
        >
          ↻
        </button>
        <div className="browser-address">
          <span aria-hidden="true" className="browser-lock">
            ⊙
          </span>
          <input
            className="nodrag"
            aria-label={t("browser.address")}
            spellCheck={false}
            maxLength={4_000}
            value={address}
            placeholder="https://"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              go(address);
            }}
          />
        </div>
        <button
          type="button"
          className="browser-nav nodrag"
          aria-label={t("browser.openExternal")}
          disabled={empty}
          onClick={() => void openExternal(browser.url)}
        >
          ↗
        </button>
      </div>

      <div className="browser-view">
        {empty ? (
          <p className="browser-empty">{t("browser.empty")}</p>
        ) : (
          <iframe
            key={`${browser.url}#${reloads}`}
            className="browser-frame"
            title={browser.title}
            src={browser.url}
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
          />
        )}
      </div>

      <div className="browser-footer">
        <button
          type="button"
          className="browser-button nodrag"
          disabled
          title={t("browser.screenshotReserved")}
        >
          ⤓ {t("browser.screenshot")}
        </button>
        <button
          type="button"
          className="browser-button nodrag"
          disabled={empty}
          onClick={() => sendToAgent(id)}
        >
          @ {t("browser.sendToAgent")}
        </button>
      </div>
    </div>
  );
}
