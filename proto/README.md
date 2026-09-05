# 跨端协议

`armadra/v1/*.proto` 是 Go / Rust / TypeScript 消息的唯一来源。
当前 major 1 / minor 1；Host 公开的匿名入口仍仅 Hello，`automation.proto` 与 `github.proto` 的方法走已认证 HTTPS 会话。
会话、Scope 与终端流契约不代表对应执行能力已完成；`automation.plans.v1` 只在 Host 真的配置了执行 Worker 时出现，
`github.issues.v1` 只在装配了凭据服务时出现。
`resources.proto` 是资源采样的跨端契约（Read / Subscribe、`SessionMetrics`、`HostMetrics`、平台组件）：
当前 Runtime 与 Web 之间仍走既有的 camelCase JSON 与工作空间事件流，Worker 协议尚未接线，两侧字段语义保持一一对应。

`github.proto` 的消息与枚举名拼作 `Github` 而不是 `GitHub`：prost 与 protobuf-es 只在枚举名转成
大写蛇形后与值前缀匹配时才裁剪前缀，否则每个运行时都会得到 `GithubIssueState::GithubIssueStateOpen`
这样的名字。该 schema 里唯一可能携带密文的字段是 `ConfigureGithubCredentialRequest.token`，只入不出。

minor 1 的 hostId 是数据目录持久身份，hostInstanceId 每次启动变化，均不是认证 token。
minor 0 可协商且允许缺 hostId。传输控制帧上限 1 MiB，由宿主实施；编解码器不负责认证或授权。

`canvas.proto` 是工作空间与画布的业务契约（H01 / C02）：类型化的 Workspace / Canvas / Node / Edge / Annotation /
资产引用、按 revision CAS 的保存与幂等收据、带 durable sequence 的事件信封与快照请求，以及
`CanvasOwnership`——声明「当前谁能写画布」的单行记录。白板快照不展开成字段，按
`schemaVersion + engineVersion + bytes + digest` 原样传输；未设置的 `size` / `collapsed` / `expandedHeight`
与显式的 0 在线上是不同字节。`worker.proto` 因此新增 `SetWriteOwnership` / `GetWriteOwnership`：
epoch 经既有 Worker stdio 私有管道下发，不新增任何 HTTP 能力。

`presence.proto`（H04）与 `account.proto`（S02）是预留契约：消息可编解码，Host 对
`armadra.v1.PresenceService/*` 与 `armadra.v1.AccountService/*` 一律返回 `UNSUPPORTED` 及原因，
并在 Hello 的 `capabilityStatus` 里显式列出 `presence` / `accountBinding` 为 unsupported。
`capabilityStatus` 为空不等于支持；`capabilities` 只列真正可用的能力。
`CredentialBinding` 只有 `credentialRef`，密钥留在执行主机的凭据存储里，不进协议。

## 生成与检查

需要 Node ≥ 22、项目锁定的 pnpm、Rust Cargo、Go ≥ 1.24；无需系统 protoc，首次生成需下载锁定依赖。

```sh
pnpm install --frozen-lockfile
pnpm protocol:generate
pnpm protocol:check
pnpm protocol:test
```

- generate 生成 Go / TS，TS 用锁定 Prettier 格式化；Rust 在 build.rs 生成到 OUT_DIR。
- check 在临时目录重新生成并逐字节比较，不改仓库。
- test 运行三语言契约测试与 TS 类型检查，不启动业务 Host / Worker。
- `node tools/protocol.mjs fixtures` 重建共享十六进制样例，仅在有意变更契约时运行并审查 diff。

| 工具                        | 锁定版本             | 输出                                    |
| --------------------------- | -------------------- | --------------------------------------- |
| protoc-bin-vendored         | 3.2.0（protoc 31.1） | 共用编译器                              |
| protoc-gen-go / Go protobuf | 1.36.6               | `apps/host/gen/armadra/v1/`             |
| protoc-gen-es / protobuf-es | 2.2.5                | `packages/protocol/src/gen/armadra/v1/` |
| prost / prost-build         | 0.14.1               | `armadra_protocol::v1`                  |

提交相应 Cargo.lock、pnpm-lock.yaml 和 go.sum；生成文件不手改。

## 使用与兼容

Go 使用 `proto.Marshal/Unmarshal`，Rust 使用 `prost::Message`，TS 从 `@armadra/protocol` 导入 schema 和 `create/toBinary/fromBinary`。
TS 的 64 位整数必须用 bigint，禁止经 Number 或普通 JSON 往返序号、generation、revision、时间戳。

字段号不可复用，删除时 reserved；新功能增加字段与 capability。区分未传/零值用 optional，清空使用明确操作。
Go 与 protobuf-es 保留未知字段，prost 接受但丢弃；Rust 若作透明中继必须转发原始 bytes，当前尚无透明 Worker 中继实现。

本机管理契约仅走受 OS 保护的 IPC，不增加 HTTP 能力；4 字节大端长度前缀及细则见[控制协议](../apps/host/internal/daemon/README.md)。
CLI `--output protobuf` 返回单个无换行的 HostManagementResult；stopped 表示已完成停止，不能用接受请求的 ACK 替代。
终端流 ACK 仅表示接收进度。

共享样例覆盖 Unicode、二进制、整数边界、optional、oneof、未知字段和截断拒绝，
以及自动化的未知 outcome、投递证据、命令会话不可重建状态与超出 JS 安全整数的 revision，
和资源采样中「测得的 0」与「测不出来」必须编码成不同字节这一条。
验证证据见[实施记录](../docs/platform-implementation-status.md)；交叉构建不代表目标平台实机通过。

参考：[Go 生成代码](https://protobuf.dev/reference/go/go-generated/)、[Protobuf-ES](https://github.com/bufbuild/protobuf-es/blob/v2.2.5/MANUAL.md)、
[prost-build](https://docs.rs/prost-build/0.14.1/prost_build/struct.Config.html)、[proto3 兼容规则](https://protobuf.dev/programming-guides/proto3/)。
