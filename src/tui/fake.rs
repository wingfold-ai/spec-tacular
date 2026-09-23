//! An in-memory [`Ports`], for driving the whole TUI by keystroke in tests.
//!
//! The TypeScript `test/support/app-harness.tsx`, ported: OpenSpec and the
//! agents are stubbed at the port boundary, while the Foundation is real
//! files in a temp dir — so what the guided setup reads and writes is the
//! real thing, and only the subprocesses are pretend.
//!
//! A change added with [`FakePorts::add_spec_change`] is real files too — a
//! proposal, spec files, a design — with a status pointing at them, the way
//! OpenSpec would have reported it. Its review queue, sidecar, marked
//! examples and promotions go through the same `core` functions the real
//! ports use, against those files; only `openspec status` is pretend.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tempfile::TempDir;
use tokio::sync::oneshot;

use super::ports::{jobs_view, promote, read_document, JobsView, PortFuture, Ports, Snapshot};
use crate::adapter::types::{
    OpenSpecArtifact, OpenSpecArtifactPaths, OpenSpecArtifactStatus, OpenSpecChangeStatus,
};
use crate::core::advisor::{AfterAnswer, Ask, Coached, FoundationAdvisor, Meta};
use crate::core::change_review::{load_change_review, spec_files_of, specs_artifact_id};
use crate::core::concreteness::LintConfig;
use crate::core::decisions::Decision;
use crate::core::foundation::{
    answer_foundation, guided_questions, scaffold_foundation, GuidedQuestion,
};
use crate::core::guide::{project_stage, ProjectStage};
use crate::core::jobs::{Job, JobStatus};
use crate::core::mark::mark_example_in_file;
use crate::core::pipeline::{build_pipeline, ChangePipeline, ReviewByArtifact};
use crate::core::requirements::ReviewItem;
use crate::core::review::save_review;
use crate::core::roadmap::{load_roadmap, Roadmap};
use crate::core::session::{open_session, ReviewSession};
use crate::core::vision::is_greenfield;

const ORDER: [&str; 4] = ["proposal", "specs", "design", "tasks"];

/// A change whose artifacts in `written` exist, the next one ready.
pub fn change_with(name: &str, written: &[&str]) -> ChangePipeline {
    build_pipeline(&status_with(name, written, None), &ReviewByArtifact::new())
}

/// The status OpenSpec would report for [`change_with`] — rooted in `root`,
/// with each artifact's paths, when the change is real files.
fn status_with(name: &str, written: &[&str], root: Option<&Path>) -> OpenSpecChangeStatus {
    let change_root = match root {
        Some(root) => root.join("openspec/changes").join(name),
        None => PathBuf::from(format!("/tmp/{name}")),
    };
    let artifacts: Vec<OpenSpecArtifact> = ORDER
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
    let artifact_paths = artifacts
        .iter()
        .map(|a| {
            let resolved = change_root.join(&a.output_path).display().to_string();
            let existing = if a.id == "specs" {
                spec_files(&change_root.join("specs"))
            } else if Path::new(&resolved).exists() {
                vec![resolved.clone()]
            } else {
                Vec::new()
            };
            (
                a.id.clone(),
                OpenSpecArtifactPaths {
                    output_path: a.output_path.clone(),
                    resolved_output_path: resolved,
                    existing_output_paths: existing,
                },
            )
        })
        .collect();
    OpenSpecChangeStatus {
        change_name: name.to_owned(),
        schema_name: "spec-tacular".to_owned(),
        change_root: change_root.display().to_string(),
        apply_requires: vec!["tasks".to_owned()],
        artifacts,
        artifact_paths,
        ..OpenSpecChangeStatus::default()
    }
}

/// Every `spec.md` under `dir`, as OpenSpec's glob would find them.
fn spec_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(spec_files(&path));
        } else if path.file_name().is_some_and(|n| n == "spec.md") {
            out.push(path.display().to_string());
        }
    }
    out.sort();
    out
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
    /// Changes that are real files: name → the artifacts written.
    pub real: Mutex<BTreeMap<String, Vec<String>>>,
    /// Drafts an agent "wrote", by `change/artifact`.
    pub docs: Mutex<BTreeMap<String, String>>,
    pub lint: LintConfig,
    /// The advisor, with a scripted model behind it; `None` is no advisor.
    pub advisor: Option<FoundationAdvisor>,
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
            real: Mutex::default(),
            docs: Mutex::default(),
            lint: LintConfig::empty(),
            advisor: None,
        }
    }

    /// With an advisor whose model is `ask` — the real `core::advisor`
    /// writing real files, only the model pretend.
    pub fn with_ask(mut self, ask: Ask) -> Self {
        self.advisor = Some(FoundationAdvisor::new(self.path(), ask));
        self
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

    /// A change that is real files: a proposal, one spec file per
    /// `(capability, content)`, and a design when there is one.
    pub fn add_spec_change(&self, name: &str, specs: &[(&str, &str)], design: Option<&str>) {
        let dir = self.dir.path().join("openspec/changes").join(name);
        fs::create_dir_all(&dir).expect("change dir");
        fs::write(
            dir.join("proposal.md"),
            format!("# {name}\n\n## Why\n\nBecause.\n"),
        )
        .expect("proposal");
        for (capability, content) in specs {
            let spec = dir.join("specs").join(capability);
            fs::create_dir_all(&spec).expect("spec dir");
            fs::write(spec.join("spec.md"), content).expect("spec");
        }
        let mut written = vec!["proposal".to_owned(), "specs".to_owned()];
        if let Some(design) = design {
            fs::write(dir.join("design.md"), design).expect("design");
            written.push("design".to_owned());
        }
        lock(&self.real).insert(name.to_owned(), written);
        let pipeline = self.real_pipeline(name).expect("just added");
        lock(&self.changes).push(pipeline);
    }

    /// Copies a directory of spec files in as a change's specs — for a
    /// fixture taken from a real project.
    pub fn add_fixture_change(&self, name: &str, fixture: &Path) {
        let specs = self
            .dir
            .path()
            .join("openspec/changes")
            .join(name)
            .join("specs");
        copy_dir(fixture, &specs);
        self.add_spec_change(name, &[], None);
    }

    fn real_status(&self, name: &str) -> Option<OpenSpecChangeStatus> {
        let written = lock(&self.real).get(name).cloned()?;
        let written: Vec<&str> = written.iter().map(String::as_str).collect();
        Some(status_with(name, &written, Some(self.dir.path())))
    }

    /// A real change's pipeline, its review summary read from the sidecar —
    /// what `commands::load_pipelines` does.
    fn real_pipeline(&self, name: &str) -> Option<ChangePipeline> {
        let status = self.real_status(name)?;
        let mut reviews = ReviewByArtifact::new();
        if let Some(specs) = specs_artifact_id(&status) {
            if !spec_files_of(&status).is_empty() {
                let summary = load_change_review(self.dir.path(), &status, false).summary;
                reviews.insert(specs.to_owned(), summary);
            }
        }
        Some(build_pipeline(&status, &reviews))
    }

    /// Pretends an agent finished writing `artifact` of `change`: its job
    /// succeeds, the draft exists, and the pipeline has moved on.
    pub fn finish_job(&self, change: &str, artifact: &str, content: &str) {
        for job in lock(&self.jobs)
            .iter_mut()
            .filter(|j| j.change == change && j.artifact == artifact)
        {
            if job.status == JobStatus::Running {
                job.status = JobStatus::Succeeded;
            }
        }
        lock(&self.docs).insert(format!("{change}/{artifact}"), content.to_owned());
        let at = ORDER
            .iter()
            .position(|a| *a == artifact)
            .map_or(0, |i| i + 1);
        let written = &ORDER[..at];
        for pipeline in lock(&self.changes).iter_mut().filter(|p| p.name == change) {
            *pipeline = change_with(change, written);
        }
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
        let pipelines = lock(&self.changes)
            .iter()
            .map(|p| self.real_pipeline(&p.name).unwrap_or_else(|| p.clone()))
            .collect();
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

    fn dispatch(
        &self,
        change: &str,
        artifact: &str,
        feedback: Option<&str>,
    ) -> PortFuture<Result<String, String>> {
        lock(&self.dispatched).push(match feedback {
            Some(feedback) => format!("{change}/{artifact} ({feedback})"),
            None => format!("{change}/{artifact}"),
        });
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

    fn open_review(&self, change: &str) -> PortFuture<Option<ReviewSession>> {
        let session = self.real_status(change).and_then(|status| {
            if spec_files_of(&status).is_empty() {
                return None;
            }
            let queue = load_change_review(self.dir.path(), &status, true);
            let items: Vec<ReviewItem> = queue.requirements.into_iter().map(|r| r.item).collect();
            Some(open_session(change, &items, queue.review))
        });
        Box::pin(async move { session })
    }

    fn save_session(&self, session: &ReviewSession) -> Result<(), String> {
        save_review(self.dir.path(), &session.review).map_err(|e| e.to_string())
    }

    fn reparse(&self, change: &str) -> PortFuture<Vec<ReviewItem>> {
        let items = self
            .real_status(change)
            .map(|status| {
                load_change_review(self.dir.path(), &status, true)
                    .requirements
                    .into_iter()
                    .map(|r| r.item)
                    .collect()
            })
            .unwrap_or_default();
        Box::pin(async move { items })
    }

    fn mark_example(
        &self,
        requirement: &ReviewItem,
        value: &str,
    ) -> PortFuture<Result<(), String>> {
        let result = mark_example_in_file(requirement, value).map(|_| ());
        Box::pin(async move { result })
    }

    fn promote(&self, change: &str, decision: &Decision) -> PortFuture<Result<String, String>> {
        let result = promote(self.dir.path(), change, decision);
        Box::pin(async move { result })
    }

    fn lint_config(&self) -> LintConfig {
        self.lint.clone()
    }

    fn read_artifact(
        &self,
        change: &str,
        artifact: &str,
    ) -> PortFuture<Result<(PathBuf, String), String>> {
        let drafted = lock(&self.docs)
            .get(&format!("{change}/{artifact}"))
            .cloned();
        let result = match drafted {
            Some(content) => Ok((
                PathBuf::from(format!("/tmp/{change}/{artifact}.md")),
                content,
            )),
            None => {
                let file = self
                    .real_status(change)
                    .and_then(|s| s.artifact_paths.get(artifact).cloned())
                    .map(|p| p.resolved_output_path)
                    .unwrap_or_default();
                read_document(&file, artifact)
            }
        };
        Box::pin(async move { result })
    }

    fn stage(&self) -> ProjectStage {
        project_stage(self.dir.path(), lock(&self.changes).len())
    }

    fn read_stage(&self) -> PortFuture<ProjectStage> {
        let count = lock(&self.changes).len();
        let root = self.path();
        Box::pin(async move { project_stage(&root, count) })
    }

    fn greenfield(&self) -> bool {
        is_greenfield(self.dir.path())
    }

    fn roadmap(&self) -> Option<Roadmap> {
        load_roadmap(self.dir.path())
    }

    fn questions(&self) -> PortFuture<Vec<GuidedQuestion>> {
        let root = self.path();
        Box::pin(async move { guided_questions(&root) })
    }

    fn answer(&self, question: &GuidedQuestion, text: &str) -> Result<(), String> {
        answer_foundation(&question.item, text)
    }

    fn advisor_note(&self) -> Option<String> {
        self.advisor
            .is_none()
            .then(|| "none in this test".to_owned())
    }

    fn advisor_meta(&self) -> PortFuture<Meta> {
        let advisor = self.advisor.clone();
        Box::pin(async move { advisor.map(|a| a.meta()).unwrap_or_default() })
    }

    fn after_answer(
        &self,
        question: &GuidedQuestion,
        answer: &str,
    ) -> PortFuture<Result<AfterAnswer, String>> {
        let advisor = self.advisor.clone();
        let question = question.clone();
        let answer = answer.to_owned();
        Box::pin(async move {
            match advisor {
                Some(advisor) => advisor.after_answer(&question, &answer).await,
                None => Ok(AfterAnswer::default()),
            }
        })
    }

    fn suggest(&self, question: &GuidedQuestion) -> PortFuture<Result<(), String>> {
        let advisor = self.advisor.clone();
        let question = question.clone();
        Box::pin(async move {
            match advisor {
                Some(advisor) => advisor.suggest(&question).await,
                None => Ok(()),
            }
        })
    }

    fn coach(&self, question: &GuidedQuestion) -> PortFuture<Result<Coached, String>> {
        let advisor = self.advisor.clone();
        let question = question.clone();
        Box::pin(async move {
            match advisor {
                Some(advisor) => advisor.coach(&question).await,
                None => Ok(Coached::default()),
            }
        })
    }

    fn dismiss(&self, question: &GuidedQuestion) -> PortFuture<bool> {
        let removed = self.advisor.as_ref().is_some_and(|a| a.dismiss(question));
        Box::pin(async move { removed })
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

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("fixture dir");
    for entry in fs::read_dir(from).expect("fixture").flatten() {
        let path = entry.path();
        let target = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            fs::copy(&path, &target).expect("fixture file");
        }
    }
}
