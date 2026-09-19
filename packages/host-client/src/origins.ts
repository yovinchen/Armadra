/**
 * The fixed page origins a packaged Tauri shell presents: its own scheme on
 * macOS / Linux and the two WebView2 spellings on Windows. They go away with
 * that shell (docs/design/electron-migration.md §2.1, W5).
 */
export const NATIVE_PAGE_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

/** Loopback as the Host reads it: `localhost`, `::1`, or any `127.0.0.0/8`. */
function loopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Whether a page origin is one a desktop shell presents, and therefore one the
 * native session transport (docs/design/host-native-session.md §3) is for.
 *
 * Two shapes: the Tauri spellings above, and any loopback HTTP origin — the
 * Electron shell serves its page from a static server on a kernel-assigned
 * port, so there is no constant left to compare against. What makes a loopback
 * HTTP origin a shell origin is that nothing off this machine can be behind it.
 *
 * This is a spelling check, not an authorization, and it is deliberately the
 * same rule the Host applies in `apps/host/internal/server/native.go`. An
 * ordinary browser page CAN hold a loopback HTTP origin; it still cannot mint
 * the ticket a session starts from, because only the shell's same-user control
 * channel does that. Widening the spelling therefore moves no trust boundary.
 */
export function isNativePageOrigin(origin: string | undefined): boolean {
  if (typeof origin !== "string" || origin === "") return false;
  if ((NATIVE_PAGE_ORIGINS as readonly string[]).includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // `url.origin === origin` rejects a path, a query or credentials: an origin
  // is a scheme, a host and a port and nothing else.
  if (url.protocol !== "http:" || url.origin !== origin) return false;
  return loopbackHost(url.hostname);
}
