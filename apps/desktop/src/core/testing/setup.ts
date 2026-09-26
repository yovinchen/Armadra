import { afterAll } from "vitest";
import { removeTempDirs } from "./temp-dir";

// 每个测试文件跑完删掉它经 `tempDir()` 建的临时目录（见 temp-dir.ts）。
// setupFiles 里注册的 afterAll 最先注册、最后执行，排在文件自己的收尾之后：
// 服务器、数据库先关，目录后删。
afterAll(removeTempDirs);

// 测试起的 core 用的是开发者真实的 HOME：启动时的一次性迁移与 Codex 的信任
// 记录都会写进真实的 ~/.codex、~/.claude。用例要测它们就显式传临时目录与 env。
process.env.ARMADRA_NO_GLOBAL_WRITES = "1";
