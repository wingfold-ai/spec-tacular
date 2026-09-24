#!/bin/sh
# Build without a C toolchain.
#
# spec-tacular is pure Rust, but cargo still needs *a* linker, and on Linux
# rustc drives linking through `cc` by default. On a machine with no
# `cc`/`gcc` installed that fails before any of our code is reached.
#
# Two halves solve it:
#
#   1. The crate itself targets x86_64-unknown-linux-musl with `rust-lld` and
#      a self-contained sysroot — see .cargo/config.toml. That needs nothing
#      from the system at all, and yields a static binary.
#   2. Build scripts and proc-macro crates (clap/serde/thiserror/tokio derives)
#      are compiled for the *host* triple, which cargo will not let us
#      redirect. Their only configurable knob that survives `--target` is the
#      linker, so this script drops a small `rust-lld` wrapper in target/ that
#      supplies what a cc driver would have supplied — glibc's crt objects,
#      the library search paths, the dynamic loader — and points the host
#      target at it.
#
# Usage:  . scripts/no-cc.sh   (source it, then run cargo normally)
#
# If `cc` exists this is a no-op: the normal toolchain is better in every way.

if command -v cc >/dev/null 2>&1; then
  echo "no-cc.sh: cc found, nothing to do." >&2
else
  # Sourced, so $0 is the shell; ask cargo where the crate root is.
  _nocc_root=$(dirname "$(cargo locate-project --message-format plain 2>/dev/null)" 2>/dev/null)
  [ -d "$_nocc_root" ] || _nocc_root=$PWD
  _nocc_dir="$_nocc_root/target/no-cc"
  _nocc_sysroot=$(rustc --print sysroot)
  _nocc_host=$(rustc -vV | sed -n 's/^host: //p')
  _nocc_libdir=$(dirname "$(ls /usr/lib/*/Scrt1.o 2>/dev/null | head -1)")

  if [ ! -f "$_nocc_libdir/Scrt1.o" ]; then
    echo "no-cc.sh: no glibc crt objects found; install libc6-dev or a cc." >&2
  else
    mkdir -p "$_nocc_dir"
    # rustc emits a bare `-lgcc_s`, and a system without a compiler has only
    # the versioned runtime. A linker script bridges the two, as gcc's own
    # libgcc_s.so does.
    echo "INPUT($_nocc_libdir/libgcc_s.so.1)" > "$_nocc_dir/libgcc_s.so"

    # The wrapper must keep its name: rustc infers the lld command-line
    # flavor from the linker's filename.
    cat > "$_nocc_dir/rust-lld" <<INNER
#!/bin/sh
LLD="$_nocc_sysroot/lib/rustlib/$_nocc_host/bin/rust-lld"
G="$_nocc_libdir"
[ "\$1" = "-flavor" ] || exec "\$LLD" "\$@"
flavor="\$2"; shift 2
# A shared object has no _start and no interpreter; an executable needs both.
for a in "\$@"; do [ "\$a" = "-shared" ] && exec "\$LLD" -flavor "\$flavor" \\
  -L"\$G" -L"$_nocc_dir" "\$G/crti.o" "\$@" "\$G/crtn.o"; done
exec "\$LLD" -flavor "\$flavor" -L"\$G" -L"$_nocc_dir" \\
  -dynamic-linker=/lib64/ld-linux-x86-64.so.2 \\
  "\$G/Scrt1.o" "\$G/crti.o" "\$@" "\$G/crtn.o"
INNER
    chmod +x "$_nocc_dir/rust-lld"

    _nocc_var=$(echo "CARGO_TARGET_${_nocc_host}_LINKER" | tr 'a-z-' 'A-Z_')
    export "$_nocc_var=$_nocc_dir/rust-lld"
    echo "no-cc.sh: host linker -> $_nocc_dir/rust-lld" >&2
  fi
  unset _nocc_root _nocc_dir _nocc_sysroot _nocc_host _nocc_libdir _nocc_var
fi
