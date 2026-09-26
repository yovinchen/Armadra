/**
 * The frozen script table: every line of JavaScript that is ever allowed to
 * run inside a guest page.
 *
 * Four properties, each enforced by scripts.source.test.ts rather than
 * remembered:
 *
 *   1. Every entry is a SINGLE-QUOTED string literal with no interpolation and
 *      no concatenation. A script assembled at runtime is a script whose text
 *      nobody has read.
 *   2. Every entry but one is a pure READER (the exception, chooseOption, is
 *      explained where it is defined and pinned by the source test). Nothing
 *      here clicks, navigates, submits,
 *      assigns to a field, or writes to any HTML sink. Input is synthesized
 *      with CDP Input events against measured coordinates, which is a path a
 *      page cannot distinguish from a person and a path no script participates
 *      in.
 *   3. The table is frozen, so no later module can add a member.
 *   4. isArmadraScript is a byte-for-byte membership check. One trailing
 *      space makes a string a stranger.
 *
 * Arbitrary page-side evaluation is not in the CDP allowlist at all, in any of
 * its spellings. These functions reach a page only through the allowlist entry
 * for Runtime.callFunctionOn, which requires isArmadraScript(functionDeclaration),
 * returnByValue === true, and at most one scalar argument. The one entry
 * allowed an answer by reference is shadowQuery, whose answer is an element
 * handle that only DOM.requestNode ever reads (see where it is defined).
 *
 * This file contains no backtick and no interpolation marker anywhere,
 * including in its prose, so the source scan can be a flat search rather than a
 * parser with exceptions.
 *
 * Which ELEMENT a script is about is no longer decided in here. There used to
 * be one CSS enumeration of "interactive elements" repeated in five scripts,
 * and a ref was an index into it. Refs now come from the accessibility tree
 * and name a backend DOM node (refs.ts), so a script that needs an element is
 * called ON it: the element is the receiver, obtained through DOM.resolveNode
 * from a node id, and the script only reads it.
 */

/* eslint-disable no-useless-escape */

const READ_TITLE =
  "function () { return { title: document.title, url: location.href }; }";

const READ_TEXT =
  'function (limit) { var body = document.body; var text = body ? body.innerText : ""; return { text: text.slice(0, limit), total: text.length, truncated: text.length > limit, title: document.title, url: location.href }; }';

const READ_LINKS =
  'function (limit) { var out = []; var all = document.querySelectorAll("a[href]"); for (var i = 0; i < all.length && out.length < limit; i++) { var el = all[i]; var st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") continue; if (el.closest("[aria-hidden=true]")) continue; var href = el.href || ""; if (href.indexOf("http:") !== 0 && href.indexOf("https:") !== 0) continue; var name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim(); out.push({ name: name.slice(0, 120), href: href.slice(0, 500) }); } return { links: out, title: document.title, url: location.href }; }';

/* A selector may pierce open shadow roots with >>> (host >>> inner), the
 * same spelling shadowQuery below reads. A closed shadow root is simply not
 * there: the element is absent, which is what wait keeps waiting on. */
const WAIT_PROBE =
  'function (selector) { var el = null; if (selector) { var parts = String(selector).split(">>>"); var scope = document; for (var i = 0; i < parts.length && scope; i++) { if (parts[i].trim() === "") return { invalid: true, present: false, visible: false, title: document.title, url: location.href }; try { el = scope.querySelector(parts[i].trim()); } catch (e) { return { invalid: true, present: false, visible: false, title: document.title, url: location.href }; } if (!el) break; if (i < parts.length - 1) { scope = el.shadowRoot; el = null; } } } var visible = false; if (el) { var st = getComputedStyle(el); var r = el.getBoundingClientRect(); visible = st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0; } return { invalid: false, present: !!el, visible: visible, title: document.title, url: location.href, ready: document.readyState }; }';

/* The focused field, following focus down through same-origin frames. A
 * cross-origin frame stops the walk at its iframe element, which is not
 * editable here; a verb that aims at a field inside one asks that frame's
 * own session instead. */
const ACTIVE_FIELD =
  'function () { var el = document.activeElement; for (var hops = 0; hops < 8 && el && (el.tagName === "IFRAME" || el.tagName === "FRAME"); hops++) { var inner = null; try { inner = el.contentDocument; } catch (e) { inner = null; } if (!inner || !inner.activeElement) break; el = inner.activeElement; } if (!el || el === document.body) return { found: false }; var tag = el.tagName.toLowerCase(); var type = (el.getAttribute("type") || "").toLowerCase(); return { found: true, tag: tag, type: type, editable: (tag === "input" && type !== "checkbox" && type !== "radio" && type !== "file" && type !== "button" && type !== "submit") || tag === "textarea" || el.isContentEditable === true, filled: !!(el.value || (el.isContentEditable && el.textContent)) }; }';

const SCROLL_POSITION =
  "function () { var doc = document.scrollingElement || document.documentElement; return { top: doc.scrollTop, left: doc.scrollLeft, height: doc.scrollHeight, width: doc.scrollWidth, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight, title: document.title, url: location.href }; }";

/* Called ON an element. What a verb needs to know before it acts: can this be
 * clicked (visible, enabled, and actually the thing under its own centre —
 * not covered by a cookie banner; asked of the element's own root, so that
 * inside a shadow root the answer is not just the host), can it be typed
 * into, is it filled, is it
 * checked, and for a native dropdown its options. A field reports whether it
 * is filled, never what is in it; an option is the page's own text. */
const ELEMENT_STATE =
  'function () { var el = this; if (!el || el.nodeType !== 1) return { found: false }; var doc = el.ownerDocument; var view = doc.defaultView; var tag = el.tagName.toLowerCase(); var type = (el.getAttribute("type") || "").toLowerCase(); var st = view.getComputedStyle(el); var r = el.getBoundingClientRect(); var visible = st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0; var home = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : doc; var hit = visible ? home.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null; var label = hit && hit.closest ? hit.closest("label") : null; var receives = !!hit && (hit === el || el.contains(hit) || (label !== null && label.control === el)); var blocker = ""; if (visible && hit && !receives) { var what = (hit.getAttribute("aria-label") || hit.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60); blocker = hit.tagName.toLowerCase() + (what ? " " + JSON.stringify(what) : ""); } var textual = ["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]; var editable = !el.readOnly && ((tag === "input" && textual.indexOf(type) >= 0) || tag === "textarea" || el.isContentEditable === true); var checkable = (tag === "input" && (type === "checkbox" || type === "radio")) || el.getAttribute("aria-checked") !== null; var checked = tag === "input" ? !!el.checked : el.getAttribute("aria-checked") === "true"; var options = []; if (tag === "select") { for (var i = 0; i < el.options.length && i < 200; i++) { options.push({ value: el.options[i].value, label: (el.options[i].textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120), selected: el.options[i].selected }); } } return { found: true, tag: tag, type: type, visible: visible, receives: receives, blocker: blocker, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true", editable: editable, filled: !!(el.value || (el.isContentEditable && el.textContent)), checkable: checkable, checked: checked, isSelect: tag === "select", multiple: !!el.multiple, options: options, accepts: tag === "input" && type === "file", focused: home.activeElement === el }; }';

/* Whether a piece of text is on the page, same-origin frames included. A
 * cross-origin frame is asked through its own session. */
const HAS_TEXT =
  'function (needle) { var docs = [document]; var found = false; for (var i = 0; i < docs.length && i < 50; i++) { var d = docs[i]; if (d.body && (d.body.innerText || "").indexOf(needle) >= 0) { found = true; break; } var frames = d.querySelectorAll("iframe,frame"); for (var j = 0; j < frames.length; j++) { var inner = null; try { inner = frames[j].contentDocument; } catch (e) { inner = null; } if (inner) docs.push(inner); } } return { found: found, title: document.title, url: location.href }; }';

/* --selector host >>> inner: a CSS selector per level, each one run in the
 * open shadow root of what the previous one found. The one entry whose
 * answer is NOT copied by value: what it returns is the element itself, and
 * the verb turns that handle into a DOM node id (DOM.requestNode) and lets
 * it go, the same node a plain selector gets from DOM.querySelector — which
 * cannot enter a shadow root. When there is no element it returns a short
 * string instead: bad for a level that is empty or not CSS, none:N for a
 * level that matched nothing, closed:N for a host without an OPEN shadow
 * root (a closed one is out of reach of page script and of this protocol
 * alike, and the answer says so rather than pretend it looked). */
const SHADOW_QUERY =
  'function (chain) { var parts = String(chain).split(">>>"); var scope = this; var el = null; for (var i = 0; i < parts.length; i++) { var css = parts[i].trim(); if (css === "") return "bad"; try { el = scope.querySelector(css); } catch (e) { return "bad"; } if (!el) return "none:" + i; if (i < parts.length - 1) { if (!el.shadowRoot) return "closed:" + i; scope = el.shadowRoot; } } return el; }';

/* The ONE writer, and why it exists. A closed native dropdown is the one
 * control synthesized input cannot always operate: on macOS an arrow key
 * opens an OS menu that no CDP event reaches, and type-ahead does not match
 * CJK text. So select, after type-ahead has failed, calls this ON the select
 * element it resolved: it refuses anything that is not an enabled SELECT or
 * an enabled option of it, sets that one option, and fires the input and
 * change events a person's choice fires. It takes indexes, not values, so
 * it can only pick among what the page itself offers.
 *
 * A multiple select takes several indexes, comma separated, and ends with
 * exactly those options selected: a person picks them one ctrl-click at a
 * time, which is not an input a closed list answers. Several indexes for a
 * select without the multiple attribute are refused here as well as by the
 * verb, so the one writer cannot be talked into a second shape. */
const CHOOSE_OPTION =
  'function (wanted) { var el = this; if (!el || el.tagName !== "SELECT" || el.disabled) return { ok: false }; var parts = String(wanted).split(","); if (parts.length > 1 && !el.multiple) return { ok: false }; var picks = []; for (var i = 0; i < parts.length; i++) { var option = el.options[Number(parts[i])]; if (parts[i] === "" || !option || option.disabled) return { ok: false }; picks.push(Number(parts[i])); } if (el.multiple) { for (var j = 0; j < el.options.length; j++) { el.options[j].selected = picks.indexOf(j) >= 0; } } else { el.selectedIndex = picks[0]; } el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true }; }';

/* eslint-enable no-useless-escape */

/**
 * The table. Frozen, and the only source of page-side JavaScript in the shell.
 */
export const SCRIPTS = Object.freeze({
  readTitle: READ_TITLE,
  readText: READ_TEXT,
  readLinks: READ_LINKS,
  waitProbe: WAIT_PROBE,
  activeField: ACTIVE_FIELD,
  scrollPosition: SCROLL_POSITION,
  elementState: ELEMENT_STATE,
  hasText: HAS_TEXT,
  shadowQuery: SHADOW_QUERY,
  chooseOption: CHOOSE_OPTION,
});

export type ScriptName = keyof typeof SCRIPTS;

const MEMBERS: readonly string[] = Object.freeze(Object.values(SCRIPTS));

/**
 * Byte-for-byte membership.
 *
 * Not a prefix test, not a "looks like one of ours" heuristic, not a hash: the
 * exact string. The allowlist entry for Runtime.callFunctionOn calls this on
 * the declaration it is about to send, so anything that is not literally one of
 * the members above never reaches a page.
 */
export function isArmadraScript(value: unknown): value is string {
  return typeof value === "string" && MEMBERS.includes(value);
}
