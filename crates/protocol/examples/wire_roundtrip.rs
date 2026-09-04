//! Small binary stdin/stdout bridge for cross-runtime handshake smoke tests.
use std::io::{Read, Write};

use armadra_protocol::{MAX_FRAME_BYTES, v1};
use prost::Message;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let kind = args
        .next()
        .ok_or("expected hello-request or hello-response")?;
    if args.next().is_some() || !matches!(kind.as_str(), "hello-request" | "hello-response") {
        return Err("expected exactly one argument: hello-request or hello-response".into());
    }
    let mut wire = Vec::new();
    std::io::stdin()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut wire)?;
    if wire.len() > MAX_FRAME_BYTES {
        return Err("input exceeds the 1 MiB control-frame limit".into());
    }
    let output = match kind.as_str() {
        "hello-request" => v1::HelloRequest::decode(wire.as_slice())?.encode_to_vec(),
        "hello-response" => v1::HelloResponse::decode(wire.as_slice())?.encode_to_vec(),
        _ => unreachable!(),
    };
    std::io::stdout().write_all(&output)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("wire roundtrip: {error}");
        std::process::exit(1);
    }
}
