// Exposes the locked, vendored compiler to the Go/TS generation driver and
// materializes Rust output so the same verification command checks all targets.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).expect("output directory required");
    std::fs::create_dir_all(&out)?;
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    prost_build::Config::new()
        .protoc_executable(&protoc)
        .out_dir(out)
        .compile_protos(&[root.join("armadra/v1/common.proto")], &[root])?;
    println!("{}", protoc.display());
    Ok(())
}
