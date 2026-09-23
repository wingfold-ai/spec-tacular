//! An ACP session drafting one change, recorded as jobs.
//!
//! [`AcpRun`] is what the TUI holds: an [`AcpSession`] plus the bookkeeping
//! that makes an interactive run look like any other agent work from the
//! outside. Each turn — the first draft, every redraft on the same session —
//! is recorded as a job (driver `acp`) under `.spec-tacular/jobs/`, with the
//! events rendered into its log as they arrive, so the job pane and
//! `spectacular jobs` list it, and one writer per change holds across the
//! detached and the interactive paths alike.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::mpsc;

use super::client::AcpSession;
use super::events::{log_line, AcpEvent, ChoiceKind, PermissionChoice, Stop, ToolLog};
use crate::agent::driver::AgentCommand;
use crate::core::jobs::{
    active_job_for_change, record_job, Job, JobRecorder, JobStatus, RecordJobOptions,
};

/// The driver id ACP turns are recorded under.
pub const ACP_DRIVER: &str = "acp";

/// What starting a run needs.
#[derive(Debug, Clone)]
pub struct StartRun {
    pub root: PathBuf,
    pub change: String,
    pub artifact: String,
    pub command: AgentCommand,
    /// The first turn's prompt.
    pub prompt: String,
}

/// How starting a run went.
#[derive(Debug)]
pub enum RunStart {
    /// The agent is working on the first turn.
    Started(AcpRun),
    /// Not started, for a reason the developer must act on: a gate, or
    /// another agent already writing to the change.
    Refused(String),
    /// The ACP agent could not be started or would not open a session; the
    /// work can still go to a detached job.
    Unavailable(String),
}

/// The turn being recorded, and what its log is waiting to write.
struct Turn {
    recorder: Option<JobRecorder>,
    job: Job,
    /// Reply text not yet ended by a newline.
    partial: String,
    /// The last turn's job, finished — for whoever reloads after it.
    finished: bool,
    /// The session's cost so far, as last reported.
    cost: Option<String>,
    /// The turn's tool calls, as its log has told them so far.
    tools: ToolLog,
}

struct Inner {
    session: AcpSession,
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<AcpEvent>>,
    root: PathBuf,
    change: String,
    command: AgentCommand,
    turn: Mutex<Option<Turn>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A live ACP session on one change. Cheap to clone; see the module docs.
#[derive(Clone)]
pub struct AcpRun {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for AcpRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpRun")
            .field("change", &self.inner.change)
            .field("session", &self.inner.session)
            .finish()
    }
}

/// Records a turn's job, off the calling thread.
async fn record(
    root: &Path,
    change: &str,
    artifact: &str,
    command: &AgentCommand,
    pid: Option<u32>,
    follows: Option<String>,
) -> Result<Job, String> {
    let root = root.to_path_buf();
    let change = change.to_owned();
    let artifact = artifact.to_owned();
    let command = command.clone();
    tokio::task::spawn_blocking(move || {
        record_job(RecordJobOptions {
            project_root: &root,
            change: &change,
            artifact: &artifact,
            driver: ACP_DRIVER,
            command,
            cwd: &root,
            pid,
            follows: follows.as_deref(),
        })
        .map_err(|conflict| conflict.to_string())
    })
    .await
    .unwrap_or_else(|_| Err("could not record the job".to_owned()))
}

impl AcpRun {
    /// Starts the agent, opens a session in the project, records the first
    /// turn as a job and sends its prompt.
    pub async fn start(options: StartRun) -> RunStart {
        // One writer per change, checked before an agent is even started.
        let root = options.root.clone();
        let change = options.change.clone();
        let busy = tokio::task::spawn_blocking(move || active_job_for_change(&root, &change))
            .await
            .ok()
            .flatten();
        if let Some(existing) = busy {
            return RunStart::Refused(format!(
                "{} already has a running job ({}, started {}). Wait for it or cancel it first.",
                existing.change, existing.artifact, existing.started_at
            ));
        }

        let (session, events) = match AcpSession::start(&options.command, &options.root).await {
            Ok(started) => started,
            Err(why) => return RunStart::Unavailable(why),
        };
        let run = AcpRun {
            inner: Arc::new(Inner {
                session,
                events: tokio::sync::Mutex::new(events),
                root: options.root,
                change: options.change,
                command: options.command,
                turn: Mutex::new(None),
            }),
        };
        match run.turn(&options.artifact, options.prompt).await {
            Ok(()) => RunStart::Started(run),
            Err(why) => {
                run.close();
                RunStart::Refused(why)
            }
        }
    }

    /// Records a turn and sends its prompt.
    async fn turn(&self, artifact: &str, prompt: String) -> Result<(), String> {
        let inner = &self.inner;
        let job = record(
            &inner.root,
            &inner.change,
            artifact,
            &inner.command,
            inner.session.pid(),
            self.job().map(|j| j.id),
        )
        .await?;
        let recorder = JobRecorder::new(&inner.root, job.clone());
        recorder.line(format!(
            "spec-tacular: {} over ACP, session {}",
            inner.session.agent(),
            inner.session.session_id()
        ));
        *lock(&inner.turn) = Some(Turn {
            recorder: Some(recorder),
            job,
            partial: String::new(),
            finished: false,
            cost: None,
            tools: ToolLog::default(),
        });
        inner.session.prompt(prompt)
    }

    /// Another turn on the same session: the redraft, with the feedback as
    /// its prompt. Refused while a turn is running or once the agent is gone.
    pub async fn follow_up(&self, artifact: &str, prompt: String) -> Result<(), String> {
        if !self.inner.session.is_alive() {
            return Err("the agent's session has ended".to_owned());
        }
        if self.turn_running() {
            return Err("the agent is still working".to_owned());
        }
        self.turn(artifact, prompt).await
    }

    /// The next event, recorded in the current turn's log first. `None` once
    /// the agent is gone and everything it said has been read.
    pub async fn next(&self) -> Option<AcpEvent> {
        let event = self.inner.events.lock().await.recv().await?;
        self.note(&event);
        Some(event)
    }

    /// Writes an event to the turn's log, and finishes the turn's record
    /// when the turn ends — or when the agent does.
    fn note(&self, event: &AcpEvent) {
        let mut slot = lock(&self.inner.turn);
        let Some(turn) = slot.as_mut() else {
            return;
        };
        let Some(recorder) = turn.recorder.as_ref() else {
            return;
        };
        match event {
            AcpEvent::Text(text) => {
                turn.partial.push_str(text);
                while let Some(end) = turn.partial.find('\n') {
                    let line: String = turn.partial.drain(..=end).collect();
                    let line = line.trim_end();
                    if !line.is_empty() {
                        recorder.line(line);
                    }
                }
                return;
            }
            AcpEvent::Thought(_) => return,
            AcpEvent::Cost(cost) => {
                turn.cost = Some(cost.clone());
                return;
            }
            _ => {}
        }
        let rest = std::mem::take(&mut turn.partial);
        if !rest.trim().is_empty() {
            recorder.line(rest.trim_end());
        }
        match event {
            AcpEvent::Tool(update) => {
                if let Some(line) = turn.tools.line(update) {
                    recorder.line(line);
                }
                return;
            }
            AcpEvent::Permission(ask) => {
                let what = ask
                    .tool
                    .title
                    .as_deref()
                    .or_else(|| turn.tools.title(&ask.tool.id))
                    .unwrap_or(&ask.tool.id);
                recorder.line(format!("? permission asked: {what}"));
                return;
            }
            _ => {}
        }
        if matches!(event, AcpEvent::TurnEnded(_) | AcpEvent::Closed(_)) {
            if let Some(cost) = turn.cost.take() {
                recorder.line(format!("cost: {cost} for the session so far"));
            }
        }
        if let Some(line) = log_line(event) {
            recorder.line(line);
        }
        let status = match event {
            AcpEvent::TurnEnded(Stop::EndTurn) => JobStatus::Succeeded,
            AcpEvent::TurnEnded(Stop::Cancelled) => JobStatus::Cancelled,
            AcpEvent::TurnEnded(_) | AcpEvent::Closed(Some(_)) => JobStatus::Failed,
            AcpEvent::Closed(None) => JobStatus::Cancelled,
            _ => return,
        };
        if let Some(recorder) = turn.recorder.take() {
            recorder.finish(status);
        }
        turn.job.status = status;
        turn.finished = true;
    }

    /// Answers permission request `id` with `choice`, or as cancelled, and
    /// says so in the log.
    pub fn answer(&self, id: u64, choice: Option<&PermissionChoice>) -> bool {
        let answered = self.inner.session.answer(id, choice.map(|c| c.id.as_str()));
        if answered {
            let what = choice.map_or("cancelled", |c| match c.kind {
                ChoiceKind::AllowOnce => "allowed once",
                ChoiceKind::AllowAlways => "allowed always",
                ChoiceKind::RejectOnce => "denied",
                ChoiceKind::RejectAlways => "denied always",
            });
            if let Some(recorder) = lock(&self.inner.turn)
                .as_ref()
                .and_then(|t| t.recorder.as_ref())
            {
                recorder.line(format!("→ {what}"));
            }
        }
        answered
    }

    /// Asks the agent to stop the turn.
    pub fn cancel(&self) {
        if let Some(recorder) = lock(&self.inner.turn)
            .as_ref()
            .and_then(|t| t.recorder.as_ref())
        {
            recorder.line("spec-tacular: cancel requested");
        }
        self.inner.session.cancel();
    }

    /// Ends the session and kills the agent. A turn still running is
    /// recorded as cancelled.
    pub fn close(&self) {
        self.inner.session.close();
    }

    /// Whether a turn is in progress.
    pub fn turn_running(&self) -> bool {
        lock(&self.inner.turn).as_ref().is_some_and(|t| !t.finished)
    }

    /// The current (or last) turn's job, with its outcome once it has one.
    pub fn job(&self) -> Option<Job> {
        lock(&self.inner.turn).as_ref().map(|t| t.job.clone())
    }

    /// The agent's id for the session — the same on every turn.
    pub fn session_id(&self) -> &str {
        self.inner.session.session_id()
    }

    /// The agent process, the leader of its group.
    #[cfg(test)]
    pub fn pid(&self) -> Option<u32> {
        self.inner.session.pid()
    }

    /// Whether the session can take another prompt.
    pub fn is_alive(&self) -> bool {
        self.inner.session.is_alive()
    }
}

#[cfg(test)]
mod tests {
    //! Against the scripted agent, a real child process: the client, the
    //! permission round trip, cancel, the second turn on one session, the
    //! job records, and the process group going away.

    use super::*;
    use crate::agent::acp::events::ToolCallView;
    use crate::agent::acp::fake_agent;
    use crate::core::jobs::{flush_recorders, list_jobs, tail_job};
    use std::time::Duration;
    use tempfile::TempDir;

    const TARGET: &str = "openspec/changes/book-rooms/proposal.md";

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    fn options(dir: &TempDir, script: &str) -> StartRun {
        let record = dir.path().join("agent.log");
        StartRun {
            root: dir.path().to_path_buf(),
            change: "book-rooms".to_owned(),
            artifact: "proposal".to_owned(),
            command: fake_agent(&[
                "--script",
                script,
                "--record",
                &record.display().to_string(),
            ]),
            prompt: format!("Draft the proposal.\nwrite: {TARGET}\n"),
        }
    }

    fn started(start: RunStart) -> AcpRun {
        match start {
            RunStart::Started(run) => run,
            other => panic!("the fake agent did not start: {other:?}"),
        }
    }

    /// Events until one matches `until`, which is returned last.
    async fn until(run: &AcpRun, until: impl Fn(&AcpEvent) -> bool) -> Vec<AcpEvent> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(10), run.next())
                .await
                .unwrap_or_else(|_| panic!("timed out; so far: {seen:?}"))
                .unwrap_or_else(|| panic!("the stream ended; so far: {seen:?}"));
            let done = until(&event);
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    fn permission(events: &[AcpEvent]) -> PermissionAsk {
        events
            .iter()
            .find_map(|e| match e {
                AcpEvent::Permission(ask) => Some(ask.clone()),
                _ => None,
            })
            .expect("a permission request")
    }

    fn agent_log(dir: &TempDir) -> String {
        fs::read_to_string(dir.path().join("agent.log")).unwrap_or_default()
    }

    fn gone(pid: Option<u32>) -> bool {
        let pid = i32::try_from(pid.expect("a pid")).expect("pid");
        for _ in 0..100 {
            // SAFETY: signal 0 only asks whether the process exists.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    use super::super::events::PermissionAsk;
    use std::fs;

    #[test]
    fn a_turn_streams_asks_writes_when_allowed_and_is_recorded_as_a_job() {
        let dir = TempDir::new().expect("dir");
        let rt = runtime();
        let pid = rt.block_on(async {
            let run = started(AcpRun::start(options(&dir, "draft")).await);
            let events = until(&run, |e| matches!(e, AcpEvent::Permission(_))).await;
            assert!(events.contains(&AcpEvent::Text("Reading the ground rules.\n".to_owned())));
            assert!(events
                .iter()
                .any(|e| matches!(e, AcpEvent::Plan(p) if p.len() == 2)));
            let tool = events
                .iter()
                .find_map(|e| match e {
                    AcpEvent::Tool(t) => Some(ToolCallView::new(t)),
                    _ => None,
                })
                .expect("a tool call");
            assert_eq!(tool.diffs[0].summary(), "± proposal.md +9 −0");
            let ask = permission(&events);
            let asked = ToolCallView::new(&ask.tool);
            assert_eq!(asked.intent(), format!("write {TARGET}"));
            assert_eq!(ask.choices[0].kind, ChoiceKind::AllowOnce);
            assert!(
                !dir.path().join(TARGET).exists(),
                "written before it was allowed"
            );
            assert!(run.turn_running());

            assert!(run.answer(ask.id, Some(&ask.choices[0])));
            let rest = until(&run, |e| matches!(e, AcpEvent::TurnEnded(_))).await;
            assert_eq!(rest.last(), Some(&AcpEvent::TurnEnded(Stop::EndTurn)));
            assert!(!run.turn_running());
            assert_eq!(run.job().map(|j| j.status), Some(JobStatus::Succeeded));
            run.pid()
        });
        assert!(fs::read_to_string(dir.path().join(TARGET))
            .expect("written")
            .contains("Drafted over ACP."));

        flush_recorders();
        let jobs = list_jobs(dir.path());
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].driver, "acp");
        assert_eq!(jobs[0].status, JobStatus::Succeeded);
        let log = tail_job(&jobs[0], 100).join("\n");
        assert!(log.contains("Reading the ground rules."), "{log}");
        assert!(log.contains("? permission asked: Write"), "{log}");
        assert!(log.contains("→ allowed once"), "{log}");
        assert!(log.contains("± proposal.md +9 −0"), "{log}");
        assert!(log.ends_with("done"), "{log}");

        drop(rt);
        assert!(gone(pid), "the agent outlived its session");
    }

    #[test]
    fn a_denied_write_is_not_written_and_the_turn_still_ends() {
        let dir = TempDir::new().expect("dir");
        runtime().block_on(async {
            let run = started(AcpRun::start(options(&dir, "draft")).await);
            let ask = permission(&until(&run, |e| matches!(e, AcpEvent::Permission(_))).await);
            let deny = ask
                .choices
                .iter()
                .find(|c| !c.kind.allows())
                .expect("a deny option");
            run.answer(ask.id, Some(deny));
            let rest = until(&run, |e| matches!(e, AcpEvent::TurnEnded(_))).await;
            assert!(rest.iter().any(
                |e| matches!(e, AcpEvent::Tool(t) if t.state == Some(super::super::events::ToolState::Failed))
            ));
        });
        assert!(!dir.path().join(TARGET).exists());
        assert!(agent_log(&dir).contains("permission reject_once"));
    }

    #[test]
    fn cancel_ends_the_turn_as_cancelled_and_records_it() {
        let dir = TempDir::new().expect("dir");
        runtime().block_on(async {
            let run = started(AcpRun::start(options(&dir, "slow")).await);
            until(&run, |e| matches!(e, AcpEvent::Text(_))).await;
            run.cancel();
            let rest = until(&run, |e| matches!(e, AcpEvent::TurnEnded(_))).await;
            assert_eq!(rest.last(), Some(&AcpEvent::TurnEnded(Stop::Cancelled)));
        });
        flush_recorders();
        assert_eq!(list_jobs(dir.path())[0].status, JobStatus::Cancelled);
        assert!(agent_log(&dir).contains("cancel fake-session-"));
    }

    #[test]
    fn a_follow_up_is_a_second_prompt_on_the_same_session() {
        let dir = TempDir::new().expect("dir");
        runtime().block_on(async {
            let run = started(AcpRun::start(options(&dir, "draft")).await);
            let ask = permission(&until(&run, |e| matches!(e, AcpEvent::Permission(_))).await);
            // Always: the second turn does not ask again.
            run.answer(ask.id, Some(&ask.choices[1]));
            until(&run, |e| matches!(e, AcpEvent::TurnEnded(_))).await;
            let first = run.job().expect("a job").id;

            run.follow_up(
                "proposal",
                "Revise it.\n\n> mention cancellations\n".to_owned(),
            )
            .await
            .expect("a second turn");
            let rest = until(&run, |e| matches!(e, AcpEvent::TurnEnded(_))).await;
            assert!(!rest.iter().any(|e| matches!(e, AcpEvent::Permission(_))));
            assert_ne!(run.job().expect("a job").id, first);
        });
        let log = agent_log(&dir);
        let sessions: Vec<&str> = log
            .lines()
            .filter_map(|l| l.strip_prefix("prompt "))
            .map(|l| l.split_once(' ').map_or("", |(_, s)| s))
            .collect();
        assert_eq!(sessions.len(), 2, "{log}");
        assert_eq!(sessions[0], sessions[1], "{log}");
        assert_eq!(log.matches("initialize").count(), 1, "{log}");
        assert!(fs::read_to_string(dir.path().join(TARGET))
            .expect("written")
            .contains("mention cancellations"));
        flush_recorders();
        assert_eq!(list_jobs(dir.path()).len(), 2);
    }

    #[test]
    fn an_agent_that_dies_mid_turn_is_reported_and_recorded_as_failed() {
        let dir = TempDir::new().expect("dir");
        runtime().block_on(async {
            let run = started(AcpRun::start(options(&dir, "crash")).await);
            let events = until(&run, |e| matches!(e, AcpEvent::Closed(_))).await;
            assert!(matches!(events.last(), Some(AcpEvent::Closed(Some(_)))));
            assert!(!run.is_alive());
            assert!(run.follow_up("proposal", "again".to_owned()).await.is_err());
        });
        flush_recorders();
        assert_eq!(list_jobs(dir.path())[0].status, JobStatus::Failed);
    }

    #[test]
    fn a_missing_agent_is_unavailable_and_a_busy_change_is_refused() {
        let dir = TempDir::new().expect("dir");
        let rt = runtime();
        let mut missing = options(&dir, "draft");
        missing.command = AgentCommand::new("no-such-acp-agent", Vec::<String>::new());
        match rt.block_on(AcpRun::start(missing)) {
            RunStart::Unavailable(why) => assert_eq!(why, "`no-such-acp-agent` is not installed"),
            other => panic!("{other:?}"),
        }

        let run = rt.block_on(async { started(AcpRun::start(options(&dir, "slow")).await) });
        match rt.block_on(AcpRun::start(options(&dir, "draft"))) {
            RunStart::Refused(why) => assert!(why.contains("already has a running job"), "{why}"),
            other => panic!("{other:?}"),
        }
        let pid = run.pid();
        run.close();
        drop(run);
        drop(rt);
        assert!(gone(pid));
        flush_recorders();
    }
}
