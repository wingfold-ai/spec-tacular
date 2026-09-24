//! End-to-end checks on the built binary.
//!
//! These run `spectacular` as a process rather than calling into the crate, so
//! what is asserted is the thing a user actually gets: the help text, the exit
//! codes, and the messages on stderr.
//!
//! The commands that talk to OpenSpec are driven against a stand-in on disk, so
//! the suite needs nothing installed; the one test that uses the real CLI says
//! so in its name and skips itself when it is not there.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

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

/// A project directory with an `openspec/` in it, which is all
/// `isOpenSpecProject` asks for.
fn project(tag: &str) -> TempDir {
    let dir = TempDir::new(tag);
    std::fs::create_dir_all(dir.path().join("openspec")).expect("openspec dir");
    dir
}

/// The one executable stand-in for `openspec` in this test binary.
///
/// Writing an executable while another thread is between `fork` and `exec`
/// makes that exec fail with ETXTBSY, so exactly one file is ever executed and
/// what it does is read from `fake-openspec.sh` in the working directory —
/// plain data, rewritable per test. Mirrors `adapter::fake`.
#[cfg(unix)]
fn dispatcher() -> &'static Path {
    use std::os::unix::fs::PermissionsExt;

    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-fakes");
        std::fs::create_dir_all(&dir).expect("the fake's directory");
        let path = dir.join(format!("openspec-cli-{}", std::process::id()));
        std::fs::write(&path, "#!/bin/sh\nexec /bin/sh ./fake-openspec.sh \"$@\"\n")
            .expect("write the dispatcher");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    })
}

/// Teaches the stand-in what to answer inside `project`, and returns the path
/// to pass as `--openspec-bin`.
#[cfg(unix)]
fn fake_openspec(project: &Path, body: &str) -> String {
    std::fs::write(
        project.join("fake-openspec.sh"),
        format!("#!/bin/sh\n{body}\n"),
    )
    .expect("write the fake");
    dispatcher().display().to_string()
}

/// A one-change sweep, with the change's files on disk.
#[cfg(unix)]
fn one_change(root: &Path, specs_written: bool) -> String {
    let change_root = root.join("openspec/changes/add-auth");
    std::fs::create_dir_all(change_root.join("specs/cap")).expect("change dirs");
    std::fs::write(
        change_root.join("README.md"),
        "# add-auth\n\nLet people log in.\n",
    )
    .expect("readme");
    let spec = change_root.join("specs/cap/spec.md");
    let existing = if specs_written {
        std::fs::write(
            &spec,
            "## ADDED Requirements\n\n### Requirement: Alpha\nSHALL alpha.\n\n#### Scenario: ok\n- **WHEN** a\n- **THEN** b\n",
        )
        .expect("spec");
        format!("\"{}\"", spec.display())
    } else {
        String::new()
    };
    let specs_status = if specs_written { "done" } else { "ready" };
    format!(
        r#"cat <<'JSON'
{{"root":{{"path":"{root}"}},"changes":[
  {{"changeName":"add-auth","schemaName":"spec-tacular","changeRoot":"{change_root}",
    "applyRequires":["tasks"],"isPlanningComplete":false,"nextSteps":[],
    "artifactPaths":{{"specs":{{"outputPath":"specs/**/*.md","resolvedOutputPath":"{spec}","existingOutputPaths":[{existing}]}}}},
    "artifacts":[
      {{"id":"proposal","outputPath":"proposal.md","status":"done","requires":[]}},
      {{"id":"specs","outputPath":"specs/**/*.md","status":"{specs_status}","requires":["proposal"]}},
      {{"id":"design","outputPath":"design.md","status":"blocked","requires":["specs"]}}
    ]}}
]}}
JSON"#,
        root = root.display(),
        change_root = change_root.display(),
        spec = spec.display(),
    )
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
    let dir = project("project");

    let out = run(&["pending", "--cwd", dir.path().to_str().unwrap()]);

    assert_eq!(out.status.code(), Some(2), "stdout was:\n{}", stdout(&out));
    let err = stderr(&out);
    assert!(
        err.contains("not implemented yet in the Rust port"),
        "unexpected message:\n{err}"
    );
    assert!(
        err.contains("pending"),
        "message should name the command:\n{err}"
    );
}

#[test]
fn init_installs_the_schema_and_refuses_to_replace_it_unsupervised() {
    let dir = project("init");
    let cwd = dir.path().to_str().unwrap();

    let out = run(&["init", "--cwd", cwd]);
    assert_eq!(out.status.code(), Some(0), "stderr:\n{}", stderr(&out));
    let text = stdout(&out);
    assert!(text.contains("Installed the spec-tacular schema to"));
    assert!(text.contains("  templates/spec.md"));
    assert!(text.contains("Scaffolded the Foundation at"));
    // The single static binary carries the schema: nothing beside it is read.
    assert!(dir
        .path()
        .join("openspec/schemas/spec-tacular/schema.yaml")
        .is_file());
    assert!(dir
        .path()
        .join("spec-tacular/foundation/stack.md")
        .is_file());
    assert!(
        std::fs::read_to_string(dir.path().join("openspec/config.yaml"))
            .expect("config")
            .contains("schema: spec-tacular")
    );

    let again = run(&["init", "--cwd", cwd]);
    assert_eq!(again.status.code(), Some(1));
    assert!(stderr(&again).contains("is already installed at"));

    let forced = run(&["init", "--force", "--cwd", cwd]);
    assert_eq!(forced.status.code(), Some(0));
    assert!(stdout(&forced).contains("Local edits to it are gone"));
}

#[test]
fn foundation_and_adr_read_a_freshly_initialised_project() {
    let dir = project("ground-rules");
    let cwd = dir.path().to_str().unwrap();

    let before = run(&["foundation", "--cwd", cwd]);
    assert_eq!(before.status.code(), Some(1));
    assert!(stderr(&before).contains("No Foundation at"));

    run(&["init", "--cwd", cwd]);

    let after = run(&["foundation", "--cwd", cwd]);
    assert_eq!(after.status.code(), Some(0));
    let text = stdout(&after);
    assert!(text.contains("foundation/stack"));
    assert!(
        text.contains("○"),
        "unanswered questions are marked:\n{text}"
    );
    assert!(text.contains("/19 answered"), "got:\n{text}");

    let adrs = run(&["adr", "--cwd", cwd]);
    assert_eq!(adrs.status.code(), Some(0));
    assert_eq!(
        stdout(&adrs),
        "No architectural decisions recorded yet.\nPromote one while reviewing a design: press p on a decision.\n"
    );
}

#[cfg(unix)]
#[test]
fn the_overview_prints_without_a_terminal() {
    let dir = project("print");
    let bin = fake_openspec(dir.path(), &one_change(dir.path(), true));
    let cwd = dir.path().to_str().unwrap();

    let out = run(&["--print", "--cwd", cwd, "--openspec-bin", &bin]);
    assert_eq!(out.status.code(), Some(0), "stderr:\n{}", stderr(&out));
    let text = stdout(&out);
    assert!(text.starts_with(&format!("{}\n1 change\n", dir.path().display())));
    assert!(text.contains("add-auth"));
    assert!(text.contains("* specs"), "got:\n{text}");
    assert!(text.contains("legend: + accepted"));
    // Piped output carries no escape codes, which is the whole point of --print.
    assert!(!text.contains('\x1b'));
}

#[cfg(unix)]
#[test]
fn an_openspec_failure_is_reported_with_its_hint() {
    let dir = project("failure");
    let bin = fake_openspec(dir.path(), r#"echo '{"changes":[],"root":null}'"#);
    let cwd = dir.path().to_str().unwrap();

    let out = run(&["--print", "--cwd", cwd, "--openspec-bin", &bin]);
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(err.starts_with("OpenSpec could not resolve a project root.\n"));
    assert!(err.contains("Try `openspec init`."));
}

#[cfg(unix)]
#[test]
fn instructions_are_refused_until_the_prerequisite_is_accepted() {
    let dir = project("gate");
    let bin = fake_openspec(dir.path(), &one_change(dir.path(), true));
    let cwd = dir.path().to_str().unwrap();

    let out = run(&[
        "instructions",
        "design",
        "-c",
        "add-auth",
        "--cwd",
        cwd,
        "--openspec-bin",
        &bin,
    ]);
    assert_eq!(out.status.code(), Some(1), "stdout:\n{}", stdout(&out));
    let err = stderr(&out);
    assert!(err.contains("Refused: "), "got:\n{err}");
    assert!(err.contains(&format!(
        "Review it first: spectacular --cwd {}, select add-auth, press enter.",
        dir.path().display()
    )));
    assert!(stdout(&out).is_empty(), "nothing is written when refused");
}

#[cfg(unix)]
#[test]
fn instructions_put_the_project_context_ahead_of_openspec_s_own_text() {
    let dir = project("instructions");
    let sweep = one_change(dir.path(), false);
    let bin = fake_openspec(
        dir.path(),
        &format!(
            r#"case "$1" in
  instructions) echo 'WRITE THE PROPOSAL' ;;
  *)
{sweep}
;;
esac"#
        ),
    );
    let cwd = dir.path().to_str().unwrap();

    // A Foundation with every question answered: the first artifact of a change
    // is gated on exactly that.
    std::fs::create_dir_all(dir.path().join("spec-tacular/foundation")).expect("mkdir");
    std::fs::write(
        dir.path().join("spec-tacular/foundation/stack.md"),
        "# Stack\n\n## Language\n\nRust.\n",
    )
    .expect("write");

    let out = run(&[
        "instructions",
        "proposal",
        "-c",
        "add-auth",
        "--cwd",
        cwd,
        "--openspec-bin",
        &bin,
    ]);
    assert_eq!(out.status.code(), Some(0), "stderr:\n{}", stderr(&out));
    let text = stdout(&out);
    assert!(text.contains("# Project ground rules"));
    assert!(text.contains("Rust."));
    assert!(text.contains("The developer described this change as:\n\n> Let people log in."));
    assert!(text.contains("WRITE THE PROPOSAL"));
    assert!(text.find("# Project ground rules") < text.find("WRITE THE PROPOSAL"));
}

/// The one test that uses the real `openspec`.
///
/// SKIPPED when the CLI is not installed, and says so: the rest of the suite
/// runs against a stand-in on purpose, but a contract with another program is
/// worth checking against that program at least once.
#[test]
fn smoke_the_real_openspec_cli_when_it_is_installed() {
    let Ok(output) = Command::new("openspec").arg("--version").output() else {
        eprintln!("SKIPPED: `openspec` is not on PATH");
        return;
    };
    if !output.status.success() {
        eprintln!("SKIPPED: `openspec --version` failed");
        return;
    }

    let dir = TempDir::new("real-openspec");
    let cwd = dir.path().to_str().unwrap();
    let init = Command::new("openspec")
        .args(["init", "--tools", "none", "--no-animation"])
        .current_dir(dir.path())
        .output()
        .expect("openspec init");
    assert!(
        init.status.success(),
        "openspec init failed:\n{}",
        String::from_utf8_lossy(&init.stderr)
    );

    let installed = run(&["init", "--cwd", cwd]);
    assert_eq!(
        installed.status.code(),
        Some(0),
        "stderr:\n{}",
        stderr(&installed)
    );

    let overview = run(&["--print", "--cwd", cwd]);
    assert_eq!(
        overview.status.code(),
        Some(0),
        "stderr:\n{}",
        stderr(&overview)
    );
    assert!(stdout(&overview).contains("0 changes"));
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
fn a_flag_on_the_wrong_subcommand_is_a_usage_error() {
    // Deliberately stricter than the TypeScript parser, which scanned every
    // flag into one flat struct and silently ignored the ones a command had no
    // use for. See docs/rust-port.md, "Deliberate differences from the
    // TypeScript version".
    let dir = TempDir::new("scoping");
    std::fs::create_dir_all(dir.path().join("openspec")).unwrap();

    let out = run(&["pending", "--cancel", "--cwd", dir.path().to_str().unwrap()]);

    assert_eq!(out.status.code(), Some(2), "stdout was:\n{}", stdout(&out));
    let err = stderr(&out);
    assert!(
        err.contains("unexpected argument") && err.contains("--cancel"),
        "expected a usage error naming --cancel, got:\n{err}"
    );
    // And it must be the usage error, not the placeholder.
    assert!(!err.contains("not implemented yet"), "got:\n{err}");
}

#[test]
fn an_unknown_flag_is_a_usage_error() {
    let out = run(&["--nonsense"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr(&out).contains("--nonsense"));
}
