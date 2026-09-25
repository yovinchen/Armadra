import { afterAll } from "vitest";
import { removeTempDirs } from "./temp-dir";

// 每个测试文件跑完删掉它经 `tempDir()` 建的临时目录（见 temp-dir.ts）。
// setupFiles 里注册的 afterAll 最先注册、最后执行，排在文件自己的收尾之后：
// 服务器、数据库先关，目录后删。
afterAll(removeTempDirs);
