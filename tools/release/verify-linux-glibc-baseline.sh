#!/usr/bin/env bash
# Asserts that the Linux release binaries need no GLIBC symbol version above the
# baseline the release promises.
#
# glibc's symbol versioning is one-way: a binary linked on Ubuntu 24.04
# (glibc 2.39) records GLIBC_2.38/2.39 references, and the dynamic linker on
# Ubuntu 22.04 (glibc 2.35) refuses to start it — "version `GLIBC_2.38' not
# found". Nothing in a successful build says this happened, so the only place it
# surfaces is a user's terminal. LiveAgent shipped exactly that regression
# (Stack-Cairn/LiveAgent#714) and fixed it by pinning the Linux release job to
# the ubuntu-22.04 runner and asserting the result here.
#
# The assertion matters as much as the runner: a build dependency that starts
# pulling in a newer glibc symbol would otherwise re-break it silently.
#
# Usage: verify-linux-glibc-baseline.sh [binary ...]
# Without arguments it inspects the release binaries `tauri build` and
# `prepare-sidecar` leave in target/release (and target/<triple>/release).
# Override the baseline with ARMADRA_GLIBC_BASELINE (default 2.35, the glibc of
# Ubuntu 22.04 LTS and Debian 12).
set -euo pipefail

readonly DEFAULT_BASELINE="2.35"
baseline="${ARMADRA_GLIBC_BASELINE:-$DEFAULT_BASELINE}"

fail() {
  echo "verify-linux-glibc-baseline: $*" >&2
  exit 1
}

# Returns 0 when version $1 is strictly greater than version $2.
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

for command_name in objdump grep sed sort awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

# Everything a Linux release ships as an executable. armadra-host is built with
# CGO_ENABLED=0 and so carries no GLIBC references at all; it is listed anyway
# because a future cgo dependency would make it carry them, and a binary that is
# checked and found clean costs one objdump.
readonly BINARY_NAMES=(
  "Armadra"
  "armadra-runtime"
  "armadra-hook"
  "armadra-host"
)

binaries=()
if [ "$#" -gt 0 ]; then
  binaries=("$@")
else
  release_dirs=("target/release")
  for triple in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
    release_dirs+=("target/$triple/release")
  done
  for directory in "${release_dirs[@]}"; do
    [ -d "$directory" ] || continue
    for name in "${BINARY_NAMES[@]}"; do
      # prepare-sidecar stages the sidecars under their triple, so both
      # spellings are inspected wherever they exist.
      for candidate in "$directory/$name" "$directory/$name"-*; do
        [ -f "$candidate" ] || continue
        case "$candidate" in
          *.d | *.sig | *.rlib) continue ;;
        esac
        binaries+=("$candidate")
      done
    done
  done
fi

[ "${#binaries[@]}" -gt 0 ] || fail "no Armadra release binary found to inspect (build it first or pass a path)"

status=0
for binary in "${binaries[@]}"; do
  test -f "$binary" || fail "binary not found: $binary"

  mapfile -t versions < <(
    objdump -T "$binary" 2>/dev/null |
      grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' |
      sed 's/^GLIBC_//' |
      sort -Vu
  )

  if [ "${#versions[@]}" -eq 0 ]; then
    # A static or CGO_ENABLED=0 binary lands here, and that is the best possible
    # answer: it needs no glibc at all.
    echo "==> $binary"
    echo "    ok    no GLIBC version symbols (statically linked)"
    continue
  fi

  echo "==> $binary"
  echo "    highest: GLIBC_${versions[-1]} (baseline GLIBC_$baseline)"

  offending=()
  for version in "${versions[@]}"; do
    version_gt "$version" "$baseline" && offending+=("$version")
  done

  if [ "${#offending[@]}" -gt 0 ]; then
    echo "    FAIL  requires GLIBC newer than the baseline: $(printf 'GLIBC_%s ' "${offending[@]}")" >&2
    for version in "${offending[@]}"; do
      echo "      symbols requiring GLIBC_$version:" >&2
      # objdump prints the version bare (GLIBC_2.38) or parenthesised.
      objdump -T "$binary" 2>/dev/null | awk -v token="GLIBC_$version" '
        { for (i = 1; i <= NF; i++) if ($i == token || $i == "(" token ")") { print "        " $0; break } }
      ' >&2 || true
    done
    status=1
  else
    echo "    ok    within baseline"
  fi
done

if [ "$status" -ne 0 ]; then
  fail "a Linux binary requires a newer GLIBC than the baseline (GLIBC_$baseline).
  Build the Linux release on that baseline — the ubuntu-22.04 / ubuntu-22.04-arm runners,
  or an ubuntu:22.04 container — so the artifacts start on Ubuntu 22.04+ and Debian 12+.
  See docs/guides/ci-release.md §2."
fi

echo "GLIBC baseline verified (<= GLIBC_$baseline) for ${#binaries[@]} binaries."
