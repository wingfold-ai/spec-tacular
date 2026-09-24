//! The OpenSpec adapter — the ONLY module in spec-tacular that knows OpenSpec
//! exists.
//!
//! Two rules, both load-bearing (see docs/architecture.md):
//!   1. Reads go through the CLI's `--json` surface, which is a far more stable
//!      contract than OpenSpec's internal module paths.
//!   2. Nothing here ever writes a file OpenSpec owns. Mutations are delegated
//!      to OpenSpec's own commands, so the on-disk format stays compatible with
//!      plain `openspec` and with any agent that knows it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use thiserror::Error;
use tokio::process::Command;

use super::types::{ChangeEntry, ChangeOrError, OpenSpecBatchStatus, OpenSpecChangeStatus};
use crate::core::jobs::signal_group;

/// Anything that went wrong reaching OpenSpec, with the one line of advice
/// that usually fixes it.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct OpenSpecError {
    pub message: String,
    /// What to try next. Printed on its own line; never part of `message`, so
    /// a caller that only has room for one line still shows the useful half.
    pub hint: Option<String>,
}

impl OpenSpecError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    /// Message and hint on one line, for a UI with a single line to spend.
    /// The TypeScript `describeError`.
    pub fn describe(&self) -> String {
        match &self.hint {
            Some(hint) => format!("{} {hint}", self.message),
            None => self.message.clone(),
        }
    }
}

/// A sweep over a large repository is not instant.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(120_000);

/// Whether `dir` looks like an OpenSpec project. Cheap, no subprocess.
pub fn is_openspec_project(dir: impl AsRef<Path>) -> bool {
    dir.as_ref().join("openspec").exists()
}

/// Every active change, split into the ones that loaded and the ones that did
/// not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BatchStatus {
    pub changes: Vec<OpenSpecChangeStatus>,
    /// Changes OpenSpec could not read, by name. Reported, never thrown on.
    pub failed: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct OpenSpecAdapter {
    /// Project root. Must contain an `openspec/` directory.
    cwd: PathBuf,
    /// The binary, overridable for tests or a pinned local install.
    bin: PathBuf,
    /// Per-invocation timeout.
    timeout: Duration,
}

impl OpenSpecAdapter {
    pub fn new(cwd: impl Into<PathBuf>, bin: Option<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            bin: bin.unwrap_or_else(|| PathBuf::from("openspec")),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Status for every active change.
    ///
    /// Entries that failed to load are collected rather than thrown on:
    /// OpenSpec's own sweep does not abort for one bad change, and neither
    /// should the UI — one malformed change must not hide the other
    /// twenty-five.
    pub async fn status_all(&self) -> Result<BatchStatus, OpenSpecError> {
        let raw: OpenSpecBatchStatus = self.run_json(&["status", "--all", "--json"]).await?;

        // `{ changes: [], root: null }` is OpenSpec's documented failure shape
        // for this command, not an empty project. Told apart by `root`.
        if raw.root.is_none() && raw.changes.is_empty() {
            return Err(OpenSpecError::with_hint(
                "OpenSpec could not resolve a project root.",
                format!(
                    "Is {} an OpenSpec project? Try `openspec init`.",
                    self.cwd.display()
                ),
            ));
        }

        let mut status = BatchStatus::default();
        for entry in raw.changes {
            match ChangeEntry::classify(entry) {
                ChangeOrError::Change(change) => status.changes.push(*change),
                ChangeOrError::Error(error) => status.failed.push(error.change_name),
            }
        }
        Ok(status)
    }

    /// Status for one change.
    pub async fn status(&self, change: &str) -> Result<OpenSpecChangeStatus, OpenSpecError> {
        self.run_json(&["status", "--change", change, "--json"])
            .await
    }

    /// Raw instructions for writing one artifact.
    ///
    /// Returned as text, not parsed: this is handed to an agent verbatim, and
    /// spec-tacular has no business reinterpreting OpenSpec's guidance.
    pub async fn instructions(
        &self,
        artifact: &str,
        change: &str,
    ) -> Result<String, OpenSpecError> {
        Ok(self
            .run(&["instructions", artifact, "--change", change])
            .await?
            .stdout)
    }

    /// The schema's starting template for an artifact, for writing it by hand.
    pub async fn template(&self, artifact: &str, change: &str) -> Result<String, OpenSpecError> {
        #[derive(Debug, Default, Deserialize)]
        struct Instructions {
            #[serde(default)]
            template: Option<String>,
        }
        let raw: Instructions = self
            .run_json(&["instructions", artifact, "--change", change, "--json"])
            .await?;
        Ok(raw.template.unwrap_or_default())
    }

    /// The file an artifact is written in by hand, seeded with the schema's
    /// template when it does not exist yet — `e` on the overview, the
    /// TypeScript `artifactFile`.
    ///
    /// The one place this module writes a file, and it is not one OpenSpec
    /// owns: an artifact is the developer's own document, which OpenSpec reads
    /// and which agents write just the same. What is OpenSpec-shaped is
    /// *where* it goes and what it starts as, and both come from OpenSpec —
    /// the path from `status`, the text from `instructions --json`. A blank
    /// page is never the starting point.
    pub async fn artifact_file(
        &self,
        status: &OpenSpecChangeStatus,
        artifact: &str,
    ) -> Result<PathBuf, OpenSpecError> {
        let change = status.change_name.as_str();
        let Some(paths) = status.artifact_paths.get(artifact) else {
            return Err(OpenSpecError::new(format!(
                "{change} has no artifact called {artifact}"
            )));
        };
        let file = PathBuf::from(&paths.resolved_output_path);
        if paths.resolved_output_path.contains('*') {
            return Err(OpenSpecError::new(format!(
                "{artifact} spans one file per capability — w lets an agent draft them"
            )));
        }
        if !file.exists() {
            let template = self.template(artifact, change).await?;
            let seeded = template.replace("<!-- Change name -->", change);
            let written = file
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(&file, seeded));
            if let Err(error) = written {
                return Err(OpenSpecError::new(format!(
                    "Could not create {}: {error}",
                    file.display()
                )));
            }
        }
        Ok(file)
    }

    /// Archives a change through OpenSpec.
    ///
    /// `--yes` is passed because spec-tacular has already resolved what it
    /// covers: every requirement is accepted or recorded in the pending
    /// register, and the only unchecked tasks are ones deliberately deferred.
    pub async fn archive(&self, change: &str) -> Result<String, OpenSpecError> {
        let output = self.run(&["archive", change, "--yes"]).await?;
        Ok(output.stdout + &output.stderr)
    }

    /// Validates a spec or change, so a write can be checked by its owner.
    pub async fn validate(&self, item: &str) -> Result<String, OpenSpecError> {
        let output = self.run(&["validate", item, "--type", "spec"]).await?;
        Ok(output.stdout + &output.stderr)
    }

    /// The OpenSpec version in use, for the compatibility check.
    pub async fn version(&self) -> Result<String, OpenSpecError> {
        Ok(self.run(&["--version"]).await?.stdout.trim().to_owned())
    }

    /// Makes `cwd` an OpenSpec project.
    ///
    /// `--tools none` because choosing which agents to wire up is an
    /// interactive question this UI does not ask; stdin is closed, so the
    /// prompt would fail.
    pub async fn init(&self) -> Result<(), OpenSpecError> {
        self.run(&["init", "--tools", "none", "--no-animation"])
            .await?;
        Ok(())
    }

    /// Creates a change. Its schema comes from the project's config.
    pub async fn new_change(
        &self,
        name: &str,
        description: Option<&str>,
    ) -> Result<(), OpenSpecError> {
        let mut args = vec!["new", "change", name];
        if let Some(description) = description.filter(|d| !d.is_empty()) {
            args.push("--description");
            args.push(description);
        }
        self.run(&args).await?;
        Ok(())
    }

    async fn run_json<T: serde::de::DeserializeOwned>(
        &self,
        args: &[&str],
    ) -> Result<T, OpenSpecError> {
        let stdout = self.run(args).await?.stdout;
        serde_json::from_str(&stdout).map_err(|_| {
            // A non-JSON body from a --json command means the CLI failed before
            // it could produce one. Its own text is the most useful thing to
            // show.
            let preview: String = stdout.trim().chars().take(300).collect();
            OpenSpecError::with_hint(
                format!("openspec {} did not return JSON.", args.join(" ")),
                if preview.is_empty() {
                    "No output. Is the openspec CLI installed and on PATH?".to_owned()
                } else {
                    preview
                },
            )
        })
    }

    async fn run(&self, args: &[&str]) -> Result<CommandOutput, OpenSpecError> {
        let child = Command::new(&self.bin)
            .args(args)
            .current_dir(&self.cwd)
            // stdin is closed so a prompt can never silently hang the UI: any
            // OpenSpec command that wants confirmation fails fast instead.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // The timeout below drops the child; without this it would go on
            // running, detached, holding the project's lock files.
            .kill_on_drop(true)
            // And its own process group, so the timeout can reach what it
            // started. `kill_on_drop` reaches the direct child only, which for
            // a command that is a shell — or that shells out — is the wrapper
            // and not the work.
            .process_group(0)
            .spawn()
            .map_err(|err| self.spawn_error(&err))?;

        // Read before the wait consumes the child. The group id is the child's
        // pid, and a group outlives its leader as long as it has members.
        let pid = child.id().and_then(|pid| i32::try_from(pid).ok());

        let output = match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => return Err(self.spawn_error(&err)),
            Err(_) => {
                if let Some(pid) = pid {
                    signal_group(pid, libc::SIGKILL);
                }
                return Err(OpenSpecError::new(format!(
                    "openspec {} timed out after {}ms.",
                    args.join(" "),
                    self.timeout.as_millis()
                )));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        // A `--json` command can exit non-zero and still have emitted a usable
        // payload, so a parseable body wins over the exit code.
        if !output.status.success() && stdout.trim().is_empty() {
            let code = match output.status.code() {
                Some(code) => code.to_string(),
                // Killed by a signal. TypeScript's `close` handler reported
                // `null` here, and the string is what a user sees.
                None => "null".to_owned(),
            };
            let message = format!("openspec {} exited with code {code}.", args.join(" "));
            let trimmed = stderr.trim();
            return Err(if trimmed.is_empty() {
                OpenSpecError::new(message)
            } else {
                OpenSpecError::with_hint(message, trimmed)
            });
        }

        Ok(CommandOutput { stdout, stderr })
    }

    fn spawn_error(&self, err: &std::io::Error) -> OpenSpecError {
        let bin = self.bin.display();
        if err.kind() == std::io::ErrorKind::NotFound {
            OpenSpecError::with_hint(
                format!("The `{bin}` command was not found."),
                "Install it with `npm install -g @fission-ai/openspec`.",
            )
        } else {
            OpenSpecError::new(format!("Could not run `{bin}`: {err}"))
        }
    }
}

struct CommandOutput {
    stdout: String,
    stderr: String,
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::fake;
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn adapter(dir: &TempDir, body: &str) -> OpenSpecAdapter {
        fake::adapter(dir.path(), body)
    }

    fn temp() -> TempDir {
        TempDir::new().expect("temp dir")
    }

    #[tokio::test]
    async fn a_batch_sweep_keeps_the_changes_that_loaded_and_names_the_ones_that_did_not() {
        let dir = temp();
        let adapter = adapter(
            &dir,
            r#"echo '{"root":{"path":"/p"},"changes":[{"changeName":"ok","artifacts":[]},{"changeName":"broken"}]}'"#,
        );
        let status = adapter.status_all().await.expect("status");
        assert_eq!(
            status
                .changes
                .iter()
                .map(|c| c.change_name.as_str())
                .collect::<Vec<_>>(),
            vec!["ok"]
        );
        assert_eq!(status.failed, vec!["broken"]);
    }

    #[tokio::test]
    async fn no_root_and_no_changes_is_a_failure_to_resolve_a_project_not_an_empty_one() {
        let dir = temp();
        let adapter = adapter(&dir, r#"echo '{"changes":[],"root":null}'"#);
        let err = adapter.status_all().await.expect_err("an error");
        assert_eq!(err.message, "OpenSpec could not resolve a project root.");
        assert!(err.hint.expect("a hint").contains("openspec init"));
    }

    #[tokio::test]
    async fn an_empty_project_with_a_root_is_not_an_error() {
        let dir = temp();
        let adapter = adapter(&dir, r#"echo '{"changes":[],"root":{"path":"/p"}}'"#);
        let status = adapter.status_all().await.expect("status");
        assert!(status.changes.is_empty());
        assert!(status.failed.is_empty());
    }

    #[tokio::test]
    async fn a_missing_binary_says_how_to_install_it() {
        let dir = temp();
        let adapter = OpenSpecAdapter::new(dir.path(), Some(dir.path().join("not-here")));
        let err = adapter.version().await.expect_err("an error");
        assert!(
            err.message.ends_with("not-here` command was not found."),
            "unexpected message: {}",
            err.message
        );
        assert_eq!(
            err.hint.as_deref(),
            Some("Install it with `npm install -g @fission-ai/openspec`.")
        );
    }

    #[tokio::test]
    async fn a_command_that_never_returns_times_out() {
        let dir = temp();
        // The fake starts something and waits, the way a real `openspec` that
        // shells out would: the grandchild is what a naive kill leaves behind.
        let marker = dir.path().join("still-running");
        let adapter = adapter(
            &dir,
            &format!("sh -c 'sleep 30; : > {}' &\nwait", marker.display()),
        )
        .with_timeout(Duration::from_millis(150));
        let err = adapter.version().await.expect_err("an error");
        assert_eq!(err.message, "openspec --version timed out after 150ms.");
        assert!(err.hint.is_none());

        // And the timeout took the whole group with it. Without that the sleep
        // outlives the suite, holding the project's lock files and reading as
        // a command still in flight.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut gone = false;
        while !gone && std::time::Instant::now() < deadline {
            let listing = std::process::Command::new("ps")
                .args(["-eo", "args"])
                .output()
                .expect("ps");
            gone = !String::from_utf8_lossy(&listing.stdout)
                .contains(&dir.path().display().to_string());
            if !gone {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        assert!(gone, "the timed-out command left a process behind");
    }

    #[tokio::test]
    async fn a_failure_with_nothing_on_stdout_reports_the_exit_code_and_stderr() {
        let dir = temp();
        let adapter = adapter(&dir, "echo 'no such change' >&2\nexit 3");
        let err = adapter.status("nope").await.expect_err("an error");
        assert_eq!(
            err.message,
            "openspec status --change nope --json exited with code 3."
        );
        assert_eq!(err.hint.as_deref(), Some("no such change"));
    }

    #[tokio::test]
    async fn a_payload_wins_over_a_non_zero_exit_code() {
        // A `--json` command can exit non-zero and still have said something
        // usable; throwing the payload away would lose the whole sweep.
        let dir = temp();
        let adapter = adapter(
            &dir,
            r#"echo '{"root":{"path":"/p"},"changes":[{"changeName":"ok","artifacts":[]}]}'
exit 1"#,
        );
        let status = adapter.status_all().await.expect("status");
        assert_eq!(status.changes.len(), 1);
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_is_previewed_rather_than_swallowed() {
        let dir = temp();
        let adapter = adapter(&dir, "echo 'Usage: openspec status [options]'");
        let err = adapter.status_all().await.expect_err("an error");
        assert_eq!(
            err.message,
            "openspec status --all --json did not return JSON."
        );
        assert_eq!(
            err.hint.as_deref(),
            Some("Usage: openspec status [options]")
        );
    }

    #[tokio::test]
    async fn a_long_non_json_body_is_cut_to_three_hundred_characters() {
        let dir = temp();
        let adapter = adapter(&dir, "printf 'x%.0s' $(seq 1 500)");
        let err = adapter.status_all().await.expect_err("an error");
        assert_eq!(err.hint.expect("a hint").chars().count(), 300);
    }

    #[tokio::test]
    async fn an_empty_body_from_a_json_command_suggests_the_cli_is_missing() {
        let dir = temp();
        let adapter = adapter(&dir, "true");
        let err = adapter.status_all().await.expect_err("an error");
        assert_eq!(
            err.hint.as_deref(),
            Some("No output. Is the openspec CLI installed and on PATH?")
        );
    }

    #[tokio::test]
    async fn instructions_are_handed_back_verbatim() {
        let dir = temp();
        let adapter = adapter(&dir, r#"echo "$*""#);
        let out = adapter
            .instructions("specs", "add-auth")
            .await
            .expect("run");
        assert_eq!(out, "instructions specs --change add-auth\n");
    }

    #[tokio::test]
    async fn a_template_comes_from_the_json_surface() {
        let dir = temp();
        let adapter = adapter(&dir, r##"echo '{"template":"# <!-- Change name -->"}'"##);
        assert_eq!(
            adapter.template("proposal", "c").await.expect("template"),
            "# <!-- Change name -->"
        );
    }

    #[tokio::test]
    async fn a_json_response_without_a_template_is_empty_not_an_error() {
        let dir = temp();
        let adapter = adapter(&dir, r#"echo '{}'"#);
        assert_eq!(adapter.template("proposal", "c").await.expect("ok"), "");
    }

    #[tokio::test]
    async fn archiving_and_validating_report_both_streams() {
        let dir = temp();
        let adapter = adapter(&dir, "echo out\necho err >&2");
        assert_eq!(adapter.archive("c").await.expect("archive"), "out\nerr\n");
        assert_eq!(
            adapter.validate("cap").await.expect("validate"),
            "out\nerr\n"
        );
    }

    #[tokio::test]
    async fn mutations_are_delegated_with_the_arguments_openspec_expects() {
        let dir = temp();
        let log = dir.path().join("args.log");
        let adapter = adapter(&dir, &format!(r#"echo "$*" >> {}"#, log.display()));

        adapter.init().await.expect("init");
        adapter.new_change("add-auth", None).await.expect("new");
        adapter
            .new_change("add-auth", Some("let people log in"))
            .await
            .expect("new");
        // An empty description is no description: OpenSpec would take the flag
        // and store nothing.
        adapter.new_change("add-auth", Some("")).await.expect("new");

        let recorded = fs::read_to_string(&log).expect("the log");
        assert_eq!(
            recorded.lines().collect::<Vec<_>>(),
            vec![
                "init --tools none --no-animation",
                "new change add-auth",
                "new change add-auth --description let people log in",
                "new change add-auth",
            ]
        );
    }

    #[tokio::test]
    async fn stdin_is_closed_so_a_prompt_can_never_hang_the_ui() {
        let dir = temp();
        // Reads a line and echoes what it got. With stdin closed that is
        // nothing at all, immediately — rather than a wait with no end.
        let adapter = adapter(&dir, "read answer\necho \"[$answer]\"")
            .with_timeout(Duration::from_millis(2_000));
        assert_eq!(adapter.version().await.expect("version"), "[]");
    }

    #[tokio::test]
    async fn the_version_is_trimmed() {
        let dir = temp();
        let adapter = adapter(&dir, "echo '  1.13.1  '");
        assert_eq!(adapter.version().await.expect("version"), "1.13.1");
    }

    #[tokio::test]
    async fn commands_run_in_the_project_root() {
        let dir = temp();
        let adapter = adapter(&dir, "pwd");
        let out = adapter.instructions("specs", "c").await.expect("run");
        // macOS symlinks /tmp; compare what the shell reports for the same path.
        assert_eq!(
            out.trim(),
            fs::canonicalize(dir.path())
                .expect("real path")
                .display()
                .to_string()
        );
    }

    #[test]
    fn a_directory_with_an_openspec_folder_is_a_project() {
        let dir = temp();
        assert!(!is_openspec_project(dir.path()));
        fs::create_dir(dir.path().join("openspec")).expect("mkdir");
        assert!(is_openspec_project(dir.path()));
    }

    #[test]
    fn an_error_describes_itself_on_one_line_when_it_has_to() {
        assert_eq!(OpenSpecError::new("boom").describe(), "boom");
        assert_eq!(
            OpenSpecError::with_hint("boom", "try this").describe(),
            "boom try this"
        );
    }
}
