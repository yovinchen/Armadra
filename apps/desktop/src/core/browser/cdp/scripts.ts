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
 *   2. Every entry is a pure READER. Nothing here clicks, navigates, submits,
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
 * returnByValue === true, and at most one scalar argument.
 *
 * This file contains no backtick and no interpolation marker anywhere,
 * including in its prose, so the source scan can be a flat search rather than a
 * parser with exceptions.
 */

/**
 * The one element enumeration the readers share.
 *
 * It is repeated verbatim inside each script that needs it because the scripts
 * cannot import or concatenate. The source test pins every copy to this
 * constant, so a drift is a failing build rather than a reader and a resolver
 * that quietly disagree about what element number seven is.
 */
export const ELEMENT_QUERY =
  "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[contenteditable=true]";

/* eslint-disable no-useless-escape */

const READ_TITLE =
  "function () { return { title: document.title, url: location.href }; }";

const READ_TEXT =
  'function (limit) { var body = document.body; var text = body ? body.innerText : ""; return { text: text.slice(0, limit), total: text.length, truncated: text.length > limit, title: document.title, url: location.href }; }';

const READ_LINKS =
  'function (limit) { var out = []; var all = document.querySelectorAll("a[href]"); for (var i = 0; i < all.length && out.length < limit; i++) { var el = all[i]; var st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") continue; if (el.closest("[aria-hidden=true]")) continue; var href = el.href || ""; if (href.indexOf("http:") !== 0 && href.indexOf("https:") !== 0) continue; var name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim(); out.push({ name: name.slice(0, 120), href: href.slice(0, 500) }); } return { links: out, title: document.title, url: location.href }; }';

const READ_MAP =
  'function (limit) { var q = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[contenteditable=true]"; var all = document.querySelectorAll(q); var out = []; for (var i = 0; i < all.length; i++) { var el = all[i]; var st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") continue; if (el.hasAttribute("hidden")) continue; if (el.closest("[aria-hidden=true]")) continue; var tag = el.tagName.toLowerCase(); var type = (el.getAttribute("type") || "").toLowerCase(); if (tag === "input" && type === "hidden") continue; var role = el.getAttribute("role") || (tag === "a" ? "link" : tag); var label = el.getAttribute("aria-label") || ""; if (!label && el.labels && el.labels.length) label = el.labels[0].textContent || ""; if (!label) label = el.getAttribute("placeholder") || ""; if (!label && tag !== "input" && tag !== "textarea" && tag !== "select") label = el.textContent || ""; if (!label && tag === "input" && type !== "password") label = el.getAttribute("name") || ""; label = label.replace(/\\s+/g, " ").trim().slice(0, 120); var detail = ""; if (tag === "input" || tag === "textarea") { detail = (type || "text") + ", " + (el.value ? "filled" : "empty"); } else if (tag === "select") { detail = "select, " + el.options.length + " options"; } if (el.disabled) detail = detail ? detail + ", disabled" : "disabled"; var r = el.getBoundingClientRect(); out.push({ index: i, role: role, name: label, detail: detail, x: r.x, y: r.y, w: r.width, h: r.height }); if (out.length >= limit) break; } return { elements: out, title: document.title, url: location.href }; }';

const RESOLVE_REF =
  'function (index) { var q = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[contenteditable=true]"; var all = document.querySelectorAll(q); var el = all[index]; if (!el) return { found: false }; var st = getComputedStyle(el); var r = el.getBoundingClientRect(); var tag = el.tagName.toLowerCase(); var role = el.getAttribute("role") || (tag === "a" ? "link" : tag); var label = el.getAttribute("aria-label") || ""; if (!label && el.labels && el.labels.length) label = el.labels[0].textContent || ""; if (!label) label = el.getAttribute("placeholder") || ""; if (!label && tag !== "input" && tag !== "textarea" && tag !== "select") label = el.textContent || ""; label = label.replace(/\\s+/g, " ").trim().slice(0, 120); return { found: true, role: role, name: label, x: r.x, y: r.y, w: r.width, h: r.height, visible: st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0, disabled: !!el.disabled, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight }; }';

const RESOLVE_SELECTOR =
  'function (selector) { var el = null; try { el = document.querySelector(selector); } catch (e) { return { found: false, invalid: true }; } if (!el) return { found: false }; var q = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[contenteditable=true]"; var all = document.querySelectorAll(q); var index = -1; for (var i = 0; i < all.length; i++) { if (all[i] === el) { index = i; break; } } var st = getComputedStyle(el); var r = el.getBoundingClientRect(); var tag = el.tagName.toLowerCase(); var role = el.getAttribute("role") || (tag === "a" ? "link" : tag); var label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || (tag === "input" || tag === "textarea" || tag === "select" ? "" : el.textContent) || "").replace(/\\s+/g, " ").trim().slice(0, 120); return { found: true, index: index, role: role, name: label, x: r.x, y: r.y, w: r.width, h: r.height, visible: st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0, disabled: !!el.disabled, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight }; }';

const DESCRIBE_ELEMENT =
  'function (index) { var q = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[contenteditable=true]"; var el = document.querySelectorAll(q)[index]; if (!el) return { found: false }; var tag = el.tagName.toLowerCase(); var type = (el.getAttribute("type") || "").toLowerCase(); var options = []; if (tag === "select") { for (var i = 0; i < el.options.length && i < 200; i++) { options.push({ value: el.options[i].value, label: (el.options[i].textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120), selected: el.options[i].selected }); } } return { found: true, tag: tag, type: type, filled: !!el.value, multiple: !!el.multiple, options: options, accepts: tag === "input" && type === "file" }; }';

const IS_VISIBLE =
  'function (index) { var q = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[contenteditable=true]"; var el = document.querySelectorAll(q)[index]; if (!el) return { found: false }; var st = getComputedStyle(el); var r = el.getBoundingClientRect(); return { found: true, visible: st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0, x: r.x, y: r.y, w: r.width, h: r.height, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight }; }';

const WAIT_PROBE =
  'function (selector) { var el = null; if (selector) { try { el = document.querySelector(selector); } catch (e) { return { invalid: true, present: false, visible: false, title: document.title, url: location.href }; } } var visible = false; if (el) { var st = getComputedStyle(el); var r = el.getBoundingClientRect(); visible = st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0; } return { invalid: false, present: !!el, visible: visible, title: document.title, url: location.href, ready: document.readyState }; }';

const ACTIVE_FIELD =
  'function () { var el = document.activeElement; if (!el || el === document.body) return { found: false }; var tag = el.tagName.toLowerCase(); var type = (el.getAttribute("type") || "").toLowerCase(); var r = el.getBoundingClientRect(); return { found: true, tag: tag, type: type, editable: tag === "input" || tag === "textarea" || el.isContentEditable === true, filled: !!el.value, x: r.x, y: r.y, w: r.width, h: r.height }; }';

const SCROLL_POSITION =
  "function () { var doc = document.scrollingElement || document.documentElement; return { top: doc.scrollTop, left: doc.scrollLeft, height: doc.scrollHeight, width: doc.scrollWidth, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight, title: document.title, url: location.href }; }";

/* eslint-enable no-useless-escape */

/**
 * The table. Frozen, and the only source of page-side JavaScript in the shell.
 */
export const SCRIPTS = Object.freeze({
  readTitle: READ_TITLE,
  readText: READ_TEXT,
  readLinks: READ_LINKS,
  readMap: READ_MAP,
  resolveRef: RESOLVE_REF,
  resolveSelector: RESOLVE_SELECTOR,
  describeElement: DESCRIBE_ELEMENT,
  isVisible: IS_VISIBLE,
  waitProbe: WAIT_PROBE,
  activeField: ACTIVE_FIELD,
  scrollPosition: SCROLL_POSITION,
});

export type ScriptName = keyof typeof SCRIPTS;

const MEMBERS: readonly string[] = Object.freeze(Object.values(SCRIPTS));

/**
 * Byte-for-byte membership.
 *
 * Not a prefix test, not a "looks like one of ours" heuristic, not a hash: the
 * exact string. The allowlist entry for Runtime.callFunctionOn calls this on
 * the declaration it is about to send, so anything that is not literally one of
 * the eleven above never reaches a page.
 */
export function isArmadraScript(value: unknown): value is string {
  return typeof value === "string" && MEMBERS.includes(value);
}
