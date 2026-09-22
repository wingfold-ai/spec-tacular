//! End-to-end checks on the built binary.
//!
//! These run `spectacular` as a process rather than calling into the crate, so
//! what is asserted is the thing a user actually gets: the help text, the exit
//! codes, and the messages on stderr. Stage 1 has no behaviour beyond those,
//! and they are exactly the part that must not regress while the rest is
//! ported.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};

const BIN: &str = env!("CARGO_BIN_EXE_spectacular");

/// A scratch directory that cleans up after itself, so the suite needs no
/// dependency for something this small.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("spectacular-test-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .output()
        .expect("run spectacular")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn help_mentions_every_subcommand() {
    let out = run(&["--help"]);
    assert!(out.status.success(), "--help should exit 0");
    let help = stdout(&out);

    for name in [
        "init",
        "instructions",
        "run",
        "jobs",
        "foundation",
        "adr",
        "archive",
        "pending",
        "verify",
        "roadmap",
    ] {
        assert!(help.contains(name), "--help is missing `{name}`:\n{help}");
    }

    // And the options the TypeScript help promises.
    for flag in [
        "--print",
        "--change",
        "--cwd",
        "--openspec-bin",
        "--driver",
        "--force",
        "--help",
    ] {
        assert!(help.contains(flag), "--help is missing `{flag}`:\n{help}");
    }

    assert!(help.starts_with("spec-tacular — spec-driven development, reviewable"));
}

#[test]
fn version_prints_and_exits_zero() {
    let out = run(&["--version"]);
    assert!(out.status.success());
    assert!(stdout(&out).contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn a_directory_without_openspec_is_refused() {
    let dir = TempDir::new("empty");
    let out = run(&["init", "--cwd", dir.path().to_str().unwrap()]);

    assert_eq!(out.status.code(), Some(1), "stderr was:\n{}", stderr(&out));
    let err = stderr(&out);
    assert!(
        err.starts_with(&format!(
            "No openspec/ directory in {}.\n",
            dir.path().display()
        )),
        "unexpected message:\n{err}"
    );
    assert!(err.contains("point at one with --cwd"));
}

#[test]
fn a_command_in_a_project_declines_until_its_stage_lands() {
    let dir = TempDir::new("project");
    std::fs::create_dir_all(dir.path().join("openspec")).unwrap();

    let out = run(&["adr", "--cwd", dir.path().to_str().unwrap()]);

    assert_eq!(out.status.code(), Some(2), "stdout was:\n{}", stdout(&out));
    let err = stderr(&out);
    assert!(
        err.contains("not implemented yet in the Rust port"),
        "unexpected message:\n{err}"
    );
    assert!(
        err.contains("adr"),
        "message should name the command:\n{err}"
    );
}

#[test]
fn the_overview_without_a_terminal_still_needs_a_project() {
    let dir = TempDir::new("overview");
    // No `openspec/`, and stdout is a pipe, so this is not the TUI.
    let out = run(&["--cwd", dir.path().to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("No openspec/ directory in"));
}

#[test]
fn an_unknown_flag_is_a_usage_error() {
    let out = run(&["--nonsense"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr(&out).contains("--nonsense"));
}
