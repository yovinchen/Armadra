export * from "./gen/armadra/v1/common_pb.js";
export * from "./gen/armadra/v1/migration_pb.js";
export * from "./gen/armadra/v1/identity_pb.js";
export * from "./gen/armadra/v1/agent_pb.js";
export * from "./gen/armadra/v1/canvas_pb.js";
export * from "./gen/armadra/v1/filesystem_pb.js";
export * from "./gen/armadra/v1/git_pb.js";
export * from "./gen/armadra/v1/events_pb.js";
export * from "./gen/armadra/v1/ownership_pb.js";
export * from "./gen/armadra/v1/settings_pb.js";
export * from "./gen/armadra/v1/worker_pb.js";
export * from "./gen/armadra/v1/worker_channel_pb.js";
export * from "./gen/armadra/v1/automation_pb.js";
export * from "./gen/armadra/v1/command_pb.js";
export * from "./gen/armadra/v1/resources_pb.js";
export * from "./gen/armadra/v1/account_pb.js";
export * from "./gen/armadra/v1/presence_pb.js";
export * from "./gen/armadra/v1/browser_pb.js";
export * from "./gen/armadra/v1/github_pb.js";
export * from "./gen/armadra/v1/updates_pb.js";
export * from "./gen/armadra/v1/language_pb.js";
export { create, fromBinary, toBinary } from "@bufbuild/protobuf";

export const PROTOCOL_MAJOR = 1;
// Minor 2 adds the update artifact/request `component` field (design
// docs/design/updates-and-service-install.md §1.5); minors stay additive.
export const PROTOCOL_MINOR = 2;
export const MAX_FRAME_BYTES = 1_048_576;
