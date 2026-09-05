fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::path::Path::new("../../proto/armadra/v1");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut schemas = std::fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    schemas.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "proto")
    });
    schemas.sort();
    prost_build::Config::new()
        .protoc_executable(protoc_bin_vendored::protoc_bin_path()?)
        .compile_protos(&schemas, &["../../proto"])?;
    Ok(())
}
