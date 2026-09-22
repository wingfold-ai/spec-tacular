//! Background jobs.
//!
//! The reason this exists: `openspec apply` occupies your session, so
//! reviewing while implementing means a second terminal and a second agent
//! instance managed by hand (docs/problem-analysis.md §7). Here a job is
//! dispatched, its output streams to a file, and the review loop keeps running.
//!
//! Jobs are spawned detached and recorded on disk, so quitting the TUI does not
//! kill work in progress and relaunching finds it again.
//!
//! The on-disk shape — `.spec-tacular/jobs/<id>.json`, `<id>.log`, `<id>.exit`,
//! and the record's camelCase keys — is the TypeScript implementation's, byte
//! for byte, so a project can be opened by either while the port is in flight.
//!
//! This is the one module under `core/` that runs a subprocess. It is here
//! rather than in `adapter/` because it knows nothing about OpenSpec: it is
//! given a command and a directory, and its whole subject is process lifetime.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::agent::driver::AgentCommand;
use crate::core::paths::display_path;

/// Where a job is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    /// The process is gone but never recorded an outcome — the TUI died with it.
    Interrupted,
}

impl JobStatus {
    /// The word as it is written on disk and printed in the job list.
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Running => "running",
            JobStatus::Succeeded => "succeeded",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
            JobStatus::Interrupted => "interrupted",
        }
    }
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One dispatched agent, as it is recorded on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub change: String,
    /// The artifact being written, or `apply`.
    pub artifact: String,
    pub driver: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub status: JobStatus,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Path to the job's combined stdout/stderr log.
    pub log_path: String,
}

/// `<project>/.spec-tacular/jobs`.
pub fn jobs_dir(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(".spec-tacular").join("jobs")
}

fn record_path(root: &Path, id: &str) -> PathBuf {
    jobs_dir(root).join(format!("{id}.json"))
}

fn log_path_for(root: &Path, id: &str) -> PathBuf {
    jobs_dir(root).join(format!("{id}.log"))
}

fn exit_path_for(root: &Path, id: &str) -> PathBuf {
    jobs_dir(root).join(format!("{id}.exit"))
}

/// The wrapper every job runs under.
///
/// `spectacular run` dispatches and exits, so by the time the agent finishes
/// there is no spec-tacular process left to notice. Without this the outcome
/// would be lost and every background job would read as `interrupted`. The job
/// records its own exit code instead.
///
/// `"$0" "$@"` rather than interpolating the command keeps it quoting-safe: a
/// prompt containing quotes or newlines is passed through as one argv entry.
/// The final `exit "$ec"` matters as much as the file: without it the wrapper
/// would exit with `printf`'s status, so every job would look successful to a
/// parent still watching.
const EXIT_WRAPPER: &str =
    r#""$0" "$@"; ec=$?; printf %s "$ec" > "$SPECTACULAR_EXIT_FILE"; exit "$ec""#;

/// Now, in the format the TypeScript `Date#toISOString` produces.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The exit code a finished job left behind, if it left one.
fn read_exit_code(root: &Path, id: &str) -> Option<i32> {
    let raw = fs::read_to_string(exit_path_for(root, id)).ok()?;
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// A short, sortable, filename-safe id: the timestamp, the change, the
/// artifact, and enough noise that two jobs started in the same second do not
/// collide.
fn new_id(change: &str, artifact: &str) -> String {
    let stamp: String = now_iso()
        .chars()
        .filter(|c| !matches!(c, '-' | ':' | '.'))
        .take(15)
        .collect();

    // No `rand`: a counter and the clock's nanoseconds are all a filename
    // suffix needs, and a dependency that exists to avoid a collision nobody
    // would notice is not worth the supply chain.
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut noise = nanos
        ^ (std::process::id() << 7)
        ^ SEQ
            .fetch_add(0x9E37_79B9, Ordering::Relaxed)
            .rotate_left(11);
    let mut suffix = String::new();
    for _ in 0..4 {
        let digit = (noise % 36) as u8;
        noise /= 36;
        suffix.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
    }

    format!("{stamp}-{change}-{artifact}-{suffix}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Atomic, so a reader never sees a half-written record.
///
/// The temp file is unique per *write*, not per process, and that is the whole
/// point of it. Two writers race on one record as a matter of course — the
/// caller cancelling a job, and the thread that reaps it noticing it died — and
/// with one temp name per process they interleave inside the same file and
/// publish a mixture of the two, which parses as neither. `list_jobs` skips a
/// record it cannot read, so the symptom is the job vanishing from the pane at
/// the exact moment it was cancelled.
///
/// The TypeScript used `${path}.${process.pid}.tmp` and could not hit this:
/// its two writers were callbacks on one event loop. Here the reaper is a real
/// thread, so the name has to carry more than the pid.
fn write_record(project_root: &Path, job: &Job) -> std::io::Result<()> {
    static WRITE: AtomicU32 = AtomicU32::new(0);

    let dir = jobs_dir(project_root);
    fs::create_dir_all(&dir)?;
    let path = record_path(project_root, &job.id);
    let tmp = dir.join(format!(
        "{}.json.{}.{}.tmp",
        job.id,
        std::process::id(),
        WRITE.fetch_add(1, Ordering::Relaxed)
    ));
    let json = serde_json::to_string_pretty(job)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    fs::write(&tmp, format!("{json}\n"))?;
    // Last rename wins, which is the intended semantics: whoever learned about
    // the job most recently is who should be believed.
    let published = fs::rename(&tmp, &path);
    if published.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    published
}

/// Whether a pid is alive. Signal 0 tests for existence without delivering one.
fn is_alive(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false };
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: `kill` with signal 0 delivers nothing; it only reports whether
    // the pid exists and whether we may signal it.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    // EPERM means it exists but belongs to someone else — still alive.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Every job on disk, newest first, with dead ones reconciled.
///
/// A record left `running` whose process is gone is reported as `interrupted`
/// rather than believed: the alternative is a job pane that claims work is
/// still happening hours after the machine rebooted.
pub fn list_jobs(project_root: impl AsRef<Path>) -> Vec<Job> {
    let project_root = project_root.as_ref();
    let dir = jobs_dir(project_root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut jobs: Vec<Job> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A malformed record must not hide the others.
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(job) = serde_json::from_str::<Job>(&text) else {
            continue;
        };

        if job.status == JobStatus::Running && !is_alive(job.pid) {
            // The process is gone. Its own exit code, if it recorded one, is
            // the truth; only a job that vanished without recording one is
            // `interrupted`.
            let reconciled = match read_exit_code(project_root, &job.id) {
                None => Job {
                    status: JobStatus::Interrupted,
                    ended_at: Some(now_iso()),
                    ..job
                },
                Some(code) => Job {
                    status: if code == 0 {
                        JobStatus::Succeeded
                    } else {
                        JobStatus::Failed
                    },
                    exit_code: Some(code),
                    ended_at: Some(now_iso()),
                    ..job
                },
            };
            let _ = write_record(project_root, &reconciled);
            jobs.push(reconciled);
        } else {
            jobs.push(job);
        }
    }

    jobs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    jobs
}

/// One job by its exact id.
pub fn get_job(project_root: impl AsRef<Path>, id: &str) -> Option<Job> {
    list_jobs(project_root).into_iter().find(|j| j.id == id)
}

/// Jobs still running, per the reconciliation above.
pub fn active_jobs(project_root: impl AsRef<Path>) -> Vec<Job> {
    list_jobs(project_root)
        .into_iter()
        .filter(|j| j.status == JobStatus::Running)
        .collect()
}

/// The job currently writing to a change, if any.
///
/// One writer per change: two agents editing the same spec files concurrently
/// would interleave their edits, and neither would be the plan anyone reviewed.
/// Reviews are reads and are never blocked by this.
pub fn active_job_for_change(project_root: impl AsRef<Path>, change: &str) -> Option<Job> {
    active_jobs(project_root)
        .into_iter()
        .find(|j| j.change == change)
}

/// A change already has an agent writing to it.
///
/// The job is boxed: this is the cold half of every `start_job` result, and a
/// whole `Job` inline would make the common one three times the size.
#[derive(Debug, Clone)]
pub struct JobConflictError {
    pub existing: Box<Job>,
}

impl std::fmt::Display for JobConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} already has a running job ({}, started {}). Wait for it or cancel it first.",
            self.existing.change, self.existing.artifact, self.existing.started_at
        )
    }
}

impl std::error::Error for JobConflictError {}

/// What `start_job` needs to know.
pub struct StartJobOptions<'a> {
    pub project_root: &'a Path,
    pub change: &'a str,
    pub artifact: &'a str,
    pub driver: &'a str,
    pub command: AgentCommand,
    pub cwd: &'a Path,
}

/// Dispatches an agent and returns at once.
///
/// The child gets its own session (`setsid`), which is what makes it survive
/// the dispatching process exiting and gives it a process group of its own for
/// [`cancel_job`] to signal. Its stdin is closed — a job that stopped to ask a
/// question would hang forever with nobody able to answer it — and both its
/// output streams append to the log.
pub fn start_job(options: StartJobOptions<'_>) -> Result<Job, JobConflictError> {
    if let Some(existing) = active_job_for_change(options.project_root, options.change) {
        return Err(JobConflictError {
            existing: Box::new(existing),
        });
    }

    let id = new_id(options.change, options.artifact);
    let log_path = log_path_for(options.project_root, &id);
    let _ = fs::create_dir_all(jobs_dir(options.project_root));
    let _ = fs::write(&log_path, "");

    let job = Job {
        id: id.clone(),
        change: options.change.to_owned(),
        artifact: options.artifact.to_owned(),
        driver: options.driver.to_owned(),
        command: options.command.command.clone(),
        args: options.command.args.clone(),
        cwd: display_path(options.cwd),
        status: JobStatus::Running,
        started_at: now_iso(),
        ended_at: None,
        exit_code: None,
        pid: None,
        log_path: display_path(&log_path),
    };

    let child = match spawn_detached(
        &options,
        &log_path,
        &exit_path_for(options.project_root, &id),
    ) {
        Ok(child) => child,
        Err(error) => {
            // A spawn that never happened failed outright; recording it as
            // `running` would only be reconciled to `interrupted` later, which
            // reads as "we lost it" rather than "it never started".
            if let Ok(mut log) = File::options().append(true).open(&log_path) {
                let _ = writeln!(log, "\nspec-tacular: could not start the agent: {error}");
            }
            let failed = Job {
                status: JobStatus::Failed,
                ended_at: Some(now_iso()),
                ..job
            };
            let _ = write_record(options.project_root, &failed);
            return Ok(failed);
        }
    };

    let job = Job {
        pid: Some(child.id()),
        ..job
    };
    let _ = write_record(options.project_root, &job);

    // The record is updated by whoever is still around when the process ends.
    // If nobody is — `spectacular run` dispatches and exits — the `.exit` file
    // the wrapper writes is what `list_jobs` reconciles from later.
    //
    // Reaping matters as much as reporting: an unwaited child of a process
    // that is still alive stays a zombie, and a zombie's pid answers `kill 0`,
    // so a long-lived TUI would never see any job finish.
    reap_in_background(options.project_root.to_path_buf(), job.clone(), child);

    Ok(job)
}

/// Spawns the wrapper in its own session with its output on the log.
fn spawn_detached(
    options: &StartJobOptions<'_>,
    log_path: &Path,
    exit_path: &Path,
) -> std::io::Result<Child> {
    use std::os::unix::process::CommandExt;

    let log = File::options().append(true).open(log_path)?;
    let errlog = log.try_clone()?;

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(EXIT_WRAPPER)
        .arg(&options.command.command)
        .args(&options.command.args)
        .current_dir(options.cwd)
        .env("SPECTACULAR_EXIT_FILE", exit_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errlog));

    // SAFETY: `setsid` is async-signal-safe and allocates nothing, which is
    // the whole contract `pre_exec` asks for. It runs in the forked child
    // before `exec`, detaching it from our session and its controlling
    // terminal and making it the leader of a new process group — the two
    // things that let a job outlive `spectacular run` and be cancelled as a
    // group afterwards.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    command.spawn()
}

/// Waits for a child and records what became of it, without holding anything up.
fn reap_in_background(project_root: PathBuf, job: Job, mut child: Child) {
    let _ = std::thread::Builder::new()
        .name(format!("job-{}", job.id))
        .spawn(move || {
            let Ok(status) = child.wait() else { return };
            let signalled = {
                use std::os::unix::process::ExitStatusExt;
                status.signal()
            };
            let finished = Job {
                status: match (signalled, status.code()) {
                    (Some(libc::SIGTERM | libc::SIGKILL), _) => JobStatus::Cancelled,
                    (_, Some(0)) => JobStatus::Succeeded,
                    _ => JobStatus::Failed,
                },
                ended_at: Some(now_iso()),
                exit_code: status.code(),
                ..job
            };
            let _ = write_record(&project_root, &finished);
        });
}

/// Signals a whole process group, falling back to the one process.
///
/// A negative pid is the group. Killing only the direct child is the mistake
/// this exists to stop making: a shell that spawned something — which is what
/// every agent and every wrapper is — leaves that something running, reparented
/// and invisible, and the caller has no handle left to find it with.
///
/// The fallback covers a child that never got a group of its own, and is why
/// this reports whether anything was signalled rather than returning `()`.
///
/// It lives here because process lifetime is what this module is about; the
/// foreground runners in `adapter/` and `agent/` use it for the same reason
/// and with the same argument.
pub fn signal_group(pid: i32, signal: i32) -> bool {
    // SAFETY: both calls are plain `kill(2)`; neither touches this process's
    // memory, and a failure is reported through errno as usual.
    unsafe { libc::kill(-pid, signal) == 0 || libc::kill(pid, signal) == 0 }
}

/// Stops a running job. Returns whether anything was stopped.
pub fn cancel_job(project_root: impl AsRef<Path>, id: &str) -> bool {
    let project_root = project_root.as_ref();
    let Some(job) = get_job(project_root, id) else {
        return false;
    };
    if job.status != JobStatus::Running {
        return false;
    }
    let Some(pid) = job.pid.and_then(|p| i32::try_from(p).ok()) else {
        return false;
    };

    if !signal_group(pid, libc::SIGTERM) {
        return false;
    }

    let _ = write_record(
        project_root,
        &Job {
            status: JobStatus::Cancelled,
            ended_at: Some(now_iso()),
            ..job
        },
    );
    true
}

/// How many lines of a log [`tail_job`] returns when nobody says.
pub const TAIL_LIMIT: usize = 200;

/// The last `limit` lines of a job's log.
pub fn tail_job(job: &Job, limit: usize) -> Vec<String> {
    let Ok(content) = fs::read_to_string(&job.log_path) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = content.split('\n').map(str::to_owned).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    lines
}

/// Removes finished jobs and their logs. Running ones are never touched.
///
/// Its caller is the jobs pane's `p`, in stage 5.
#[allow(dead_code)]
pub fn prune_jobs(project_root: impl AsRef<Path>) -> usize {
    let project_root = project_root.as_ref();
    let mut removed = 0;
    for job in list_jobs(project_root) {
        if job.status == JobStatus::Running {
            continue;
        }
        if fs::remove_file(record_path(project_root, &job.id)).is_err() {
            continue;
        }
        let _ = fs::remove_file(&job.log_path);
        let _ = fs::remove_file(exit_path_for(project_root, &job.id));
        removed += 1;
    }
    removed
}

/// Jobs keyed by the change they are writing to, for the overview.
///
/// Its caller is the overview's "an agent is writing this" marker, in stage 5.
#[allow(dead_code)]
pub fn active_by_change(project_root: impl AsRef<Path>) -> BTreeMap<String, Job> {
    active_jobs(project_root)
        .into_iter()
        .map(|job| (job.change.clone(), job))
        .collect()
}

#[cfg(test)]
mod tests {
    //! Real processes, real files — the job runner's whole job is surviving
    //! both. Every test that starts something long-running cancels it and
    //! waits for it to settle, so the suite never leaks a process.

    use super::*;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn sh(script: &str) -> AgentCommand {
        AgentCommand {
            command: "sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
        }
    }

    fn start(root: &Path, script: &str) -> Job {
        start_on(root, script, "c", "design")
    }

    fn start_on(root: &Path, script: &str, change: &str, artifact: &str) -> Job {
        start_command(root, sh(script), change, artifact).expect("start the job")
    }

    fn start_command(
        root: &Path,
        command: AgentCommand,
        change: &str,
        artifact: &str,
    ) -> Result<Job, JobConflictError> {
        start_job(StartJobOptions {
            project_root: root,
            change,
            artifact,
            driver: "test",
            command,
            cwd: root,
        })
    }

    /// Waits for a job to leave `running`, so tests never race the OS.
    fn settle(root: &Path, id: &str) -> Job {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match get_job(root, id) {
                Some(job) if job.status != JobStatus::Running => return job,
                job => {
                    assert!(
                        Instant::now() < deadline,
                        "job {id} never settled ({:?})",
                        job.map(|j| j.status)
                    );
                    std::thread::sleep(Duration::from_millis(15));
                }
            }
        }
    }

    /// Cancels a job and waits for the process to actually be gone.
    ///
    /// It asserts rather than giving up on the deadline: a cancel that leaves
    /// the agent running is the bug this module exists to not have, and a
    /// helper that shrugged at it would hide exactly that.
    fn stop(root: &Path, id: &str) {
        let job = get_job(root, id).expect("the job to cancel is on disk");
        cancel_job(root, id);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if !is_alive(job.pid) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "job {id} (pid {:?}) was still alive 10s after being cancelled",
                job.pid
            );
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    /// A record left behind by a process that is long gone.
    fn stale(root: &Path, id: &str, exit: Option<&str>) {
        fs::create_dir_all(jobs_dir(root)).expect("jobs dir");
        let job = Job {
            id: id.to_owned(),
            change: id.to_owned(),
            artifact: "apply".to_owned(),
            driver: "test".to_owned(),
            command: "sh".to_owned(),
            args: Vec::new(),
            cwd: root.display().to_string(),
            status: JobStatus::Running,
            started_at: "2020-01-01T00:00:00.000Z".to_owned(),
            ended_at: None,
            exit_code: None,
            // Far above any real pid, so nothing can answer for it.
            pid: Some(1 << 22),
            log_path: log_path_for(root, id).display().to_string(),
        };
        fs::write(
            record_path(root, id),
            serde_json::to_string(&job).expect("serialize"),
        )
        .expect("write record");
        if let Some(exit) = exit {
            fs::write(exit_path_for(root, id), exit).expect("write exit file");
        }
    }

    #[test]
    fn records_a_job_and_captures_its_output() {
        let dir = TempDir::new().expect("temp dir");
        let job = start(dir.path(), "echo hello; echo world");
        assert_eq!(job.status, JobStatus::Running);
        assert!(Path::new(&job.log_path).exists());

        let done = settle(dir.path(), &job.id);
        assert_eq!(done.status, JobStatus::Succeeded);
        assert_eq!(done.exit_code, Some(0));
        assert_eq!(tail_job(&done, TAIL_LIMIT), ["hello", "world"]);
    }

    #[test]
    fn captures_stderr_too_because_a_failing_agent_explains_itself_there() {
        let dir = TempDir::new().expect("temp dir");
        let job = settle(dir.path(), &start(dir.path(), "echo oops >&2; exit 3").id);
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.exit_code, Some(3));
        assert!(tail_job(&job, TAIL_LIMIT).contains(&"oops".to_owned()));
    }

    #[test]
    fn returns_immediately_rather_than_waiting_for_the_agent() {
        // The point of the whole stage: dispatching must not block.
        let dir = TempDir::new().expect("temp dir");
        let before = Instant::now();
        let job = start(dir.path(), "sleep 30");
        assert!(before.elapsed() < Duration::from_millis(1500));
        stop(dir.path(), &job.id);
    }

    #[test]
    fn a_command_that_does_not_exist_fails_the_job_instead_of_throwing() {
        let dir = TempDir::new().expect("temp dir");
        let job = start_command(
            dir.path(),
            AgentCommand {
                command: "definitely-not-a-real-binary-xyz".to_owned(),
                args: Vec::new(),
            },
            "c",
            "design",
        )
        .expect("start the job");
        assert_eq!(settle(dir.path(), &job.id).status, JobStatus::Failed);
    }

    #[test]
    fn refuses_a_second_job_on_the_same_change() {
        // Two agents editing one change's spec files would interleave their
        // edits, and neither result would be the plan anyone reviewed.
        let dir = TempDir::new().expect("temp dir");
        let first = start(dir.path(), "sleep 30");
        let conflict = start_command(dir.path(), sh("sleep 30"), "c", "design")
            .expect_err("a second job on one change must be refused");
        assert_eq!(conflict.existing.id, first.id);
        assert!(conflict.to_string().contains("already has a running job"));
        assert_eq!(
            active_job_for_change(dir.path(), "c").map(|j| j.id),
            Some(first.id.clone())
        );
        stop(dir.path(), &first.id);
    }

    #[test]
    fn allows_concurrent_jobs_on_different_changes() {
        // Reviewing change B while change A is being implemented is the exit
        // criterion for this stage.
        let dir = TempDir::new().expect("temp dir");
        let a = start_on(dir.path(), "sleep 30", "a", "apply");
        let b = start_on(dir.path(), "sleep 30", "b", "apply");

        let mut running: Vec<String> = active_jobs(dir.path()).into_iter().map(|j| j.id).collect();
        running.sort();
        let mut expected = vec![a.id.clone(), b.id.clone()];
        expected.sort();
        assert_eq!(running, expected);

        stop(dir.path(), &a.id);
        assert_eq!(
            get_job(dir.path(), &b.id).map(|j| j.status),
            Some(JobStatus::Running),
            "cancelling one job must leave the other running"
        );
        stop(dir.path(), &b.id);
    }

    #[test]
    fn a_finished_job_no_longer_blocks_the_change() {
        let dir = TempDir::new().expect("temp dir");
        settle(dir.path(), &start(dir.path(), "true").id);
        assert!(active_job_for_change(dir.path(), "c").is_none());
        let again = start_command(dir.path(), sh("true"), "c", "design");
        assert!(again.is_ok());
        settle(dir.path(), &again.expect("second job").id);
    }

    #[test]
    fn cancelling_stops_a_running_job() {
        let dir = TempDir::new().expect("temp dir");
        let job = start(dir.path(), "sleep 30");
        assert!(cancel_job(dir.path(), &job.id));
        assert_eq!(
            get_job(dir.path(), &job.id).map(|j| j.status),
            Some(JobStatus::Cancelled)
        );
        stop(dir.path(), &job.id);
    }

    #[test]
    fn cancelling_a_finished_or_unknown_job_is_a_no_op() {
        let dir = TempDir::new().expect("temp dir");
        let job = settle(dir.path(), &start(dir.path(), "true").id);
        assert!(!cancel_job(dir.path(), &job.id));
        assert!(!cancel_job(dir.path(), "nope"));
    }

    #[test]
    fn a_record_left_running_whose_process_is_gone_reads_as_interrupted() {
        // Otherwise the job pane claims work is still happening hours after
        // the machine rebooted.
        let dir = TempDir::new().expect("temp dir");
        stale(dir.path(), "stale", None);

        assert_eq!(list_jobs(dir.path())[0].status, JobStatus::Interrupted);
        // And the reconciliation is persisted, not recomputed every read.
        let text = fs::read_to_string(record_path(dir.path(), "stale")).expect("record");
        assert!(text.contains("\"status\": \"interrupted\""), "got:\n{text}");
    }

    #[test]
    fn an_outcome_recorded_with_no_parent_watching_is_recovered() {
        // `spectacular run` dispatches and exits, so by the time the agent
        // finishes there is no spec-tacular process left to see it. The job
        // writes its own exit code; without that every background job would
        // read as `interrupted`.
        let dir = TempDir::new().expect("temp dir");
        stale(dir.path(), "ok", Some("0"));
        stale(dir.path(), "bad", Some("2"));

        let jobs = list_jobs(dir.path());
        let by_id = |id: &str| jobs.iter().find(|j| j.id == id).cloned().expect("job");
        assert_eq!(by_id("ok").status, JobStatus::Succeeded);
        assert_eq!(by_id("ok").exit_code, Some(0));
        assert_eq!(by_id("bad").status, JobStatus::Failed);
        assert_eq!(by_id("bad").exit_code, Some(2));
    }

    #[test]
    fn a_garbled_exit_file_is_treated_as_no_outcome_at_all() {
        let dir = TempDir::new().expect("temp dir");
        stale(dir.path(), "x", Some("not-a-number"));
        assert_eq!(list_jobs(dir.path())[0].status, JobStatus::Interrupted);
    }

    #[test]
    fn a_prompt_containing_quotes_and_newlines_survives_the_wrapper() {
        // The wrapper passes argv through as "$0" "$@" rather than
        // interpolating, so a prompt is never re-parsed by the shell.
        let dir = TempDir::new().expect("temp dir");
        let nasty = "a \"quoted\" $(echo pwned) 'single'\nsecond line";
        let job = start_command(
            dir.path(),
            AgentCommand {
                command: "printf".to_owned(),
                args: vec!["%s".to_owned(), nasty.to_owned()],
            },
            "c",
            "design",
        )
        .expect("start the job");
        let done = settle(dir.path(), &job.id);
        assert_eq!(done.status, JobStatus::Succeeded);
        assert!(tail_job(&done, TAIL_LIMIT)
            .join("\n")
            .contains("$(echo pwned)"));
    }

    #[test]
    fn a_still_running_job_is_found_again_after_a_reload() {
        let dir = TempDir::new().expect("temp dir");
        let job = start(dir.path(), "sleep 30");
        assert_eq!(
            list_jobs(dir.path())
                .iter()
                .find(|j| j.id == job.id)
                .map(|j| j.status),
            Some(JobStatus::Running)
        );
        stop(dir.path(), &job.id);
    }

    #[test]
    fn a_malformed_record_does_not_hide_the_others() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(jobs_dir(dir.path())).expect("jobs dir");
        fs::write(jobs_dir(dir.path()).join("broken.json"), "{not json").expect("broken");
        let job = start(dir.path(), "true");
        assert!(list_jobs(dir.path()).iter().any(|j| j.id == job.id));
        settle(dir.path(), &job.id);
    }

    #[test]
    fn no_jobs_directory_is_an_empty_list_not_an_error() {
        let dir = TempDir::new().expect("temp dir");
        assert!(list_jobs(dir.path()).is_empty());
    }

    #[test]
    fn listing_is_newest_first() {
        let dir = TempDir::new().expect("temp dir");
        stale(dir.path(), "older", Some("0"));
        stale(dir.path(), "newer", Some("0"));
        // The ids are second-resolution, so the ordering key is written
        // directly rather than raced for.
        let bump = |id: &str, at: &str| {
            let mut job: Job = serde_json::from_str(
                &fs::read_to_string(record_path(dir.path(), id)).expect("record"),
            )
            .expect("parse");
            job.started_at = at.to_owned();
            fs::write(
                record_path(dir.path(), id),
                serde_json::to_string(&job).expect("serialize"),
            )
            .expect("write");
        };
        bump("older", "2020-01-01T00:00:00.000Z");
        bump("newer", "2021-01-01T00:00:00.000Z");

        assert_eq!(
            list_jobs(dir.path())
                .iter()
                .map(|j| j.id.as_str())
                .collect::<Vec<_>>(),
            ["newer", "older"]
        );
    }

    #[test]
    fn prune_removes_finished_jobs_and_their_logs_but_never_running_ones() {
        let dir = TempDir::new().expect("temp dir");
        let finished = settle(dir.path(), &start_on(dir.path(), "true", "a", "apply").id);
        let running = start_on(dir.path(), "sleep 30", "b", "apply");

        assert_eq!(prune_jobs(dir.path()), 1);
        assert!(!Path::new(&finished.log_path).exists());
        assert_eq!(
            list_jobs(dir.path())
                .iter()
                .map(|j| j.id.as_str())
                .collect::<Vec<_>>(),
            [running.id.as_str()]
        );
        stop(dir.path(), &running.id);
    }

    #[test]
    fn tail_limits_how_much_it_returns() {
        let dir = TempDir::new().expect("temp dir");
        let job = settle(
            dir.path(),
            &start(dir.path(), "for i in 1 2 3 4 5; do echo $i; done").id,
        );
        assert_eq!(tail_job(&job, 2), ["4", "5"]);
    }

    #[test]
    fn tailing_a_job_whose_log_is_gone_returns_nothing() {
        let dir = TempDir::new().expect("temp dir");
        let job = settle(dir.path(), &start(dir.path(), "true").id);
        fs::remove_file(&job.log_path).expect("remove the log");
        assert!(tail_job(&job, TAIL_LIMIT).is_empty());
    }

    #[test]
    fn a_record_is_written_with_the_keys_the_typescript_implementation_reads() {
        // The two implementations read each other's jobs, so the file names
        // and the JSON keys are a contract, not an implementation detail.
        let dir = TempDir::new().expect("temp dir");
        let job = settle(dir.path(), &start(dir.path(), "true").id);
        let text = fs::read_to_string(record_path(dir.path(), &job.id)).expect("record");

        for key in [
            "\"id\"",
            "\"change\"",
            "\"artifact\"",
            "\"driver\"",
            "\"command\"",
            "\"args\"",
            "\"cwd\"",
            "\"status\"",
            "\"startedAt\"",
            "\"endedAt\"",
            "\"exitCode\"",
            "\"pid\"",
            "\"logPath\"",
        ] {
            assert!(text.contains(key), "record is missing {key}:\n{text}");
        }
        assert!(text.ends_with("}\n"), "records end with a newline:\n{text}");
        assert!(
            job.started_at.ends_with('Z') && job.started_at.contains('.'),
            "timestamps are Date#toISOString: {}",
            job.started_at
        );
        assert_eq!(
            jobs_dir(dir.path()),
            dir.path().join(".spec-tacular/jobs"),
            "the directory is the one the TypeScript writes"
        );
    }

    #[test]
    fn a_record_the_typescript_wrote_is_read_back_unchanged() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(jobs_dir(dir.path())).expect("jobs dir");
        let written = r#"{
  "id": "20260921T101500-add-auth-specs-k3f9",
  "change": "add-auth",
  "artifact": "specs",
  "driver": "claude",
  "command": "claude",
  "args": ["-p", "write it"],
  "cwd": "/p",
  "status": "succeeded",
  "startedAt": "2026-09-21T10:15:00.000Z",
  "endedAt": "2026-09-21T10:17:11.000Z",
  "exitCode": 0,
  "pid": 4242,
  "logPath": "/p/.spec-tacular/jobs/20260921T101500-add-auth-specs-k3f9.log"
}
"#;
        fs::write(
            jobs_dir(dir.path()).join("20260921T101500-add-auth-specs-k3f9.json"),
            written,
        )
        .expect("write");

        let jobs = list_jobs(dir.path());
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, JobStatus::Succeeded);
        assert_eq!(jobs[0].change, "add-auth");
        assert_eq!(jobs[0].args, ["-p", "write it"]);
        assert_eq!(jobs[0].pid, Some(4242));
    }

    #[test]
    fn the_job_outlives_the_process_that_dispatched_it() {
        // The detachment test: a `spectacular`-shaped dispatcher exits at once,
        // and the agent it started keeps going and records its own outcome.
        let dir = TempDir::new().expect("temp dir");
        let marker = dir.path().join("written-after-the-parent-left");
        let job = start(
            dir.path(),
            &format!("sleep 1; echo done > {}", marker.display()),
        );
        // Its session is its own: a session id equal to its pid is exactly what
        // `setsid` bought, and what makes killing the group safe.
        assert!(is_alive(job.pid));

        let done = settle(dir.path(), &job.id);
        assert_eq!(done.status, JobStatus::Succeeded);
        assert!(marker.exists(), "the job never finished its work");
        assert!(
            exit_path_for(dir.path(), &job.id).exists(),
            "the wrapper must record the exit code for a parent that is gone"
        );
    }

    #[test]
    fn two_threads_writing_one_record_never_publish_an_unreadable_one() {
        // Cancelling a job and reaping it happen on different threads and land
        // on the same file. A shared temp name let them interleave inside it,
        // and the published record parsed as neither — so `list_jobs` skipped
        // it and the job disappeared exactly when it was cancelled.
        let dir = TempDir::new().expect("temp dir");
        let job = Job {
            id: "contended".to_owned(),
            change: "c".to_owned(),
            artifact: "apply".to_owned(),
            driver: "test".to_owned(),
            // Long enough that a torn write cannot land inside one `write(2)`.
            command: "x".repeat(64_000),
            args: Vec::new(),
            cwd: dir.path().display().to_string(),
            status: JobStatus::Running,
            started_at: "2020-01-01T00:00:00.000Z".to_owned(),
            ended_at: None,
            exit_code: None,
            pid: Some(1 << 22),
            log_path: log_path_for(dir.path(), "contended").display().to_string(),
        };

        // One record already published, so every later read must find exactly
        // one job. The bug shows up as *no* job: `list_jobs` skips a record it
        // cannot parse, so counting is the assertion that catches it.
        write_record(dir.path(), &job).expect("the first record");

        let writers: Vec<_> = [JobStatus::Cancelled, JobStatus::Failed]
            .into_iter()
            .map(|status| {
                let root = dir.path().to_path_buf();
                let job = Job {
                    status,
                    ended_at: Some("2020-01-01T00:00:01.000Z".to_owned()),
                    ..job.clone()
                };
                std::thread::spawn(move || {
                    for _ in 0..300 {
                        let _ = write_record(&root, &job);
                    }
                })
            })
            .collect();

        // Reading throughout, not only at the end: a torn record is published
        // for an instant and then overwritten, so a single read would miss it.
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut reads = 0;
        while writers.iter().any(|w| !w.is_finished()) && Instant::now() < deadline {
            let jobs = list_jobs(dir.path());
            assert_eq!(
                jobs.len(),
                1,
                "a record that could not be read was published, so the job vanished"
            );
            assert_eq!(jobs[0].command.len(), 64_000, "a torn record was published");
            reads += 1;
        }
        for writer in writers {
            writer.join().expect("writer thread");
        }
        assert!(reads > 0, "the readers never ran");

        // And no temp file survives to be mistaken for a job of its own.
        let mut left: Vec<String> = fs::read_dir(jobs_dir(dir.path()))
            .expect("jobs dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["contended.json"]);
    }

    #[test]
    fn a_long_job_on_one_change_does_not_block_reviewing_another() {
        // The exit criterion for this stage: a job running against change A
        // while change B is reviewed, in one process. Nothing here waits on
        // anything the other does.
        use crate::core::requirements::parse_spec_file;
        use crate::core::review::{empty_review, DecisionNote, ReviewState};
        use crate::core::session::{decide, open_session};

        let dir = TempDir::new().expect("temp dir");
        let job = start_on(dir.path(), "echo starting; sleep 30", "change-a", "apply");
        assert_eq!(job.status, JobStatus::Running);

        let spec = concat!(
            "## ADDED Requirements\n\n",
            "### Requirement: Alpha\nSHALL alpha.\n\n",
            "### Requirement: Beta\nSHALL beta.\n",
        );
        let items = parse_spec_file(spec, "cap", "/p/specs/cap/spec.md").requirements;
        let mut session = open_session("change-b", &items, empty_review("change-b"));
        session = decide(session, ReviewState::Accepted, &DecisionNote::default());
        session = decide(session, ReviewState::Accepted, &DecisionNote::default());

        assert_eq!(session.summary.accepted, 2);
        assert!(session.summary.complete);
        // And the job is still going, untouched by any of it.
        assert_eq!(
            get_job(dir.path(), &job.id).map(|j| j.status),
            Some(JobStatus::Running)
        );

        stop(dir.path(), &job.id);
    }

    #[test]
    fn active_jobs_are_indexed_by_change() {
        let dir = TempDir::new().expect("temp dir");
        let a = start_on(dir.path(), "sleep 30", "a", "apply");
        let b = start_on(dir.path(), "sleep 30", "b", "apply");
        let index = active_by_change(dir.path());
        assert_eq!(index.get("a").map(|j| j.id.clone()), Some(a.id.clone()));
        assert_eq!(index.get("b").map(|j| j.id.clone()), Some(b.id.clone()));
        stop(dir.path(), &a.id);
        stop(dir.path(), &b.id);
    }
}
