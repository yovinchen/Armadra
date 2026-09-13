//! Copies referenced managed assets into the package. Every path is validated
//! and opened without following symlinks, and a changed asset is never claimed.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use armadra_protocol::v1::*;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::{
    MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, References, WorkspaceRoots, check_manifest_size,
    files::{hash_reader, private_ancestors, private_file, sync_directory},
    invalid, issue,
};

pub(super) fn collect_assets(
    mut manifest: MigrationExportManifest,
    destination: &Path,
    workspaces: &WorkspaceRoots,
    references: References,
    include: bool,
) -> AppResult<MigrationExportManifest> {
    let mut total = 0;
    for ((workspace, relative), referenced_by) in references {
        let mut asset = ExportAsset {
            workspace_id: workspace.clone(),
            relative_path: relative.clone(),
            referenced_by: referenced_by.into_iter().collect(),
            ..Default::default()
        };
        // Hash the namespace rather than using an untrusted database ID as a
        // directory component. The original workspace identity stays in proto.
        let namespace = format!("{:x}", Sha256::digest(workspace.as_bytes()));
        let outcome = if !include {
            Err((
                "asset_copy_disabled",
                "Asset copying was explicitly disabled",
            ))
        } else if let Some(root) = workspaces.get(&workspace) {
            match managed_relative(&relative) {
                Some(path) => {
                    let bundle = PathBuf::from("assets").join(namespace).join(&path);
                    match copy_asset(
                        root,
                        &path,
                        &destination.join(&bundle),
                        MAX_TOTAL_ASSET_BYTES - total,
                    ) {
                        Ok((bytes, hash)) => {
                            asset.bundle_path = bundle.to_string_lossy().replace('\\', "/");
                            asset.bytes = bytes;
                            asset.sha256 = hash;
                            asset.copied = true;
                            total += bytes;
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                }
                None => Err((
                    "unsafe_asset_path",
                    "Managed asset reference contains an unsupported or escaping path",
                )),
            }
        } else {
            Err(("missing_workspace", "Asset references a missing workspace"))
        };
        if let Err((code, detail)) = outcome {
            manifest.assets_complete = false;
            issue(
                &mut manifest,
                code,
                "error",
                &format!("workspace/{workspace}/{relative}"),
                detail,
            );
        }
        manifest.assets.push(asset);
        check_manifest_size(&manifest)?;
    }
    Ok(manifest)
}

type AssetFailure = (&'static str, &'static str);

pub(super) fn managed_relative(raw: &str) -> Option<PathBuf> {
    if raw.contains('\\') || raw.chars().any(|c| c.is_control()) {
        return None;
    }
    let parts: Vec<_> = raw.split('/').collect();
    if parts.len() < 3
        || parts[0] != ".armadra"
        || !matches!(parts[1], "assets" | "exports" | "imports")
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || p.contains(':')
                || p.ends_with(['.', ' '])
                || windows_reserved_component(p)
        })
    {
        return None;
    }
    let path = PathBuf::from(raw);
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then_some(path)
}

fn windows_reserved_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

pub(super) fn copy_asset(
    root: &Path,
    relative: &Path,
    target: &Path,
    remaining: u64,
) -> Result<(u64, Vec<u8>), AssetFailure> {
    copy_asset_checked(root, relative, target, remaining, || {})
}

pub(super) fn copy_asset_checked(
    root: &Path,
    relative: &Path,
    target: &Path,
    remaining: u64,
    after_copy: impl FnOnce(),
) -> Result<(u64, Vec<u8>), AssetFailure> {
    if !root.is_absolute() {
        return Err((
            "unsafe_workspace_root",
            "Workspace root is not an absolute local path",
        ));
    }
    let mut source = open_managed(root, relative).map_err(asset_open_error)?;
    let before = source
        .metadata()
        .map_err(|_| ("asset_unreadable", "Asset metadata could not be read"))?;
    if !before.is_file() {
        return Err(("unsafe_asset_path", "Asset is not a regular file"));
    }
    if before.len() > MAX_ASSET_BYTES || before.len() > remaining {
        return Err((
            "asset_size_limit",
            "Asset exceeds the per-file or total package byte limit",
        ));
    }
    let mut created = false;
    let result = (|| -> AppResult<(u64, Vec<u8>)> {
        private_ancestors(
            target
                .parent()
                .ok_or_else(|| invalid("asset destination has no parent"))?,
        )?;
        let mut output = private_file(target)?;
        created = true;
        let mut hash = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0; 64 * 1024];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            bytes += read as u64;
            if bytes > MAX_ASSET_BYTES || bytes > remaining {
                return Err(invalid("asset grew beyond limit"));
            }
            output.write_all(&buffer[..read])?;
            hash.update(&buffer[..read]);
        }
        output.sync_all()?;
        after_copy();
        let after = source.metadata()?;
        if bytes != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err(invalid("asset changed during copy"));
        }
        let hash = hash.finalize().to_vec();
        source.seek(SeekFrom::Start(0))?;
        if hash_reader(&mut source, MAX_ASSET_BYTES)?.1 != hash {
            return Err(invalid("asset changed during copy"));
        }
        let mut current = open_managed(root, relative)?;
        if hash_reader(&mut current, MAX_ASSET_BYTES)? != (bytes, hash.clone()) {
            return Err(invalid("asset changed during copy"));
        }
        sync_directory(target.parent().unwrap())?;
        Ok((bytes, hash))
    })();
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            if created {
                let _ = fs::remove_file(target);
            }
            if matches!(&error, AppError::BadRequest(message) if message.ends_with("asset changed during copy"))
            {
                Err((
                    "asset_changed",
                    "Asset changed during copying; no completed asset is advertised",
                ))
            } else {
                Err((
                    "asset_copy_failed",
                    "Asset could not be copied durably; no completed asset is advertised",
                ))
            }
        }
    }
}

fn asset_open_error(error: std::io::Error) -> AssetFailure {
    if error.kind() == std::io::ErrorKind::NotFound {
        ("asset_missing", "Referenced managed asset does not exist")
    } else {
        (
            "asset_unreadable_or_unsafe",
            "Referenced managed asset could not be opened safely",
        )
    }
}

/// Unix walks from a held root descriptor and refuses symlinks at every asset
/// component. A concurrent ancestor rename cannot redirect reads outside root.
#[cfg(unix)]
fn open_managed(root: &Path, relative: &Path) -> std::io::Result<File> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(root)?;
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(std::io::ErrorKind::InvalidInput.into());
        };
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if index + 1 == components.len() {
                0
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: valid held parent fd and NUL-terminated single path component.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a new owned descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_managed(root: &Path, relative: &Path) -> std::io::Result<File> {
    // On Windows retain directory handles without FILE_SHARE_DELETE while
    // walking, and open reparse points themselves instead of following them.
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let root = crate::paths::canonicalize(root)?;
        let mut path = root;
        let mut parents = Vec::new();
        for component in std::iter::once(None).chain(relative.components().map(Some)) {
            if let Some(Component::Normal(name)) = component {
                path.push(name);
            } else if component.is_some() {
                return Err(std::io::ErrorKind::InvalidInput.into());
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(1 | 2)
                .custom_flags(0x02000000 | 0x00200000)
                .open(&path)?;
            if file.metadata()?.file_attributes() & 0x400 != 0 {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            parents.push(file);
        }
        parents
            .pop()
            .ok_or_else(|| std::io::ErrorKind::InvalidInput.into())
    }
    #[cfg(not(windows))]
    {
        let _ = (root, relative);
        Err(std::io::ErrorKind::Unsupported.into())
    }
}
