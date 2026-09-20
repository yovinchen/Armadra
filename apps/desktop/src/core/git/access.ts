import { requireExecution, validOid } from "./support";

/**
 * Application-level Git execution policy, not an operating-system sandbox.
 *
 * A direct port of the pre-merge implementation. Worktree inspection may
 * invoke clean filters even for `status`, so without the workspace's execution
 * grant only built-in metadata / index / object reads are admitted, and every
 * admitted command additionally runs with fsmonitor, hooks, signature checks
 * and submodule diffing configured off.
 *
 * This is deliberately **not** a general-purpose safe-command evaluator: it
 * only ever sees argument lists built by the typed Git services in this
 * directory.
 */

const REFUSED_FLAGS = new Set([
  "--filters",
  "--textconv",
  "--ext-diff",
  "--show-signature",
  "--alternate-refs",
]);

export function gitArguments(
  args: readonly string[],
  allowHelpers: boolean,
): string[] {
  if (allowHelpers) return [...args];
  const verb = args[0] ?? "";
  const positional: string[] = [];
  for (const arg of args.slice(1)) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) positional.push(arg);
  }
  const immutableDiff =
    args.includes("--cached") ||
    (positional.length === 2 && positional.every((arg) => validOid(arg)));
  let allowed: boolean;
  switch (verb) {
    case "rev-parse":
    case "for-each-ref":
    case "rev-list":
    case "log":
    case "show":
    case "cat-file":
    case "check-ref-format":
    case "ls-files":
      allowed = true;
      break;
    case "symbolic-ref":
      allowed = positional.length === 1;
      break;
    case "remote":
      allowed = args.length === 1;
      break;
    case "stash":
      allowed = args[1] === "list";
      break;
    case "diff":
      allowed = immutableDiff;
      break;
    case "diff-tree":
      allowed = positional.length === 1 && validOid(positional[0] as string);
      break;
    default:
      allowed = false;
  }
  const beforeSeparator: string[] = [];
  for (const arg of args) {
    if (arg === "--") break;
    beforeSeparator.push(arg);
  }
  if (!allowed || beforeSeparator.some((arg) => REFUSED_FLAGS.has(arg))) {
    requireExecution(false, "This Git inspection");
  }
  const result = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "log.showSignature=false",
    "-c",
    "diff.submodule=short",
  ];
  if (verb === "stash") {
    result.push(
      "stash",
      "list",
      "--no-patch",
      "--no-ext-diff",
      "--no-textconv",
      ...args.slice(2),
    );
    return result;
  }
  result.push(verb);
  if (["diff", "diff-tree", "log", "show"].includes(verb)) {
    result.push("--no-ext-diff", "--no-textconv");
  }
  result.push(...args.slice(1));
  return result;
}

/**
 * The protocol allow-list overrides per-protocol configuration, including
 * arbitrary remote helpers, and lazy promisor fetches are refused outright.
 */
export function restrictedEnvironment(): Record<string, string | undefined> {
  return {
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_EXEC_PATH: undefined,
  };
}
