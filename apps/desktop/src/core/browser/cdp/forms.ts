import { MAX_INSERT_TEXT } from "./allowlist";
import { DRIVE_CODES, refuse } from "./codes";
import { clearField, clickAt, pressKey, sleep } from "./input";
import {
  actionable,
  label,
  pointOf,
  resolveRef,
  stateOf,
  type ElementState,
  type Target,
} from "./locate";
import { normalizeName, refName } from "./refs";
import type { CdpSession } from "./session";
import { findByRole, originOf } from "./snapshot";

/**
 * Filling things in: `type`, `fill`, `select`.
 *
 * Every write is an Input event — a click to focus, `Input.insertText` for
 * text, a key for a dropdown step. Nothing assigns to `value`: the frozen
 * scripts are readers, and a field set by a script is a field whose page never
 * saw anybody type into it (no `input` event, no framework state, a form that
 * submits the old value).
 */

/** Types into the focused field (after clicking the target, if one). */
export async function typeInto(
  session: CdpSession,
  target: Target | undefined,
  body: string,
  options: { replace: boolean; submit: boolean },
): Promise<{ chars: number; filled: boolean }> {
  if (body.length > MAX_INSERT_TEXT)
    refuse(DRIVE_CODES.badArgument, "一次 type 的文字太长");
  if (target !== undefined) {
    const point = await pointOf(session, target);
    const state = await actionable(session, target);
    if (!state.editable)
      refuse(DRIVE_CODES.refused, `${label(target)} 不是能输入文字的地方`);
    if (!state.focused) await clickAt(session, point);
  } else {
    const focused = await session.run<{ found: boolean; editable: boolean }>(
      "activeField",
    );
    // A field inside a cross-origin iframe is not visible from here; the page
    // only sees the iframe element. `--ref` reaches it.
    if (!focused?.found || !focused.editable)
      refuse(
        DRIVE_CODES.refused,
        "当前焦点不在输入框上；请用 --ref 指明要输入的地方",
      );
  }
  if (options.replace) await clearField(session);
  if (body.length > 0) await session.input("Input.insertText", { text: body });
  if (options.submit)
    await pressKey(session, { key: "Enter", modifiers: 0 }, 1);
  await sleep(80);
  const after =
    target?.node !== undefined
      ? await stateOf(session, target).catch(() => undefined)
      : undefined;
  return { chars: [...body].length, filled: after?.filled === true };
}

const TRUE = new Set(["true", "1", "yes", "on", "是", "勾选", "checked"]);
const FALSE = new Set(["false", "0", "no", "off", "否", "取消", "unchecked"]);

export interface FieldResult {
  readonly ref: string;
  readonly what: string;
  readonly outcome: string;
}

/**
 * `fill --field e3=hello --field e5=true --field e7=上海`.
 *
 * Each field by what it IS rather than by what the caller said: a text box
 * gets the text (replacing what was there), a checkbox or a radio is clicked
 * only if its state differs from the one asked for, a dropdown goes through
 * {@link choose}. A field that fails stops the batch — and the answer lists
 * what was already done, because a half-filled form is a fact the caller has
 * to know about.
 */
export async function fillFields(
  session: CdpSession,
  fields: readonly string[],
): Promise<{ fields: FieldResult[] }> {
  if (fields.length === 0)
    refuse(DRIVE_CODES.badArgument, "fill 需要至少一个 --field 引用=值");
  if (fields.length > 30) refuse(DRIVE_CODES.badArgument, "一次最多填 30 项");
  const parsed = fields.map((field) => {
    const at = field.indexOf("=");
    if (at <= 0)
      refuse(DRIVE_CODES.badArgument, `${field} 不是「引用=值」的写法`);
    return { ref: field.slice(0, at).trim(), value: field.slice(at + 1) };
  });
  const done: FieldResult[] = [];
  for (const { ref, value } of parsed) {
    let target: Target;
    try {
      target = await resolveRef(session, ref);
      done.push(await fillOne(session, target, value));
    } catch (error) {
      if (done.length === 0) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : DRIVE_CODES.failed;
      const already = done
        .map((each) => `${each.ref} ${each.outcome}`)
        .join("；");
      refuse(code, `${ref} 没填上（${message}）；已填：${already}`);
    }
  }
  return { fields: done };
}

async function fillOne(
  session: CdpSession,
  target: Target,
  value: string,
): Promise<FieldResult> {
  const ref = target.ref ?? "";
  const point = await pointOf(session, target);
  const state = await actionable(session, target);
  if (
    state.isSelect ||
    target.role === "combobox" ||
    target.role === "listbox"
  ) {
    if (!state.editable) {
      const chosen = await choose(session, target, [value]);
      return { ref, what: label(target), outcome: `选了 ${chosen}` };
    }
  }
  if (
    state.checkable ||
    ["checkbox", "radio", "switch"].includes(target.role)
  ) {
    const lowered = value.trim().toLowerCase();
    const want = TRUE.has(lowered)
      ? true
      : FALSE.has(lowered)
        ? false
        : undefined;
    if (want === undefined)
      refuse(DRIVE_CODES.badArgument, `${ref} 是复选框，值请写 true 或 false`);
    if (state.checked !== want) {
      if (!want && target.role === "radio")
        refuse(DRIVE_CODES.refused, `${ref} 是单选按钮，取消要选同组的另一个`);
      await clickAt(session, point);
      await sleep(50);
    }
    const after = await stateOf(session, target);
    if (after.checked !== want)
      refuse(DRIVE_CODES.refused, `${ref} 点了之后状态没变`);
    return {
      ref,
      what: label(target),
      outcome: want ? "已勾选" : "已取消勾选",
    };
  }
  if (!state.editable)
    refuse(DRIVE_CODES.refused, `${label(target)} 不是能填写的表单项`);
  if (!state.focused) await clickAt(session, point);
  await clearField(session);
  if (value.length > 0)
    await session.input("Input.insertText", { text: value });
  return {
    ref,
    what: label(target),
    outcome: `已输入 ${[...value].length} 个字符`,
  };
}

/**
 * Chooses an option. A native `<select>` is stepped with arrow keys on the
 * CLOSED element — a native dropdown's popup is an OS control that swallows
 * synthesized input. Anything else that calls itself a combobox or a listbox
 * is opened with a click and its option clicked like any other element.
 */
export async function choose(
  session: CdpSession,
  target: Target,
  wanted: readonly string[],
): Promise<string> {
  if (wanted.length === 0)
    refuse(DRIVE_CODES.badArgument, "select 需要 --value 或 --label");
  const point = await pointOf(session, target);
  const state = await actionable(session, target);
  if (state.isSelect) return chooseNative(session, target, state, wanted);
  if (!["combobox", "listbox", "button"].includes(target.role))
    refuse(DRIVE_CODES.refused, `${label(target)} 不是下拉框`);
  return chooseCustom(session, target, point, state, wanted);
}

async function chooseNative(
  session: CdpSession,
  target: Target,
  state: ElementState,
  wanted: readonly string[],
): Promise<string> {
  const matches = (option: { value: string; label: string }) =>
    wanted.includes(option.value) || wanted.includes(option.label);
  const goal = state.options.findIndex(matches);
  if (goal < 0) refuse(DRIVE_CODES.notFound, `${label(target)} 没有这个选项`);
  const current = state.options.findIndex((option) => option.selected);
  if (current === goal)
    return state.options[goal]!.label || state.options[goal]!.value;
  // Focus without opening: a click opens the native popup, and in a headed
  // browser that popup would then take the keys.
  if (!state.focused && target.node !== undefined)
    await session.send("DOM.focus", { ...target.node }, target.session);
  const picked = async (): Promise<string | undefined> => {
    const now = await stateOf(session, target);
    const selected = now.options.find((option) => option.selected);
    return selected && matches(selected)
      ? selected.label || selected.value
      : undefined;
  };
  // Type-ahead first: the option's own text, one character event at a time,
  // selects it on a CLOSED dropdown on every platform. (Arrow keys do not:
  // on macOS they open an OS menu that synthesized keys never reach.) The
  // page's type-ahead buffer lasts about a second, so a second choice right
  // after a first waits it out rather than extending the first one's search.
  const text = state.options[goal]!.label;
  if (text !== "") {
    const quiet = Date.now() - lastTypeAhead;
    if (quiet < 1_100) await sleep(1_100 - quiet);
    for (const character of [...text].slice(0, 64)) {
      await session.input("Input.dispatchKeyEvent", {
        type: "char",
        text: character,
      });
    }
    lastTypeAhead = Date.now();
    await sleep(60);
    const done = await picked();
    if (done !== undefined) return done;
  }
  // Two options with the same text, or text a type-ahead cannot spell (it
  // does not match CJK): the one frozen script that writes, which selects
  // exactly this option of exactly this dropdown and fires the `input` and
  // `change` a person's choice would (see `scripts.ts`).
  const chosen = await session.runOn<{ ok: boolean }>(
    target.node!,
    "chooseOption",
    goal,
    target.session,
  );
  if (chosen?.ok === true) {
    const done = await picked();
    if (done !== undefined) return done;
  }
  refuse(
    DRIVE_CODES.refused,
    `${label(target)} 没有停在那个选项上（可能是禁用的选项）`,
  );
}

/** When this process last typed into a dropdown's type-ahead. */
let lastTypeAhead = 0;

const OPTION_ROLES = ["option", "menuitem", "menuitemradio", "treeitem"];

async function chooseCustom(
  session: CdpSession,
  target: Target,
  point: { x: number; y: number },
  state: ElementState,
  wanted: readonly string[],
): Promise<string> {
  await clickAt(session, point);
  await sleep(200);
  let option = await findOption(session, wanted);
  if (option === undefined && state.editable) {
    // An editable combobox filters as you type; the list may only contain the
    // option once part of its text is in the box.
    await session.input("Input.insertText", { text: wanted[0]! });
    await sleep(300);
    option = await findOption(session, wanted);
  }
  if (option === undefined)
    refuse(
      DRIVE_CODES.notFound,
      `打开 ${label(target)} 后没有找到选项 ${wanted.join(" / ")}`,
    );
  const optionPoint = await pointOf(session, option);
  await clickAt(session, optionPoint);
  await sleep(150);
  return option.name;
}

async function findOption(
  session: CdpSession,
  wanted: readonly string[],
): Promise<Target | undefined> {
  const names = wanted.map((each) => normalizeName(each));
  for (const role of OPTION_ROLES) {
    const { candidates, url } = await findByRole(session, role, undefined);
    const exact = candidates.filter((each) =>
      names.includes(normalizeName(each.name)),
    );
    const loose =
      exact.length > 0
        ? exact
        : candidates.filter((each) =>
            names.some((name) =>
              normalizeName(each.name)
                .toLowerCase()
                .includes(name.toLowerCase()),
            ),
          );
    if (loose.length === 0) continue;
    if (loose.length > 1 && exact.length !== 1)
      refuse(
        DRIVE_CODES.badArgument,
        `有 ${loose.length} 个选项像 ${wanted.join(" / ")}，请写出完整的选项文字`,
      );
    const hit = loose[0]!;
    const record = session.refs.mint(
      hit.session,
      hit.backendNodeId,
      hit.role,
      hit.name,
      originOf(url),
    );
    return {
      session: hit.session,
      node: { backendNodeId: hit.backendNodeId },
      role: hit.role,
      name: hit.name,
      ref: refName(record.ordinal),
    };
  }
  return undefined;
}
