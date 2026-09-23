//! An in-memory [`Ports`], for driving the whole TUI by keystroke in tests.
//!
//! The TypeScript `test/support/app-harness.tsx`, ported: OpenSpec and the
//! agents are stubbed at the port boundary, while the Foundation is real
//! files in a temp dir — so what the guided setup reads and writes is the
//! real thing, and only the subprocesses are pretend.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tempfile::TempDir;
use tokio::sync::oneshot;

use super::ports::{jobs_view, JobsView, PortFuture, Ports, Snapshot};
use crate::adapter::types::{OpenSpecArtifact, OpenSpecArtifactStatus, OpenSpecChangeStatus};
use crate::core::foundation::{guided_questions, scaffold_foundation, GuidedQuestion};
use crate::core::guide::{project_stage, ProjectStage};
use crate::core::jobs::{Job, JobStatus};
use crate::core::pipeline::{build_pipeline, ChangePipeline, ReviewByArtifact};
use crate::core::roadmap::{load_roadmap, Roadmap};
use crate::core::session::ReviewSession;
use crate::core::vision::is_greenfield;

const ORDER: [&str; 4] = ["proposal", "specs", "design", "tasks"];

/// A change whose artifacts in `written` exist, the next one ready.
pub fn change_with(name: &str, written: &[&str]) -> ChangePipeline {
    let artifacts = ORDER
        .iter()
        .enumerate()
        .map(|(i, id)| OpenSpecArtifact {
            id: (*id).to_owned(),
            status: if written.contains(id) {
                OpenSpecArtifactStatus::Done
            } else if i == 0 || written.contains(&ORDER[i - 1]) {
                OpenSpecArtifactStatus::Ready
            } else {
                OpenSpecArtifactStatus::Blocked
            },
            requires: if i == 0 {
                Vec::new()
            } else {
                vec![ORDER[i - 1].to_owned()]
            },
            output_path: if *id == "specs" {
                "specs/**/*.md".to_owned()
            } else {
                format!("{id}.md")
            },
        })
        .collect();
    build_pipeline(
        &OpenSpecChangeStatus {
            change_name: name.to_owned(),
            schema_name: "spec-tacular".to_owned(),
            change_root: format!("/tmp/{name}"),
            apply_requires: vec!["tasks".to_owned()],
            artifacts,
            ..OpenSpecChangeStatus::default()
        },
        &ReviewByArtifact::new(),
    )
}

/// A job record, as the runner would have written it.
pub fn job(id: &str, change: &str, artifact: &str, status: JobStatus) -> Job {
    Job {
        id: id.to_owned(),
        change: change.to_owned(),
        artifact: artifact.to_owned(),
        driver: "claude".to_owned(),
        command: "claude".to_owned(),
        args: Vec::new(),
        cwd: "/p".to_owned(),
        status,
        started_at: "2026-09-21T10:00:00.000Z".to_owned(),
        ended_at: None,
        exit_code: None,
        pid: None,
        log_path: "/dev/null".to_owned(),
    }
}

/// How the fake answers a request for better names.
pub enum Names {
    /// No model: the instant name is all there is.
    None,
    Now(Vec<String>),
    /// Held until the test sends them — for a proposal that arrives late.
    Later(oneshot::Receiver<Vec<String>>),
}

/// See the module docs.
pub struct FakePorts {
    dir: TempDir,
    pub changes: Mutex<Vec<ChangePipeline>>,
    pub created: Mutex<Vec<(String, String)>>,
    pub dispatched: Mutex<Vec<String>>,
    pub jobs: Mutex<Vec<Job>>,
    pub cancelled: Mutex<Vec<String>>,
    /// Log lines per job id; a job with none has "no output yet".
    pub tails: Mutex<BTreeMap<String, Vec<String>>>,
    pub names: Mutex<Names>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl FakePorts {
    /// An empty folder — nothing set up.
    pub fn new() -> Self {
        Self {
            dir: TempDir::new().expect("temp dir"),
            changes: Mutex::default(),
            created: Mutex::default(),
            dispatched: Mutex::default(),
            jobs: Mutex::default(),
            cancelled: Mutex::default(),
            tails: Mutex::default(),
            names: Mutex::new(Names::None),
        }
    }

    /// An existing project: it has baseline specs, so no vision step.
    pub fn with_baseline() -> Self {
        let fake = Self::new();
        let specs = fake.root().join("openspec/specs/existing");
        fs::create_dir_all(&specs).expect("specs");
        fs::write(specs.join("spec.md"), "# Existing\n").expect("spec");
        fake
    }

    pub fn path(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    /// Answers every ground-rule question, as the developer would in their
    /// editor.
    pub fn settle_ground_rules(&self) {
        for question in guided_questions(self.dir.path()) {
            crate::core::foundation::answer_foundation(&question.item, "Decided.").expect("answer");
        }
    }

    pub fn add_change(&self, pipeline: ChangePipeline) {
        lock(&self.changes).push(pipeline);
    }

    pub fn add_job(&self, job: Job, tail: &[&str]) {
        lock(&self.tails).insert(
            job.id.clone(),
            tail.iter().map(|l| (*l).to_owned()).collect(),
        );
        lock(&self.jobs).push(job);
    }

    pub fn set_job_status(&self, id: &str, status: JobStatus) {
        for job in lock(&self.jobs).iter_mut().filter(|j| j.id == id) {
            job.status = status;
        }
    }

    pub fn dispatched(&self) -> Vec<String> {
        lock(&self.dispatched).clone()
    }

    pub fn created(&self) -> Vec<(String, String)> {
        lock(&self.created).clone()
    }

    pub fn cancelled(&self) -> Vec<String> {
        lock(&self.cancelled).clone()
    }
}

impl Ports for FakePorts {
    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn reload(&self) -> PortFuture<Result<Snapshot, String>> {
        let pipelines = lock(&self.changes).clone();
        Box::pin(async move {
            Ok(Snapshot {
                pipelines,
                failed: Vec::new(),
            })
        })
    }

    fn read_jobs(&self, selected: usize, change: Option<&str>) -> PortFuture<JobsView> {
        let tails = lock(&self.tails).clone();
        let view = jobs_view(
            lock(&self.jobs).clone(),
            |job| tails.get(&job.id).cloned().unwrap_or_default(),
            selected,
            change,
        );
        Box::pin(async move { view })
    }

    fn cancel_job(&self, job: &Job) {
        lock(&self.cancelled).push(job.id.clone());
        self.set_job_status(&job.id, JobStatus::Cancelled);
    }

    fn prune_jobs(&self) -> usize {
        let mut jobs = lock(&self.jobs);
        let before = jobs.len();
        jobs.retain(|j| j.status == JobStatus::Running);
        before - jobs.len()
    }

    fn dispatch(&self, change: &str, artifact: &str) -> PortFuture<Result<String, String>> {
        lock(&self.dispatched).push(format!("{change}/{artifact}"));
        let id = format!("job-{}", lock(&self.jobs).len() + 1);
        self.add_job(
            job(&id, change, artifact, JobStatus::Running),
            &[
                &format!("working on {artifact}…"),
                "reading the ground rules",
            ],
        );
        let message = format!("drafting {change}/{artifact}");
        Box::pin(async move { Ok(message) })
    }

    fn open_review(&self, _change: &str) -> Option<ReviewSession> {
        None
    }

    fn stage(&self) -> ProjectStage {
        project_stage(self.dir.path(), lock(&self.changes).len())
    }

    fn greenfield(&self) -> bool {
        is_greenfield(self.dir.path())
    }

    fn roadmap(&self) -> Option<Roadmap> {
        load_roadmap(self.dir.path())
    }

    fn questions(&self) -> Vec<GuidedQuestion> {
        guided_questions(self.dir.path())
    }

    fn setup(&self) -> PortFuture<Result<(), String>> {
        let root = self.path();
        Box::pin(async move {
            fs::create_dir_all(root.join("openspec/changes")).map_err(|e| e.to_string())?;
            scaffold_foundation(&root)
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }

    fn create_change(&self, name: &str, description: &str) -> PortFuture<Result<(), String>> {
        self.add_change(change_with(name, &[]));
        lock(&self.created).push((name.to_owned(), description.to_owned()));
        Box::pin(async { Ok(()) })
    }

    fn artifact_file(&self, _change: &str, _artifact: &str) -> PortFuture<Result<PathBuf, String>> {
        Box::pin(async { Err("not in this test".to_owned()) })
    }

    fn propose_names(
        &self,
        _description: &str,
        _taken: &[String],
    ) -> Option<PortFuture<Vec<String>>> {
        let names = std::mem::replace(&mut *lock(&self.names), Names::None);
        match names {
            Names::None => None,
            Names::Now(names) => {
                *lock(&self.names) = Names::Now(names.clone());
                Some(Box::pin(async move { names }))
            }
            Names::Later(rx) => Some(Box::pin(async move { rx.await.unwrap_or_default() })),
        }
    }
}
