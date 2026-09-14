#!/usr/bin/env bash
# Removes the Wayland client libraries Tauri's AppImage bundler copies into the
# image, and repacks it.
#
# linuxdeploy pulls libwayland-client/cursor/egl in with the GTK stack. A
# Wayland client library is not self-contained: it talks to the compositor the
# *host* is running, and it loads the host's own EGL and libdecor modules. An
# image that carries its own copy therefore mixes two versions of the same
# protocol implementation, and the app opens a blank window or dies in
# `wl_display_connect` on exactly the machines the AppImage exists to serve.
# Deleting the bundled copies makes the image use the host's, which is what
# every other GTK application on that machine does. LiveAgent ships this.
#
# The repack invalidates Tauri's detached signature, so the caller re-signs
# (`tauri signer sign`) afterwards; this script deletes the stale `.sig` rather
# than leaving one that no longer matches the bytes.
#
# If Tauri ever stops bundling those libraries this becomes a no-op and says so,
# and the workflow step can be deleted.
#
# Usage: postprocess-linux-appimage.sh <appimage-path>
# APPIMAGETOOL_PATH overrides the packer; otherwise a pinned appimagetool
# release is fetched for this architecture and checked against its digest.
# (Tauri 2.11 caches linuxdeploy-plugin-appimage, not a standalone
# appimagetool, so there is nothing of Tauri's to reuse here.)
set -euo pipefail

readonly APPIMAGETOOL_VERSION="1.9.1"
# One digest per build of the same release; both verified on 2026-09-14.
readonly APPIMAGETOOL_SHA256_X86_64="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
readonly APPIMAGETOOL_SHA256_AARCH64="f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158"

fail() {
  echo "postprocess-linux-appimage: $*" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <appimage-path>" >&2
  exit 2
fi

for command_name in curl find grep head realpath sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

appimage_path="$(realpath "$1")"
test -f "$appimage_path" || fail "AppImage not found: $appimage_path"
test -x "$appimage_path" || fail "AppImage is not executable: $appimage_path"

appimage_dir="$(dirname "$appimage_path")"
work_dir="$(mktemp -d "$appimage_dir/.armadra-appimage.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT

extract_dir="$work_dir/extract"
mkdir -p "$extract_dir"
(cd "$extract_dir" && "$appimage_path" --appimage-extract >/dev/null)

app_dir="$extract_dir/squashfs-root"
test -x "$app_dir/AppRun" || fail "extracted AppImage is missing an executable AppRun"

mapfile -d '' bundled_wayland_libraries < <(
  find "$app_dir/usr/lib" \( -type f -o -type l \) -name 'libwayland-*.so*' -print0 2>/dev/null || true
)
if [ "${#bundled_wayland_libraries[@]}" -eq 0 ]; then
  # Not a failure: it is the outcome this script wants. Say it plainly so the
  # next person can check whether the step is still earning its minute.
  echo "No bundled libwayland libraries in $appimage_path — nothing to strip."
  echo "If this keeps happening, Tauri no longer bundles them and this step can go."
  exit 0
fi

echo "Removing bundled Wayland libraries:"
for library_path in "${bundled_wayland_libraries[@]}"; do
  echo "  ${library_path#"$app_dir"/}"
done
rm -f -- "${bundled_wayland_libraries[@]}"

runtime_offset="$("$appimage_path" --appimage-offset)"
case "$runtime_offset" in
  '' | *[!0-9]*) fail "invalid AppImage runtime offset: $runtime_offset" ;;
esac
[ "$runtime_offset" -gt 0 ] || fail "invalid AppImage runtime offset: $runtime_offset"
# Reusing the original image's own runtime keeps the repacked image byte-for-byte
# the same kind of AppImage, rather than whichever runtime appimagetool prefers.
runtime_path="$work_dir/appimage-runtime"
head -c "$runtime_offset" "$appimage_path" >"$runtime_path"

architecture="$(uname -m)"
if [ -n "${APPIMAGETOOL_PATH:-}" ]; then
  appimagetool_path="$(realpath "$APPIMAGETOOL_PATH")"
  test -x "$appimagetool_path" || fail "APPIMAGETOOL_PATH is not executable: $appimagetool_path"
else
  case "$architecture" in
    x86_64) expected_sha256="$APPIMAGETOOL_SHA256_X86_64" ;;
    aarch64) expected_sha256="$APPIMAGETOOL_SHA256_AARCH64" ;;
    *) fail "no pinned appimagetool for $architecture: set APPIMAGETOOL_PATH" ;;
  esac
  appimagetool_path="$work_dir/appimagetool-$architecture.AppImage"
  curl --fail --location --retry 3 --silent --show-error \
    --output "$appimagetool_path" \
    "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-${architecture}.AppImage"
  echo "$expected_sha256  $appimagetool_path" | sha256sum --check --status ||
    fail "appimagetool checksum verification failed for $architecture"
  chmod +x "$appimagetool_path"
fi

repacked_path="$work_dir/repacked.AppImage"
ARCH="$architecture" APPIMAGE_EXTRACT_AND_RUN=1 "$appimagetool_path" \
  --no-appstream \
  --runtime-file "$runtime_path" \
  "$app_dir" "$repacked_path"
test -s "$repacked_path" || fail "appimagetool did not produce an AppImage"
chmod --reference="$appimage_path" "$repacked_path"

# Extract the result and check it, because a repack that quietly produced an
# image without an AppRun is a release that installs and does nothing.
verify_dir="$work_dir/verify"
mkdir -p "$verify_dir"
(cd "$verify_dir" && "$repacked_path" --appimage-extract >/dev/null)
test -x "$verify_dir/squashfs-root/AppRun" || fail "repacked AppImage is missing an executable AppRun"
if find "$verify_dir/squashfs-root/usr/lib" \( -type f -o -type l \) \
  -name 'libwayland-*.so*' -print -quit 2>/dev/null | grep -q .; then
  fail "repacked AppImage still contains bundled libwayland libraries"
fi

mv -f -- "$repacked_path" "$appimage_path"
# The bytes changed, so the signature beside them is now a lie. Deleting it
# makes the missing signature the caller's problem now rather than a client's
# later; the release job re-signs immediately after.
rm -f -- "$appimage_path.sig"
echo "Repacked AppImage without bundled Wayland libraries: $appimage_path"
