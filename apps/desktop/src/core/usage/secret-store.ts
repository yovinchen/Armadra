/**
 * core 自己拿到的令牌存在哪儿。移植自 合并前的实现。
 *
 * 别的每个供应商模块都是**读**一个 CLI 已经写好的凭据。Copilot 这里没有 CLI，所以
 * 设备流把令牌交给我们、我们拥有它。用量模块的第一条规矩仍然适用：值被读进一个
 * 局部变量、用于一次请求、然后丢掉——它从不被日志、从不进 SQLite、也从不被序列化
 * 进一条 API 响应。只有 {@link SecretBackend}（它**在哪儿**）会到达设置页。
 *
 * macOS 走登录钥匙串（`security(1)`）。别的地方没有一个不引新依赖就能驱动的 OS
 * 存储，所以令牌去数据目录里一个 0600 文件，后端把自己报成 `file`——一次**降级**，
 * 设置页照实说。
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 一个 core 自己拥有的令牌在这台机器上存在哪儿。 */
export type SecretBackend = "keychain" | "file";

function security(
  args: readonly string[],
  input?: string,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "security",
      [...args],
      { timeout: 5_000, encoding: "utf8", maxBuffer: 1 << 20 },
      (error, stdout) => {
        resolve({
          ok: error === null,
          stdout: typeof stdout === "string" ? stdout : "",
        });
      },
    );
    child.stdin?.end(input ?? "");
  });
}

/**
 * `ARMADRA_SECRET_BACKEND=file` 强制降级。测试这么设，所以没有一条测试会写进开发者
 * 真正的登录钥匙串；不想被 `security(1)` 提示的人也可以这么设。
 */
function forcedFileBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ARMADRA_SECRET_BACKEND ?? "").toLowerCase() === "file";
}

/**
 * 一个具名的密钥。`service` 是钥匙串的 service 名，同时兼作文件名，所以两个后端
 * 永远不可能对「哪个令牌是哪个」有分歧。
 */
export class SecretStore {
  constructor(
    private readonly service: string,
    private readonly dataDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** 这个平台实际会用的后端。报给设置页，好让 Linux 用户知道令牌不在 OS 存储里。 */
  backend(): SecretBackend {
    return forcedFileBackend(this.env) || process.platform !== "darwin"
      ? "file"
      : "keychain";
  }

  file(): string {
    return join(this.dataDir, "secrets", `${this.service}.token`);
  }

  /** 存着的令牌，什么都没存（或者是空的）时是 `undefined`。 */
  async read(): Promise<string | undefined> {
    if (this.backend() === "keychain") {
      const result = await security([
        "find-generic-password",
        "-s",
        this.service,
        "-w",
      ]);
      if (result.ok) {
        const value = result.stdout.trim();
        if (value !== "") return value;
      }
    }
    return readTokenFile(this.file());
  }

  /**
   * 有没有令牌。刻意不返回值：`GET /api/usage/copilot` 只需要那个布尔。
   */
  async isSet(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }

  async write(value: string): Promise<void> {
    if (this.backend() === "keychain") {
      // `-U` 更新已有条目而不是在重复时报错。
      const result = await security([
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        this.service,
        "-w",
        value,
      ]);
      // `security` 不可用时落到 0600 文件，而不是丢掉这次登录。
      if (result.ok) return;
    }
    writeTokenFile(this.file(), value);
  }

  /**
   * 从每个后端里删掉这个令牌。登出不该在钥匙串那次写成功的情况下把文件里那份留下。
   */
  async clear(): Promise<void> {
    if (this.backend() === "keychain") {
      await security(["delete-generic-password", "-s", this.service]);
    }
    clearTokenFile(this.file());
  }
}

export function readTokenFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

export function writeTokenFile(path: string, value: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(directory)) chmodSync(directory, 0o700);
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 删一个不在的令牌是成功：登出两次不该冒出一个失败。 */
export function clearTokenFile(path: string): void {
  rmSync(path, { force: true });
}
