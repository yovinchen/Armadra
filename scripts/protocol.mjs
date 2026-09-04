import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (!["generate", "check", "test", "fixtures"].includes(mode)) {
  throw new Error(
    "usage: node scripts/protocol.mjs generate|check|test|fixtures",
  );
}
function run(command, args, cwd = root, options = {}) {
  return execFileSync(command, args, { cwd, stdio: "inherit", ...options });
}
function runPnpm(args) {
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? "")) {
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  }
  if (process.platform === "win32") {
    return run("pnpm.exe", args);
  }
  return run("pnpm", args);
}

if (mode === "test") {
  run("go", ["test", "./gen/..."], join(root, "apps/host"));
  run("cargo", ["test", "--locked", "-p", "armadra-protocol"]);
  runPnpm(["--filter", "@armadra/protocol", "test"]);
  runPnpm(["--filter", "@armadra/protocol", "typecheck"]);
} else if (mode === "fixtures") {
  // Fixtures come from the Go runtime, then independent Rust/TS tests decode
  // them and compare their own encoded bytes with the same golden files.
  run("go", ["test", "./gen/...", "-update-fixtures"], join(root, "apps/host"));
} else {
  const temp = mkdtempSync(join(tmpdir(), "armadra-protocol-"));
  try {
    const protoc = run(
      "cargo",
      [
        "run",
        "--locked",
        "--quiet",
        "-p",
        "armadra-protocol",
        "--example",
        "codegen",
        "--",
        join(temp, "rust"),
      ],
      root,
      { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
    ).trim();
    run(
      "go",
      ["install", "google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.6"],
      root,
      {
        env: { ...process.env, GOBIN: join(temp, "bin") },
      },
    );
    const goOut = join(temp, "go");
    const tsOut = join(temp, "ts");
    mkdirSync(goOut);
    mkdirSync(tsOut);
    const exe = process.platform === "win32" ? ".exe" : "";
    const tsPlugin = join(
      root,
      "packages/protocol-ts/node_modules/.bin",
      `protoc-gen-es${process.platform === "win32" ? ".cmd" : ""}`,
    );
    // Native protoc cannot CreateProcess a .cmd via an explicit --plugin path.
    // Its normal Windows plugin lookup uses the command interpreter instead.
    const esPluginArgs =
      process.platform === "win32"
        ? []
        : [`--plugin=protoc-gen-es=${tsPlugin}`];
    const pluginEnv = { ...process.env };
    const pathKey =
      Object.keys(pluginEnv).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    pluginEnv[pathKey] =
      `${dirname(tsPlugin)}${delimiter}${pluginEnv[pathKey] ?? ""}`;
    run(
      protoc,
      [
        "--proto_path=proto",
        `--plugin=protoc-gen-go=${join(temp, "bin", `protoc-gen-go${exe}`)}`,
        `--go_out=${goOut}`,
        "--go_opt=paths=source_relative",
        ...esPluginArgs,
        `--es_out=${tsOut}`,
        "--es_opt=target=ts,import_extension=js",
        "proto/armadra/v1/common.proto",
      ],
      root,
      { env: pluginEnv },
    );
    // Repository formatting is part of the reproducible generation pipeline.
    runPnpm([
      "exec",
      "prettier",
      "--write",
      join(tsOut, "armadra/v1/common_pb.ts"),
    ]);
    for (const [generated, target] of [
      [goOut, "apps/host/gen"],
      [tsOut, "packages/protocol-ts/src/gen"],
    ]) {
      for (const relative of readdirSync(generated, {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          join(entry.parentPath, entry.name).slice(generated.length + 1),
        )) {
        const from = join(generated, relative);
        const to = join(root, target, relative);
        if (mode === "generate") {
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
        } else if (!readFileSync(from).equals(readFileSync(to))) {
          throw new Error(`Generated protocol is stale: ${target}/${relative}`);
        }
      }
    }
    console.log(
      mode === "generate"
        ? "Protocol generated."
        : "Protocol generation matches checked-in files; Rust generated from the same schema.",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
