// Exposes the locked, vendored compiler to the Go/TS generation driver and
// materializes Rust output so the same verification command checks all targets.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).expect("output directory required");
    std::fs::create_dir_all(&out)?;
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    let mut schemas = std::fs::read_dir(root.join("armadra/v1"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    schemas.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "proto")
    });
    schemas.sort();
    prost_build::Config::new()
        .protoc_executable(&protoc)
        .out_dir(out)
        .compile_protos(&schemas, &[root])?;
    println!("{}", protoc.display());
    Ok(())
}
