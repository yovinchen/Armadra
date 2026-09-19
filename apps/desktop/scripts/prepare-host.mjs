import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostBuildPlan, selectTarget } from "./sidecar-targets.mjs";

export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function parseArguments(args) {
  const options = { release: false, native: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--release") options.release = true;
    else if (argument === "--native") options.native = true;
    else if (
      argument === "--target" &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    )
      options.target = args[++index];
    else
      throw new Error(
        `Unknown or incomplete prepare:host argument: ${argument}`,
      );
  }
  if (options.native && options.target)
    throw new Error("--native and --target cannot be combined");
  return options;
}

export function rustHost() {
  return execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host:\s*(.+)$/m,
  )?.[1];
}

export function prepareHost({
  target,
  release = false,
  env = process.env,
  root = repository,
}) {
  const plan = hostBuildPlan({ repository: root, target, release, env });
  mkdirSync(dirname(plan.source), { recursive: true });
  for (const directory of [
    plan.env.GOPATH,
    plan.env.GOMODCACHE,
    plan.env.GOCACHE,
  ])
    mkdirSync(directory, { recursive: true });
  execFileSync(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit",
  });
  console.log(`Prepared Go Host: ${plan.source}`);
  return plan;
}

export function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const target = selectTarget({
    host: rustHost(),
    env: process.env,
    ...options,
  });
  return prepareHost({ target, release: options.release });
}

// Imports from node:test are side-effect free: no subprocesses or builds.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
