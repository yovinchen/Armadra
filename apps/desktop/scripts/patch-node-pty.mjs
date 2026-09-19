#!/usr/bin/env node
/**
 * Patches `node-pty` before it is compiled.
 *
 * node-pty is the only mature PTY binding for Node, and the TypeScript core's
 * terminal domain has no second option (design `typescript-core.md` §3, PTY
 * row). What it ships with are two defects that this repository cannot live
 * with, so the dependency is patched in place, from source, every time it is
 * built. The patch is:
 *
 *   * **pinned** — it refuses to run against any version but the one whose
 *     source was read line by line, and additionally checks the SHA-256 of the
 *     file it edits, because a patch release can change a file without changing
 *     the semver;
 *   * **anchor-based** — every edit is an exact-string replacement of text that
 *     was read out of the shipped source, and a missing anchor is a non-zero
 *     exit rather than a silent no-op;
 *   * **idempotent** — a second run sees its own marker and stops.
 *
 * ## Defect 1 (macOS): every `PtyFork` leaks ptmx devices
 *
 * `src/unix/pty.cc`, `pty_posix_spawn`, is the whole macOS spawn path. Measured
 * against node-pty 1.1.0's own source:
 *
 * ```c
 *   for (; count < 3; count++) {
 *     low_fds[count] = posix_openpt(O_RDWR);
 *     if (low_fds[count] >= STDERR_FILENO) break;
 *   }
 *   ...
 *   for (; count > 0; count--) close(low_fds[count]);
 * ```
 *
 * The producing loop `break`s *without* incrementing, so the entries it wrote
 * are `low_fds[0] … low_fds[count]` inclusive. The consuming loop runs from
 * `count` down to `1`: it never closes `low_fds[0]`, and when the producing
 * loop ran to completion (`count == 3`) its first iteration reads
 * `low_fds[3]`, one past the end of a three-element array, and closes whatever
 * integer was on the stack there.
 *
 * In any normally-started process fds 0/1/2 are already taken, so the very
 * first `posix_openpt` returns an fd ≥ 3, the loop breaks with `count == 0`,
 * and the close loop's body never executes at all. **One `/dev/ptmx` device
 * per successful spawn, leaked, unconditionally.**
 *
 * The same function also never closes `slave` in the parent. The child gets it
 * through `posix_spawn_file_actions_adddup2`/`addclose`, so the parent's copy
 * has no reader and no writer — it only keeps the pty pair allocated for the
 * lifetime of the process. That is the **second** device per spawn.
 *
 * And every early `return` between `*master = posix_openpt(O_RDWR)` and the
 * `posix_spawn` — `grantpt`/`unlockpt`, `TIOCPTYGNAME`, `open(slave)`,
 * `tcsetattr`, `TIOCSWINSZ` — returns with `*master` (and, past the fourth,
 * `slave`) still open and `*err` still at the caller's `-1`. A *failing* spawn
 * therefore leaks a master, sometimes a slave, and all of the low fds, while
 * the JavaScript side sees `posix_spawnp failed.` and retries.
 *
 * macOS caps the number of allocated pty devices at `kern.tty.ptmx_max`
 * (default 511). A leak of two devices per terminal is invisible for an hour
 * and terminal on a machine that opens and closes agent sessions all day:
 * once the cap is hit *every* spawn on the machine fails, including ones that
 * have nothing to do with this application, until the process exits.
 *
 * The fix replaces the whole tail of `pty_posix_spawn` with one `fail:` label
 * that closes `*master` and `slave`, and a cleanup that closes
 * `low_fds[0 … count]` inclusive, guarded against both the `-1` of a failed
 * `posix_openpt` and the out-of-range index.
 *
 * ## Defect 2 (Windows): the ConPTY release race
 *
 * `src/win/conpty.cc` frees the baton from the native exit thread before the
 * HPCON is closed, so a process tree killed from outside (`taskkill /T`) can
 * leave a `conhost.exe` alive until the whole daemon exits. It is not patched
 * here: this batch is macOS/Linux only (tmux), nothing in it ever reaches the
 * Windows backend, and a patch nobody can run is a patch nobody can verify.
 * TODO(R6): fix it together with the Windows session host, which is the first
 * code that actually opens a ConPTY, and which is also the first chance anyone
 * has to run it on real hardware.
 *
 * ## Linux
 *
 * The Linux path is `forkpty(3)` (`#else` branch of `PtyFork`) and does not go
 * through `pty_posix_spawn` at all, so neither edit applies to it. The patch is
 * a no-op there by construction — the anchors live inside `#if
 * defined(__APPLE__)`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = resolve(here, "../node_modules/node-pty");

/** The only version whose source this patch was written against. */
export const PINNED_VERSION = "1.1.0";

/**
 * SHA-256 of the pristine `src/unix/pty.cc` of that version. A semver-equal
 * file with a different hash is a file this patch has not read.
 */
export const PINNED_UNIX_SHA256 =
  "5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6";

/** Present in a patched file; its absence is what makes a re-run do work. */
export const MARKER = "/* armadra: pty device leak fix */";

/**
 * The tail of `pty_posix_spawn`, verbatim from node-pty 1.1.0. Anchored on the
 * `posix_spawn` retry loop so the replacement covers `done:` and the broken
 * close loop in one edit.
 */
const UNIX_ANCHOR = `  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}`;

const UNIX_REPLACEMENT = `  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);
  ${MARKER}
  // The child has its own dup'd copies of the slave and never sees the
  // master. The parent's slave fd keeps the pair allocated for nothing, so it
  // goes here, on the success path as well as on every failure below.
  if (slave != -1) {
    close(slave);
    slave = -1;
  }
  if (*err != 0 && *master != -1) {
    close(*master);
    *master = -1;
  }
  goto cleanup;

fail:
  // Everything between posix_openpt() and posix_spawn() used to return
  // straight out of the function with these two still open.
  if (slave != -1) {
    close(slave);
    slave = -1;
  }
  if (*master != -1) {
    close(*master);
    *master = -1;
  }

cleanup:
  // low_fds[0 .. count] INCLUSIVE: the producing loop breaks without
  // incrementing, so entry 0 always holds a device and entry \`count\` only
  // exists when that loop broke. The original ran from \`count\` down to 1,
  // which skipped entry 0 on every call and read one past the array when the
  // loop had run to completion.
  for (size_t index = 0; index <= count && index < 3; index++) {
    if (low_fds[index] != -1) {
      close(low_fds[index]);
    }
  }
}`;

/**
 * The early returns, each replaced by a jump to the new `fail:` label.
 *
 * C++ forbids a `goto` that jumps over the initialisation of a variable still
 * in scope at the label, so `slave` and `res` — the only two declarations
 * between the first jump site and the end of the function that carry an
 * initialiser — are hoisted to the top in their own edits. `slave_pty_name`,
 * `acts`, `attrs` and `signal_set` have no initialiser and may be crossed.
 */
const UNIX_EDITS = [
  // `slave` and `res` must exist, and hold a known value, at every `goto fail`.
  {
    name: "hoist the fds and the result code above every jump site",
    from: `  int low_fds[3];
  size_t count = 0;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }`,
    to: `  int low_fds[3] = { -1, -1, -1 };
  size_t count = 0;
  int slave = -1;
  int res = -1;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }`,
  },
  {
    name: "posix_openpt failure closes the low fds",
    from: `  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    return;
  }`,
    to: `  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    goto fail;
  }`,
  },
  {
    name: "grantpt / unlockpt failure closes the master",
    from: `  int res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    return;
  }`,
    to: `  res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    goto fail;
  }`,
  },
  {
    name: "TIOCPTYGNAME failure closes the master",
    from: `  int slave;
  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    return;
  }`,
    to: `  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    goto fail;
  }`,
  },
  {
    name: "open(slave) failure closes the master",
    from: `  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    return;
  }`,
    to: `  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    goto fail;
  }`,
  },
  {
    name: "tcsetattr failure closes both ends",
    from: `    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      return;
    };`,
    to: `    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      goto fail;
    };`,
  },
  {
    name: "TIOCSWINSZ failure closes both ends",
    from: `    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      return;
    }`,
    to: `    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      goto fail;
    }`,
  },
  {
    name: "close the parent's fds on every exit from pty_posix_spawn",
    from: UNIX_ANCHOR,
    to: UNIX_REPLACEMENT,
  },
];

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Applies every edit to `source`, refusing on the first anchor that is not
 * present exactly once. Returns the patched text.
 */
export function patchUnixSource(source, edits = UNIX_EDITS) {
  let text = source;
  for (const edit of edits) {
    const occurrences = text.split(edit.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `anchor "${edit.name}" matched ${occurrences} times, expected exactly 1`,
      );
    }
    text = text.replace(edit.from, edit.to);
  }
  return text;
}

export function alreadyPatched(source) {
  return source.includes(MARKER);
}

export function run({
  root = moduleDir,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  if (manifest.version !== PINNED_VERSION) {
    throw new Error(
      `node-pty ${manifest.version} is installed, but this patch was written against ${PINNED_VERSION}. ` +
        `Read the new source, re-derive the anchors, and move the pin — do not widen it.`,
    );
  }

  const file = join(root, "src/unix/pty.cc");
  const source = readFileSync(file, "utf8");
  if (alreadyPatched(source)) {
    log("node-pty is already patched");
    return { changed: false };
  }

  const digest = sha256(source);
  if (digest !== PINNED_UNIX_SHA256) {
    throw new Error(
      `src/unix/pty.cc hashes ${digest}, expected ${PINNED_UNIX_SHA256}. ` +
        `The file changed without the version changing; re-read it before patching.`,
    );
  }

  writeFileSync(file, patchUnixSource(source), "utf8");
  log("patched node-pty: pty device leaks in pty_posix_spawn (macOS)");
  return { changed: true };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`patch-node-pty: ${error.message}\n`);
    process.exit(1);
  }
}
