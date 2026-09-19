export { BrowserNode } from "./BrowserNode";
export { BROWSER_DISCARD_MS, shouldDiscard } from "./discard";
export {
  BACKGROUND_WEBVIEW_MAX,
  applyWebviewPool,
  resetWebviewPool,
  webviewPoolOrder,
} from "./pool";
export { WebviewSurface } from "./WebviewSurface";
export { allowGuestNavigation, browserPartition, searchOrUrl } from "./webview";
export { MAX_TABS, tabLetter } from "./webview-tabs";
export { ActivityLine, LeaseBadge, controllerKey, sinceLabel } from "./Lease";
