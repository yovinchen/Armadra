/**
 * The guest context menu: a template function and one coordinate conversion.
 *
 * Neither imports Electron, which is what makes the conversion testable — and
 * the conversion is the part that was actually wrong everywhere it was assumed.
 *
 * **The measurement (webview-probe §4).** A guest `context-menu` event's
 * `params.x / params.y` are HOST WINDOW coordinates, not the guest's CSS
 * pixels. Across canvas zooms 0.5 / 1 / 2 they tracked the synthesized host
 * point to within the host's integer rounding (0, 0, 0.5 px), while their
 * distance from the guest's own `clientX/Y` grew linearly with zoom
 * (-109 / +21 / +282 px). `contents.inspectElement(x, y)` wants the GUEST's
 * viewport coordinates. Handing it `params.x/y` therefore opens DevTools on
 * whatever element happens to sit at that number, and only looks correct at
 * zoom exactly 1.
 *
 * So: subtract the `<webview>` element's host rect origin, then divide by the
 * canvas zoom. `inspectElementPoint` is that, with a test at three zooms.
 */

export interface HostRect {
  readonly x: number;
  readonly y: number;
}

export interface GuestPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Host window point -> guest viewport point.
 *
 * `zoom` is the canvas transform's scale. A zoom of 0 or a non-finite number
 * would divide the answer into nonsense, so it is clamped to something a
 * canvas can actually be at; the caller that produced a zoom of 0 has a bug,
 * and inspecting the top-left corner is a better outcome than `Infinity`.
 */
export function inspectElementPoint(
  params: GuestPoint,
  rect: HostRect,
  zoom: number,
): GuestPoint {
  const scale = Number.isFinite(zoom) && zoom > 0.001 ? zoom : 1;
  return {
    x: Math.round((params.x - rect.x) / scale),
    y: Math.round((params.y - rect.y) / scale),
  };
}

/** One row of the menu. `role` is Electron's built-in editing role when the
 * item has one; `id` is ours, for the items that do not. */
export interface MenuTemplateItem {
  readonly role?: string;
  readonly id?: string;
  readonly type?: "separator";
  readonly enabled?: boolean;
}

/** The subset of Electron's `ContextMenuParams` the template reads. */
export interface ContextMenuFacts {
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly linkURL: string;
  readonly editFlags: {
    readonly canCut?: boolean;
    readonly canCopy?: boolean;
    readonly canPaste?: boolean;
  };
  /** Whether the shell offers DevTools at all in this build. */
  readonly developerTools: boolean;
}

/**
 * The menu, as data.
 *
 * "Inspect element" is the ONLY route to DevTools on a guest. There is no
 * keyboard shortcut and no menu-bar entry for it, because a guest's DevTools is
 * a window with a console attached to somebody's logged-in session, and it
 * should take a deliberate right-click on the page it belongs to.
 */
export function guestContextMenu(facts: ContextMenuFacts): MenuTemplateItem[] {
  const items: MenuTemplateItem[] = [];
  if (facts.isEditable) {
    items.push(
      { role: "cut", enabled: facts.editFlags.canCut === true },
      { role: "copy", enabled: facts.editFlags.canCopy === true },
      { role: "paste", enabled: facts.editFlags.canPaste === true },
      { role: "selectAll" },
    );
  } else if (facts.selectionText.trim().length > 0) {
    items.push({ role: "copy", enabled: facts.editFlags.canCopy === true });
  }
  if (facts.linkURL) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ id: "copyLink" }, { id: "openLinkInNewTab" });
  }
  if (items.length > 0) items.push({ type: "separator" });
  items.push({ id: "back" }, { id: "forward" }, { id: "reload" });
  if (facts.developerTools) {
    items.push({ type: "separator" }, { id: "inspectElement" });
  }
  return items;
}
