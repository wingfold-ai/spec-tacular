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
fn the_tui_is_the_only_thing_left_that_declines() {
    // `--print` without a terminal is the overview, and stdout here is a pipe,
    // so the TUI branch is reached by nothing this suite can run. What it can
    // check is that no subcommand takes the placeholder any more.
    let dir = project("project");
    let cwd = dir.path().to_str().unwrap();

    for args in [
        vec!["pending", "--cwd", cwd],
        vec!["jobs", "--cwd", cwd],
        vec!["roadmap", "--cwd", cwd],
    ] {
        let out = run(&args);
        assert!(
            !stderr(&out).contains("not implemented yet"),
            "`{}` still declines:\n{}",
            args[0],
            stderr(&out)
        );
    }
}

#[test]
fn pending_says_so_when_nothing_is_waiting() {
    let dir = project("pending-empty");
    let out = run(&["pending", "--cwd", dir.path().to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(0), "stderr:\n{}", stderr(&out));
    assert_eq!(stdout(&out), "Nothing is waiting on validation.\n");
}

#[test]
fn pending_lists_the_register_grouped_by_capability() {
    let dir = project("pending-list");
    std::fs::create_dir_all(dir.path().join("spec-tacular")).expect("dir");
    std::fs::write(
        dir.path().join("spec-tacular/pending-validation.md"),
        "# Pending validation\n\n## data-export\n\n\
         ### Requirement: Export completes\n\nThe system SHALL export.\n\n\
         **Change:** add-export\n**Deferred:** 2026-09-21\n\
         **Needs:** a deployed instance\n",
    )
    .expect("register");

    let out = run(&["pending", "--cwd", dir.path().to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(0), "stderr:\n{}", stderr(&out));
    let text = stdout(&out);
    assert!(text.contains("\ndata-export\n"), "{text}");
    assert!(text.contains("  Export completes\n"), "{text}");
    assert!(text.contains("    needs: a deployed instance\n"), "{text}");
    assert!(
        text.contains("    from:  add-export (2026-09-21)\n"),
        "{text}"
    );
    assert!(
        text.contains("1 requirement(s) accepted but unverified"),
        "{text}"
    );
}

#[test]
fn roadmap_scaffolds_on_the_first_run_and_lists_afterwards() {
    let dir = project("roadmap");
    let cwd = dir.path().to_str().unwrap();

    let first = run(&["roadmap", "--cwd", cwd]);
    assert_eq!(first.status.code(), Some(0), "stderr:\n{}", stderr(&first));
    assert!(stdout(&first).starts_with("Created "), "{}", stdout(&first));
    assert!(dir.path().join("spec-tacular/roadmap.yaml").is_file());

    let second = run(&["roadmap", "--cwd", cwd]);
    assert_eq!(second.status.code(), Some(0));
    let text = stdout(&second);
    assert!(text.contains("○ first-slice"), "{text}");
    assert!(
        text.contains("Next: spectacular roadmap --promote first-slice"),
        "{text}"
    );
}

#[test]
fn roadmap_promotes_one_slice_and_refuses_the_next() {
    let dir = project("roadmap-promote");
    let cwd = dir.path().to_str().unwrap();
    std::fs::create_dir_all(dir.path().join("spec-tacular")).expect("dir");
    std::fs::write(
        dir.path().join("spec-tacular/roadmap.yaml"),
        "vision: A tool.\nslices:\n  - id: auth\n    summary: Sign in\n    status: planned\n\
         \x20   dependsOn: []\n  - id: billing\n    summary: Pay\n    status: planned\n\
         \x20   dependsOn: []\n",
    )
    .expect("roadmap");

    let promoted = run(&["roadmap", "--promote", "auth", "--cwd", cwd]);
    assert_eq!(promoted.status.code(), Some(0), "{}", stderr(&promoted));
    assert!(stdout(&promoted).contains("'auth' is now active"));
    assert!(stdout(&promoted).contains("openspec new change auth"));

    // One slice at a time is the whole rule.
    let second = run(&["roadmap", "--promote", "billing", "--cwd", cwd]);
    assert_eq!(second.status.code(), Some(1));
    assert!(
        stderr(&second).contains("one slice at a time"),
        "{}",
        stderr(&second)
    );

    let done = run(&["roadmap", "--done", "auth", "--cwd", cwd]);
    assert_eq!(done.status.code(), Some(0));
    assert_eq!(stdout(&done), "'auth' is done.\n");
    assert!(
        std::fs::read_to_string(dir.path().join("spec-tacular/roadmap.yaml"))
            .expect("read")
            .contains("status: done")
    );
}

#[test]
fn jobs_says_so_when_there_are_none_and_names_an_id_it_cannot_find() {
    let dir = project("jobs-empty");
    let cwd = dir.path().to_str().unwrap();

    let listed = run(&["jobs", "--cwd", cwd]);
    assert_eq!(
        listed.status.code(),
        Some(0),
        "stderr:\n{}",
        stderr(&listed)
    );
    assert_eq!(stdout(&listed), "No jobs yet.\n");

    let missing = run(&["jobs", "--job", "nope", "--cwd", cwd]);
    assert_eq!(missing.status.code(), Some(1));
    assert_eq!(stderr(&missing), "No job matching 'nope'.\n");
}

/// `spectacular run`, against a `claude` that is a shell script.
///
/// The registry is fixed, so the driver is faked the way a user would hit it:
/// a `claude` earlier on PATH than the real one. Nothing here costs money, and
/// nothing here needs the real CLI installed.
#[cfg(unix)]
#[test]
fn run_dispatches_a_job_that_outlives_the_command_and_jobs_reads_it_back() {
    use std::os::unix::fs::PermissionsExt;

    let dir = project("run-dispatch");
    let cwd = dir.path().to_str().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).expect("bin dir");

    // A stand-in agent that takes long enough to still be running when the
    // dispatching process has exited, then says it is done in the driver's own
    // stream-json.
    let marker = dir.path().join("agent-finished");
    let fake_claude = bin.join("claude");
    std::fs::write(
        &fake_claude,
        format!(
            "#!/bin/sh\nsleep 1\necho '{{\"type\":\"assistant\",\"message\":{{\"content\":\
             [{{\"type\":\"text\",\"text\":\"Writing specs\"}}]}}}}'\n\
             echo '{{\"type\":\"result\",\"result\":\"ok\"}}'\n\
             : > {}\n",
            marker.display()
        ),
    )
    .expect("write the fake agent");
    std::fs::set_permissions(&fake_claude, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let sweep = one_change(dir.path(), false);
    let openspec = fake_openspec(
        dir.path(),
        &format!(
            r#"case "$1" in
  instructions) echo 'WRITE THE SPECS' ;;
  *)
{sweep}
;;
esac"#
        ),
    );

    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let dispatched = Command::new(BIN)
        .args(["run", "specs", "-c", "add-auth", "--cwd", cwd])
        .args(["--openspec-bin", &openspec])
        .env("PATH", &path)
        .output()
        .expect("run spectacular");

    assert_eq!(
        dispatched.status.code(),
        Some(0),
        "stderr:\n{}",
        stderr(&dispatched)
    );
    let text = stdout(&dispatched);
    assert!(
        text.starts_with("Started Claude Code on add-auth/specs\n"),
        "{text}"
    );
    assert!(text.contains("  job:  "), "{text}");
    assert!(
        text.contains("Follow it with: spectacular jobs --job "),
        "{text}"
    );
    // Dispatching returns at once; the agent is still working.
    assert!(
        !marker.exists(),
        "run waited for the agent instead of returning"
    );

    // A second job on the same change is refused while the first runs.
    let conflict = Command::new(BIN)
        .args(["run", "specs", "-c", "add-auth", "--cwd", cwd])
        .args(["--openspec-bin", &openspec])
        .env("PATH", &path)
        .output()
        .expect("run spectacular");
    assert_eq!(conflict.status.code(), Some(1));
    assert!(
        stderr(&conflict).contains("already has a running job"),
        "{}",
        stderr(&conflict)
    );

    let listed = run(&["jobs", "--cwd", cwd]);
    assert!(
        stdout(&listed).contains("running     add-auth/specs"),
        "{}",
        stdout(&listed)
    );

    // The job survived the process that started it: it finishes on its own and
    // records its own exit code, with nothing of ours left watching.
    let job_id = text
        .lines()
        .find_map(|line| line.strip_prefix("  job:  "))
        .expect("the job id is printed")
        .to_owned();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        marker.exists(),
        "the detached agent never ran to completion"
    );
    assert!(
        dir.path()
            .join(format!(".spec-tacular/jobs/{job_id}.exit"))
            .is_file(),
        "the wrapper must record the exit code for a parent that is gone"
    );

    let tailed = run(&["jobs", "--job", &job_id[..8], "--cwd", cwd]);
    assert_eq!(
        tailed.status.code(),
        Some(0),
        "stderr:\n{}",
        stderr(&tailed)
    );
    let log = stdout(&tailed);
    // Rendered by the driver, not dumped: the stream-json is unreadable raw.
    assert!(log.contains("add-auth/specs  succeeded  started "), "{log}");
    assert!(log.contains("\nWriting specs\n"), "{log}");
    assert!(log.contains("\ndone\n"), "{log}");
    assert!(!log.contains("\"type\""), "the raw protocol leaked:\n{log}");
}

#[cfg(unix)]
#[test]
fn run_is_refused_when_the_gate_is() {
    // The background path must not bypass a check the foreground honours.
    let dir = project("run-gate");
    let cwd = dir.path().to_str().unwrap();
    let openspec = fake_openspec(dir.path(), &one_change(dir.path(), false));

    let out = run(&[
        "run",
        "design",
        "-c",
        "add-auth",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(out.status.code(), Some(1), "stdout:\n{}", stdout(&out));
    assert!(stderr(&out).contains("Refused:"), "{}", stderr(&out));
    assert!(
        !dir.path().join(".spec-tacular/jobs").exists(),
        "a refused run started a job"
    );
}

#[cfg(unix)]
#[test]
fn run_names_a_driver_it_does_not_have() {
    let dir = project("run-driver");
    let cwd = dir.path().to_str().unwrap();
    let openspec = fake_openspec(dir.path(), &one_change(dir.path(), false));

    let out = run(&[
        "run",
        "specs",
        "-c",
        "add-auth",
        "--driver",
        "nope",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).contains("Unknown agent driver 'nope'")
            && stderr(&out).contains("claude, opencode"),
        "{}",
        stderr(&out)
    );
}

#[cfg(unix)]
#[test]
fn archive_dry_run_reports_the_split_and_writes_nothing() {
    let dir = project("archive-dry");
    let cwd = dir.path().to_str().unwrap();
    let status = one_change(dir.path(), true);
    let spec = dir
        .path()
        .join("openspec/changes/add-auth/specs/cap/spec.md");
    std::fs::write(
        &spec,
        "## ADDED Requirements\n\n### Requirement: Alpha\nSHALL alpha.\n\n\
         #### Scenario: ok\n- **WHEN** a\n- **THEN** b\n\n\
         ### Requirement: Beta\nSHALL beta.\n",
    )
    .expect("spec");
    let openspec = fake_openspec(
        dir.path(),
        &format!(
            r#"case "$1" in
  archive) echo archived ;;
  *)
{status}
;;
esac"#
        ),
    );

    // Nothing reviewed: the archive is refused rather than merging text nobody
    // agreed to.
    let refused = run(&[
        "archive",
        "add-auth",
        "--dry-run",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(
        refused.status.code(),
        Some(1),
        "stdout:\n{}",
        stdout(&refused)
    );
    assert!(
        stderr(&refused).contains("2 requirement(s) are neither accepted nor deferred"),
        "{}",
        stderr(&refused)
    );
    assert!(
        stderr(&refused).contains("exactly what `--yes` does"),
        "{}",
        stderr(&refused)
    );
    assert!(stdout(&refused).contains("0 requirement(s) merge into the baseline"));

    let unknown = run(&[
        "archive",
        "nothing-like-this",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(
        unknown.status.code(),
        Some(1),
        "stderr:\n{}",
        stderr(&unknown)
    );
    assert_eq!(stderr(&unknown), "No change called 'nothing-like-this'.\n");

    // `-c` wins over the positional, as the TypeScript parser had it.
    let both = run(&[
        "archive",
        "add-auth",
        "-c",
        "nothing-like-this",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(both.status.code(), Some(1));
    assert_eq!(stderr(&both), "No change called 'nothing-like-this'.\n");

    // And the delta is untouched by any of it.
    assert!(std::fs::read_to_string(&spec)
        .expect("read")
        .contains("### Requirement: Beta"));
}

#[test]
fn archive_without_a_change_says_how_to_call_it() {
    let dir = project("archive-usage");
    let out = run(&["archive", "--cwd", dir.path().to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "Usage: spectacular archive <change>\n");
}

#[test]
fn verify_without_a_requirement_says_how_to_call_it() {
    let dir = project("verify-usage");
    let out = run(&[
        "verify",
        "data-export",
        "--cwd",
        dir.path().to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        stderr(&out),
        "Usage: spectacular verify <capability> --requirement \"<name>\"\n"
    );
}

#[cfg(unix)]
#[test]
fn verify_moves_a_pending_requirement_into_the_baseline_and_revalidates() {
    let dir = project("verify");
    let cwd = dir.path().to_str().unwrap();
    std::fs::create_dir_all(dir.path().join("spec-tacular")).expect("dir");
    std::fs::write(
        dir.path().join("spec-tacular/pending-validation.md"),
        "# Pending validation\n\n## data-export\n\n\
         ### Requirement: Export completes\n\nThe system SHALL export.\n\n\
         #### Scenario: Deployed\n- **WHEN** run\n- **THEN** a file\n\n\
         **Change:** add-export\n**Deferred:** 2026-09-21\n**Needs:** a deployment\n",
    )
    .expect("register");
    let openspec = fake_openspec(dir.path(), "case \"$1\" in\n  validate) ;;\nesac");

    let out = run(&[
        "verify",
        "data-export",
        "--requirement",
        "export  COMPLETES",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(out.status.code(), Some(0), "stderr:\n{}", stderr(&out));
    let text = stdout(&out);
    assert!(
        text.starts_with("Verified 'Export completes' into "),
        "{text}"
    );
    assert!(
        text.contains("(the spec did not exist — fill in its Purpose)"),
        "{text}"
    );
    assert!(text.ends_with("openspec validate: ok\n"), "{text}");

    let spec = std::fs::read_to_string(dir.path().join("openspec/specs/data-export/spec.md"))
        .expect("the spec was written");
    assert!(spec.contains("### Requirement: Export completes"));
    assert!(spec.contains("#### Scenario: Deployed"));
    // And it is gone from the register, which now says so.
    assert!(
        std::fs::read_to_string(dir.path().join("spec-tacular/pending-validation.md"))
            .expect("register")
            .contains("Nothing is waiting on validation")
    );

    let again = run(&[
        "verify",
        "data-export",
        "--requirement",
        "Export completes",
        "--cwd",
        cwd,
        "--openspec-bin",
        &openspec,
    ]);
    assert_eq!(again.status.code(), Some(1));
    assert!(
        stderr(&again).contains("nothing pending"),
        "{}",
        stderr(&again)
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
