export * from "./gen/armadra/v1/common_pb.js";
export { create, fromBinary, toBinary } from "@bufbuild/protobuf";

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const MAX_FRAME_BYTES = 1_048_576;
