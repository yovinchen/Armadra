//! Generated wire contracts. Prost drops unknown fields during decoding: forward
//! original binary frames when acting as a relay, never decode/re-encode them.

pub mod v1 {
    // Generated oneofs carry whole messages by value. Boxing the big ones
    // would change this crate's Rust surface without moving a single wire
    // byte, and the schema is the thing that has to stay stable.
    #![allow(clippy::large_enum_variant)]

    include!(concat!(env!("OUT_DIR"), "/armadra.v1.rs"));
}

pub use prost::Message;

pub const PROTOCOL_MAJOR: u32 = 1;
// Minor 2 adds the update artifact/request `component` field (design
// docs/design/updates-and-service-install.md §1.5); minors stay additive.
pub const PROTOCOL_MINOR: u32 = 2;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
