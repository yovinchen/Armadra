import {
  runtimeApi,
  type RuntimeSettings,
  type RuntimeSettingsPatch,
} from "../api/client";

/**
 * 设置网关。
 *
 * 曾经它要在两个写方之间选一侧——Rust Runtime 与 Go Host 是两个进程，同一份
 * 偏好文档有两处可写，于是每一次读写都得先问「现在归谁」。单一 core 之后没有
 * 第二个写者，这里就只剩一条路：`/api/settings`。
 *
 * 模块仍然存在，因为调用点的签名是它定的：进去一个 `RuntimeSettingsPatch`，
 * 出来一份 `RuntimeSettings`。
 */
export const settingsGateway = {
  /** `GET /api/settings`。 */
  load(): Promise<RuntimeSettings> {
    return runtimeApi.settings();
  },

  /** `PATCH /api/settings`：回的是合并之后的整份文档。 */
  patch(patch: RuntimeSettingsPatch): Promise<RuntimeSettings> {
    return runtimeApi.updateSettings(patch);
  },
};
