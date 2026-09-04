# 跨端协议基础

M0 的唯一业务入口是 Hello 握手。`Scope`、`CommandMeta`、会话地址和终端流消息只是后续执行接口的契约，不代表已支持远程终端、调度或多人协作。运行时应只公布已实现的能力。

`armadra/v1/common.proto` 是 Go、Rust、TypeScript 的共同消息来源。协议当前为 major 1 / minor 1，控制帧上限 1 MiB；Host 在读取 HTTP/流数据时实施上限，消息编解码器本身不负责认证、授权、大小限制或版本协商。流里的 ACK 表示接收进度，不表示命令已完成。

minor 1 为 HelloResponse 增加 `host_id = 5`，表示数据目录的持久身份；`host_instance_id` 仍为每次启动变化的进程标识。两者都不是认证 token。minor 0 客户端仍可协商，旧消息的 hostId 默认为空；共享样例同时覆盖新旧消息。

## 生成与验证

在仓库根执行：

```sh
pnpm install --frozen-lockfile
pnpm protocol:generate
pnpm protocol:check
pnpm protocol:test
```

- `protocol:generate` 使用锁定的编译器和插件生成 Go / TS 文件。
- `protocol:check` 在临时目录重新生成并逐字节比较 Go / TS 文件，发现漂移即失败，不修改仓库。Rust 由 `build.rs` 在编译时从同一份 schema 生成到 `OUT_DIR`，不维护第二套手写定义。
- `protocol:test` 运行 Go / Rust / TS 共享契约测试以及 TS 类型检查，不启动业务 Host 或 Worker。
- `node scripts/protocol.mjs fixtures` 使用 Go Protobuf 运行时重建共享十六进制样例；仅在有意变更契约时执行并审查差异。

首次生成需要网络下载依赖；安装后使用本地缓存。需要 Node >=22、项目声明的 pnpm、Rust Cargo、Go >=1.24。没有依赖系统安装的 `protoc`。

| 组件                        | 锁定版本                | 输出                                                   |
| --------------------------- | ----------------------- | ------------------------------------------------------ |
| protoc-bin-vendored         | 3.2.0，附带 protoc 31.1 | 三语言共用的编译器                                     |
| protoc-gen-go / Go protobuf | 1.36.6                  | `apps/host/gen/armadra/v1/common.pb.go`                |
| protoc-gen-es / protobuf-es | 2.2.5                   | `packages/protocol-ts/src/gen/armadra/v1/common_pb.ts` |
| prost / prost-build         | 0.14.1                  | `armadra-protocol::v1`，编译时生成                     |

Cargo.lock、pnpm-lock.yaml 和 go.sum 一并提交。TS 产物还经过仓库固定版本的 Prettier 格式化，避免生成后格式检查发生漂移。验证命令在 macOS 上实测；Windows / Linux 的生成器启动与实际宿主行为仍需对应平台验证。

## 使用方式

Go 导入 `armadra.local/host/gen/armadra/v1`，使用官方 `proto.Marshal` / `proto.Unmarshal`。Rust 导入 `armadra_protocol::v1`，使用 `prost::Message` 的 `encode_to_vec` / `decode`。TS 从 `@armadra/protocol` 导入消息 schema 和 `create` / `toBinary` / `fromBinary`。

TS 所有 64 位整数字段使用 `bigint`。禁止通过 `Number()` 转换序号、generation、revision 或时间戳后再发回，也不要用普通 JSON 序列化绕过二进制协议。

## 兼容边界

本机控制增加 `HostControlRequest/Response`、`HostStatus` 和实例绑定的停止请求。它们只用于操作系统保护的 IPC，不增加 HTTP 可调用能力。控制帧使用 4 字节大端长度前缀；CLI 展示可以输出 JSON，进程间传输仍为 Protobuf。控制通道的大小、深度及错误规则见 [控制协议说明](../apps/host/internal/daemon/README.md)。

共享样例覆盖中文及 emoji、二进制载荷、uint64 最大值、超过 JS 安全整数范围的 generation、int64 最小值、optional 未传与零值、三个 oneof 分支和最后一个分支生效的规则。三个运行时独立编码后与同一份样例比较，并测试截断数据拒绝行为。当前 schema 没有枚举，未知枚举的验收留待引入首个枚举时补充。

未知字段行为已通过测试确认：

- Go 和 protobuf-es 默认保留未知字段，二进制解码/编码可保留未来字段。
- prost 会接受但丢弃未知字段。Rust 若作为透明中继，必须转发原始二进制消息；不能解码再重新编码。当前没有实现透明 Worker 中继，也不声称已经提供这一兼容桥。

已有字段号不可复用。删除字段时声明 `reserved`，新功能增加字段和显式 capability。需要区分未传和零值时使用 optional；需要清空语义时增加明确操作，不用默认值隐式覆盖。

实现依据：[Go 生成代码指南](https://protobuf.dev/reference/go/go-generated/)、[Protobuf-ES 手册](https://github.com/bufbuild/protobuf-es/blob/v2.2.5/MANUAL.md)、[prost-build 配置](https://docs.rs/prost-build/0.14.1/prost_build/struct.Config.html)、[锁定编译器接口](https://docs.rs/protoc-bin-vendored/3.2.0/protoc_bin_vendored/)、[proto3 兼容规则](https://protobuf.dev/programming-guides/proto3/)。
