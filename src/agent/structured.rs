//! Runs a driver's one-shot structured request and returns its value.
//!
//! Unlike a job this is not detached: it is short, its result is consumed by
//! the running TUI, and nothing needs to survive the TUI exiting. It is still
//! asynchronous — the UI keeps drawing and taking answers while it runs.
//!
//! Its callers are the Foundation advisor, the vision interview and the name
//! proposal, each through [`driver_ask`] — the real end of `core`'s injected
//! [`Ask`]. What is here has nothing to do with advice: finding the binary,
//! running it, and turning a failure into a sentence somebody can act on.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::default_registry;
use super::driver::{AgentDriver, StructuredMode, StructuredRequest};
use crate::core::advisor::Ask;
use crate::core::jobs::signal_group;

/// How long a structured request may take before it is abandoned.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);

/// Whether `command` can be found on `path`, without running it.
///
/// Takes the search path rather than reading the environment so the check is
/// testable without mutating a process-wide variable other tests are reading.
pub fn on_path_in(command: &str, path: &str) -> bool {
    if command.contains('/') {
        return Path::new(command).exists();
    }
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .any(|dir| dir.join(command).exists())
}

/// Whether `command` can be found on this process's `PATH`.
pub fn on_path(command: &str) -> bool {
    on_path_in(command, &std::env::var("PATH").unwrap_or_default())
}

/// Why a driver cannot advise, or `None` when it can.
pub fn advisor_unavailable(driver: &dyn AgentDriver) -> Option<String> {
    let Some(structured) = driver.structured() else {
        return Some(format!(
            "{} cannot answer structured requests",
            driver.label()
        ));
    };
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let probe = structured.build(&StructuredRequest {
        prompt: "",
        cwd: "",
        schema: &empty,
        mode: StructuredMode::default(),
    });
    (!on_path(&probe.command)).then(|| format!("`{}` is not installed", probe.command))
}

/// Kills a request's process group when the request is abandoned — timed
/// out, or dropped because the TUI quit or moved on. `kill_on_drop` reaches
/// the direct child only; whatever it started (a wrapper's real agent, the
/// agent's own helpers) is in the group and goes with it.
struct GroupGuard(Option<i32>);

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            signal_group(pid, libc::SIGKILL);
        }
    }
}

/// How a structured request may be tuned.
#[derive(Debug, Clone, Copy, Default)]
pub struct StructuredOptions {
    pub mode: StructuredMode,
    /// `None` means [`DEFAULT_TIMEOUT`].
    pub timeout: Option<Duration>,
}

/// Runs the driver's structured command and parses its stdout.
///
/// Every failure comes back as one sentence: the driver's own first line of
/// stderr when it said something, otherwise why the answer could not be read.
/// A missing binary is named rather than reported as "No such file or
/// directory", because the second tells you nothing about which file.
pub async fn run_structured(
    driver: &dyn AgentDriver,
    cwd: &Path,
    prompt: &str,
    schema: &serde_json::Value,
    options: StructuredOptions,
) -> Result<serde_json::Value, String> {
    let Some(structured) = driver.structured() else {
        return Err(format!("{} cannot advise", driver.label()));
    };
    let built = structured.build(&StructuredRequest {
        prompt,
        cwd: &cwd.display().to_string(),
        schema,
        mode: options.mode,
    });

    let mut command = tokio::process::Command::new(&built.command);
    command
        .args(&built.args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // The child must not outlive the request: an abandoned advisor is a
        // process nobody will ever read the output of.
        .kill_on_drop(true)
        // `kill_on_drop` reaches the direct child and nothing it started, so
        // the child gets a process group of its own for the timeout to signal.
        // A group, not a session: this one is meant to die with us.
        .process_group(0);

    let child = command.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("`{}` is not installed", built.command)
        } else {
            format!("could not run `{}`: {err}", built.command)
        }
    })?;

    // Read before the wait consumes the child: the group id is its pid.
    let mut group = GroupGuard(child.id().and_then(|pid| i32::try_from(pid).ok()));

    let timeout = options.timeout.unwrap_or(DEFAULT_TIMEOUT);
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => {
            // The guard, dropped on return, kills the group.
            return Err(format!(
                "{} did not answer within {}s",
                driver.label(),
                timeout.as_secs()
            ));
        }
        Ok(Err(err)) => return Err(err.to_string()),
        Ok(Ok(output)) => {
            // Reaped: its pid, and so its group id, may be reused from here.
            group.0 = None;
            output
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    structured.parse(&stdout).map_err(|reason| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr.trim().lines().next().unwrap_or_default().to_owned();
        if !output.status.success() && !first.is_empty() {
            first
        } else {
            reason
        }
    })
}

/// An [`Ask`] that runs the driver `driver_id`'s structured request in `cwd`.
///
/// The request is spawned onto the current tokio runtime and awaited through
/// its handle, so the future this returns can be driven from anywhere — in
/// particular from a blocking thread in `Handle::block_on`, which is where the
/// TUI runs the advisor so that its file work stays off the thread that
/// draws. The subprocess itself always lives on the runtime, and a request
/// abandoned when the TUI quits is killed with it (`kill_on_drop`).
pub fn driver_ask(driver_id: &str, cwd: &Path, options: StructuredOptions) -> Ask {
    let driver_id = driver_id.to_owned();
    let cwd: PathBuf = cwd.to_path_buf();
    Arc::new(move |prompt, schema| {
        let driver_id = driver_id.clone();
        let cwd = cwd.clone();
        Box::pin(async move {
            let handle = tokio::runtime::Handle::try_current()
                .map_err(|_| "no runtime to ask the model on".to_owned())?;
            handle
                .spawn(async move {
                    let registry = default_registry();
                    let driver = registry.get(&driver_id).map_err(|err| err.to_string())?;
                    run_structured(driver, &cwd, &prompt, &schema, options).await
                })
                .await
                .map_err(|_| "the request to the model was cut off".to_owned())?
        })
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agent::driver::{AgentCommand, AgentRequest, StructuredDriver};
    use crate::agent::{claude::ClaudeDriver, opencode::OpencodeDriver};
    use std::fs;
    use tempfile::TempDir;

    /// A driver whose "agent" is a shell script, so the runner is exercised
    /// without spending money on a real one.
    struct FakeDriver {
        script: String,
    }

    struct FakeStructured {
        script: String,
    }

    impl AgentDriver for FakeDriver {
        fn id(&self) -> &'static str {
            "fake"
        }
        fn label(&self) -> &'static str {
            "Fake"
        }
        fn build(&self, _request: &AgentRequest<'_>) -> AgentCommand {
            command(&self.script)
        }
        fn format_line(&self, line: &str) -> Option<String> {
            Some(line.to_owned())
        }
        fn structured(&self) -> Option<&dyn StructuredDriver> {
            // The script is the same command; a second object would only
            // duplicate it, so the driver leaks a reference to one it owns.
            Some(Box::leak(Box::new(FakeStructured {
                script: self.script.clone(),
            })))
        }
    }

    impl StructuredDriver for FakeStructured {
        fn build(&self, _request: &StructuredRequest<'_>) -> AgentCommand {
            command(&self.script)
        }
        fn parse(&self, stdout: &str) -> Result<serde_json::Value, String> {
            let value: serde_json::Value =
                serde_json::from_str(stdout).map_err(|err| err.to_string())?;
            value
                .get("structured_output")
                .cloned()
                .ok_or_else(|| "no structured output".to_owned())
        }
    }

    /// `/bin/sh <script>`, or the bare path when there is no script — which
    /// is how a missing binary looks to the runner.
    fn command(script: &str) -> AgentCommand {
        if Path::new(script).exists() {
            AgentCommand::new("/bin/sh", [script])
        } else {
            AgentCommand::new(script, Vec::<String>::new())
        }
    }

    /// The script is run by `/bin/sh` rather than executed itself: executing
    /// a file just written races any other test thread sitting between `fork`
    /// and `exec` with it still open, and loses with ETXTBSY
    /// (`adapter::fake` has the long version).
    fn fake(dir: &Path, body: &str) -> FakeDriver {
        let script = dir.join("fake-agent");
        fs::write(&script, format!("#!/bin/sh\n{body}\n")).expect("write the fake");
        FakeDriver {
            script: script.display().to_string(),
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    #[test]
    fn a_driver_without_structured_output_cannot_advise() {
        assert!(advisor_unavailable(&OpencodeDriver)
            .expect("opencode cannot advise")
            .contains("cannot answer structured requests"));
    }

    #[test]
    fn a_driver_whose_binary_is_missing_says_which_one() {
        // Whether `claude` happens to be installed on the machine running the
        // suite is not something a test may depend on, so only the shape of
        // the two answers is asserted.
        match advisor_unavailable(&ClaudeDriver) {
            None => assert!(on_path("claude")),
            Some(reason) => assert_eq!(reason, "`claude` is not installed"),
        }
    }

    #[test]
    fn on_path_finds_a_command_in_a_search_directory() {
        let dir = TempDir::new().expect("temp dir");
        let driver = fake(dir.path(), "true");
        assert!(on_path_in("fake-agent", &dir.path().display().to_string()));
        assert!(!on_path_in(
            "nothing-like-this",
            &dir.path().display().to_string()
        ));
        // An absolute path is tested as a file, not searched for.
        assert!(on_path_in(&driver.script, ""));
        assert!(!on_path_in("/nonexistent-xyz/agent", ""));
    }

    #[test]
    fn runs_the_command_and_parses_its_stdout() {
        let dir = TempDir::new().expect("temp dir");
        let driver = fake(
            dir.path(),
            r#"echo '{"structured_output":{"followUps":[],"upcoming":[]}}'"#,
        );
        assert_eq!(advisor_unavailable(&driver), None);

        let value = runtime()
            .block_on(run_structured(
                &driver,
                dir.path(),
                "p",
                &serde_json::json!({}),
                StructuredOptions::default(),
            ))
            .expect("the fake answers");
        assert_eq!(
            value,
            serde_json::json!({ "followUps": [], "upcoming": [] })
        );
    }

    #[test]
    fn a_driver_that_fails_surfaces_its_first_line_of_stderr() {
        let dir = TempDir::new().expect("temp dir");
        let driver = fake(dir.path(), "echo 'out of credit' >&2\nexit 1");
        let err = runtime()
            .block_on(run_structured(
                &driver,
                dir.path(),
                "p",
                &serde_json::json!({}),
                StructuredOptions::default(),
            ))
            .expect_err("a failing driver");
        assert_eq!(err, "out of credit");
    }

    #[test]
    fn a_driver_that_never_answers_is_abandoned_rather_than_waited_for() {
        let dir = TempDir::new().expect("temp dir");
        // A shell that starts something and waits, which is the shape of every
        // real agent: the grandchild is what a naive kill leaves behind.
        let marker = dir.path().join("still-running");
        let driver = fake(
            dir.path(),
            &format!("sh -c 'sleep 30; : > {}' &\nwait", marker.display()),
        );
        let err = runtime()
            .block_on(run_structured(
                &driver,
                dir.path(),
                "p",
                &serde_json::json!({}),
                StructuredOptions {
                    timeout: Some(Duration::from_millis(150)),
                    ..StructuredOptions::default()
                },
            ))
            .expect_err("the timeout fires");
        assert!(err.contains("did not answer within"), "{err}");

        // And nothing it started is still running. `kill_on_drop` reaches the
        // direct child only, so without a process group of its own the `sleep`
        // would outlive the whole test suite.
        assert!(
            no_survivors(dir.path()),
            "the abandoned advisor left a process behind"
        );
    }

    #[test]
    fn a_request_dropped_mid_way_takes_everything_it_started_with_it() {
        let dir = TempDir::new().expect("temp dir");
        let marker = dir.path().join("still-running");
        let driver = fake(
            dir.path(),
            &format!("sh -c 'sleep 30; : > {}' &\nwait", marker.display()),
        );
        let rt = runtime();
        let schema = serde_json::json!({});
        rt.block_on(async {
            let request = run_structured(
                &driver,
                dir.path(),
                "p",
                &schema,
                StructuredOptions::default(),
            );
            // Abandoned while it runs: what the TUI does to a request when
            // the developer quits.
            let _ = tokio::time::timeout(Duration::from_millis(150), request).await;
        });
        assert!(
            no_survivors(dir.path()),
            "the dropped request left a process behind"
        );
    }

    /// Whether every process the fake started is gone.
    ///
    /// The fake writes its marker only if it runs to completion, so a marker
    /// that never appears is the assertion passing. Waiting the full sleep
    /// would make the test take 30s; waiting a beat and checking the process
    /// table directly is both faster and more direct.
    fn no_survivors(dir: &Path) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let listing = std::process::Command::new("ps")
                .args(["-eo", "args"])
                .output()
                .expect("ps");
            let text = String::from_utf8_lossy(&listing.stdout);
            if !text.contains(&dir.display().to_string()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn a_driver_ask_reaches_the_registry_and_says_why_it_cannot_answer() {
        // Neither of these runs anything: opencode has no structured mode,
        // and an unknown driver is refused before a command is built.
        let dir = TempDir::new().expect("temp dir");
        let ask = driver_ask("opencode", dir.path(), StructuredOptions::default());
        let err = runtime()
            .block_on(ask("p".to_owned(), serde_json::json!({})))
            .expect_err("opencode cannot advise");
        assert_eq!(err, "opencode cannot advise");

        let ask = driver_ask("nope", dir.path(), StructuredOptions::default());
        let err = runtime()
            .block_on(ask("p".to_owned(), serde_json::json!({})))
            .expect_err("no such driver");
        assert!(err.contains("Unknown agent driver 'nope'"), "{err}");
    }

    #[test]
    fn a_driver_ask_outside_a_runtime_is_an_error_not_a_panic() {
        let dir = TempDir::new().expect("temp dir");
        let ask = driver_ask("claude", dir.path(), StructuredOptions::default());
        // Polled by a runtime with no handle of its own entered: the
        // future itself is run on a bare executor thread.
        let err = std::thread::spawn(move || {
            let waker = std::task::Waker::noop();
            let mut cx = std::task::Context::from_waker(waker);
            let mut fut = ask("p".to_owned(), serde_json::json!({}));
            match fut.as_mut().poll(&mut cx) {
                std::task::Poll::Ready(result) => result,
                std::task::Poll::Pending => Ok(serde_json::Value::Null),
            }
        })
        .join()
        .expect("thread");
        assert_eq!(err, Err("no runtime to ask the model on".to_owned()));
    }

    #[test]
    fn a_missing_binary_is_named_rather_than_reported_as_a_missing_file() {
        let dir = TempDir::new().expect("temp dir");
        let driver = FakeDriver {
            script: dir.path().join("never-written").display().to_string(),
        };
        let err = runtime()
            .block_on(run_structured(
                &driver,
                dir.path(),
                "p",
                &serde_json::json!({}),
                StructuredOptions::default(),
            ))
            .expect_err("nothing to run");
        assert!(err.contains("is not installed"), "{err}");
    }
}
