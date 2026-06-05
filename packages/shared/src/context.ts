import type { ContextItem } from "./api.js";

/**
 * Builds the prompt preamble handed to an ACP agent. Only metadata and
 * user-authored text is inlined — file contents are never injected here, the
 * agent reads them itself inside the authorized root.
 */
export function buildContextPrompt(items: ContextItem[]): string {
  const tasks = items.filter((item) => item.kind === "task");
  const paths = items.filter(
    (item) => item.kind === "file" || item.kind === "context",
  );
  const logs = items.filter((item) => item.kind === "log");
  const notes = items.filter((item) => item.kind === "note");
  const pages = items.filter((item) => item.kind === "browser");
  const texts = items.filter((item) => item.kind === "text");

  const sections = ["你正在处理当前已授权的本地项目。"];

  if (tasks.length > 0) {
    sections.push(
      `任务：\n${tasks.map((item) => `- ${item.value}`).join("\n")}`,
    );
  }

  if (paths.length > 0) {
    sections.push(
      `优先检查这些本地路径：\n${paths.map((item) => `- ${item.value}`).join("\n")}`,
    );
  }

  if (notes.length > 0) {
    sections.push(
      `笔记：\n${notes.map((item) => `- ${item.title}: ${item.value}`).join("\n")}`,
    );
  }

  if (pages.length > 0) {
    sections.push(
      `参考网页：\n${pages.map((item) => `- ${item.title}: ${item.value}`).join("\n")}`,
    );
  }

  if (logs.length > 0) {
    sections.push(
      `相关记录：\n${logs.map((item) => `- ${item.title}: ${item.value}`).join("\n")}`,
    );
  }

  if (texts.length > 0) {
    sections.push(
      `补充上下文：\n${texts.map((item) => `- ${item.title}: ${item.value}`).join("\n")}`,
    );
  }

  sections.push(
    "请先核对现状再修改；如需执行危险操作，请等待用户在真实终端中确认。",
  );

  return sections.join("\n\n");
}
