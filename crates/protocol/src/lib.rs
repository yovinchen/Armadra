//! Generated wire contracts. Prost drops unknown fields during decoding: forward
//! original binary frames when acting as a relay, never decode/re-encode them.

pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/armadra.v1.rs"));
}

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
