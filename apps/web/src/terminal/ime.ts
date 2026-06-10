const compositionEvents = [
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "beforeinput",
  "input",
  "keydown",
  "keypress",
  "keyup",
] as const;

/** Keep React Flow and app-level shortcuts from consuming IME events.
 * xterm's CompositionHelper still receives the events because default behavior
 * is never prevented and the listener runs on the hidden textarea itself.
 */
export function isolateTerminalInput(
  textarea: HTMLTextAreaElement,
  locale: string,
) {
  textarea.lang = locale;
  textarea.inputMode = "text";
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.spellcheck = false;
  textarea.setAttribute(
    "aria-label",
    locale.startsWith("zh") ? "终端输入" : "Terminal input",
  );
  const stopPropagation = (event: Event) => event.stopPropagation();
  for (const event of compositionEvents)
    textarea.addEventListener(event, stopPropagation);
  return () => {
    for (const event of compositionEvents)
      textarea.removeEventListener(event, stopPropagation);
  };
}
