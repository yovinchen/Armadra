import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

/** 第一次搜索时才装 SearchAddon。 */
export async function ensureSearch(
  terminalRef: React.RefObject<Terminal | null>,
  searchRef: React.RefObject<SearchAddon | null>,
): Promise<SearchAddon | null> {
  if (searchRef.current) return searchRef.current;
  const terminal = terminalRef.current;
  if (!terminal) return null;
  const { SearchAddon } = await import("@xterm/addon-search");
  if (!terminalRef.current) return null;
  const addon = new SearchAddon();
  terminal.loadAddon(addon);
  searchRef.current = addon;
  return addon;
}
