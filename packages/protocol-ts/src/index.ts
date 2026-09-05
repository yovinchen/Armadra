export * from "./gen/armadra/v1/common_pb.js";
export * from "./gen/armadra/v1/migration_pb.js";
export * from "./gen/armadra/v1/identity_pb.js";
export * from "./gen/armadra/v1/worker_pb.js";
export * from "./gen/armadra/v1/automation_pb.js";
export * from "./gen/armadra/v1/command_pb.js";
export { create, fromBinary, toBinary } from "@bufbuild/protobuf";

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 1;
export const MAX_FRAME_BYTES = 1_048_576;
