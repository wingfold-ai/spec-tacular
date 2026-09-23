//! Everything the TUI needs from the world, as one trait.
//!
//! The Rust `TuiInput`. The app never touches OpenSpec, the job runner or the
//! filesystem directly — it asks a [`Ports`], so the whole interface is
//! driven by keystroke in tests against an in-memory [`fake`](super::fake)
//! and against the real project in [`ProjectPorts`].
//!
//! Two kinds of method. The cheap ones — a directory listing, a small file
//! read — answer synchronously, as they did in the TypeScript. The ones that
//! wait on a subprocess return a [`PortFuture`], which the event loop spawns
//! and whose result comes back as a message, so the screen keeps drawing (and
//! ctrl+c keeps working) while OpenSpec thinks.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::adapter::openspec::{is_openspec_project, OpenSpecAdapter};
use crate::adapter::types::OpenSpecChangeStatus;
use crate::agent::default_registry;
use crate::commands::{dispatch, load_pipelines};
use crate::core::advisor::{AfterAnswer, Coached, Meta};
use crate::core::change_review::{load_change_review, spec_files_of};
use crate::core::concreteness::{load_lint_config, LintConfig};
use crate::core::decisions::{promote_decision, replace_decision_body, Decision, PromoteOptions};
use crate::core::foundation::{
    answer_foundation, guided_questions, scaffold_foundation, GuidedQuestion,
};
use crate::core::guide::{project_stage, schema_installed, ProjectStage};
use crate::core::init::init_project;
use crate::core::jobs::{cancel_job, list_jobs, prune_jobs, tail_job, Job, JobStatus, TAIL_LIMIT};
use crate::core::mark::mark_example_in_file;
use crate::core::pipeline::ChangePipeline;
use crate::core::requirements::ReviewItem;
use crate::core::review::save_review;
use crate::core::roadmap::{load_roadmap, Roadmap};
use crate::core::session::{open_session, ReviewSession};
use crate::core::vision::is_greenfield;

/// Work that waits on something slower than a file read.
pub type PortFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// What a reload produces: every change, plus the ones that would not load.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub pipelines: Vec<ChangePipeline>,
    pub failed: Vec<String>,
}

/// What the job pane, the header and the running-agent block draw from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobsView {
    pub jobs: Vec<Job>,
    /// The selected job's log, rendered.
    pub job_lines: Vec<String>,
    /// The last non-blank lines of the agent running on the selected change.
    pub running_lines: Vec<String>,
}

/// Why the real ports have no advisor yet: `core::advisor` is complete, but
/// reaching a model with it — a driver's structured request — is stage 8.
pub const NO_ADVISOR_YET: &str = "not available until stage 8";

/// How many of a running agent's lines the overview shows under its change.
const RUNNING_LINES: usize = 8;

/// A [`JobsView`] from a listing and a way to tail one job — shared by the
/// real ports and the fake, so both pick the selected and the running job the
/// same way.
pub fn jobs_view(
    jobs: Vec<Job>,
    tail: impl Fn(&Job) -> Vec<String>,
    selected: usize,
    change: Option<&str>,
) -> JobsView {
    let job_lines = jobs
        .get(selected.min(jobs.len().saturating_sub(1)))
        .map(&tail)
        .unwrap_or_default();
    let running_lines = change
        .and_then(|change| {
            jobs.iter()
                .find(|j| j.status == JobStatus::Running && j.change == change)
        })
        .map(|job| {
            let lines: Vec<String> = tail(job)
                .into_iter()
                .filter(|l| !l.trim().is_empty())
                .collect();
            lines[lines.len().saturating_sub(RUNNING_LINES)..].to_vec()
        })
        .unwrap_or_default();
    JobsView {
        jobs,
        job_lines,
        running_lines,
    }
}

/// A job's log as the pane shows it: each line through its driver's
/// formatter.
fn rendered_tail(job: &Job) -> Vec<String> {
    let registry = default_registry();
    // A job recorded under a driver this build no longer has is still
    // readable — its log is plain text on disk.
    let driver = registry.get(&job.driver).ok();
    tail_job(job, TAIL_LIMIT)
        .into_iter()
        .filter_map(|line| match driver {
            Some(driver) => driver.format_line(&line),
            None => Some(line),
        })
        .collect()
}

/// The TUI's view of the project. See the module docs.
pub trait Ports: Send + Sync {
    /// The project root, as the header shows it.
    fn root(&self) -> &Path;

    /// Recomputes the overview: after a change is created, an agent finishes,
    /// or anything else that moves the pipeline.
    fn reload(&self) -> PortFuture<Result<Snapshot, String>>;

    /// Background jobs, re-read from disk each time — they record their own
    /// outcome, so an in-memory list goes stale the moment one finishes —
    /// with the log of the job at `selected` and the latest lines of the one
    /// running on `change`. A future because it is file I/O, and the job poll
    /// runs it every two seconds: the real implementation reads on a blocking
    /// thread, never on the one that draws.
    fn read_jobs(&self, selected: usize, change: Option<&str>) -> PortFuture<JobsView>;
    fn cancel_job(&self, job: &Job);
    /// Removes finished jobs and their logs; how many went.
    fn prune_jobs(&self) -> usize;

    /// Starts an agent on one artifact in the background, behind the gate —
    /// with the developer's feedback on the existing draft, for a redraft.
    /// `Ok` and `Err` both carry the line to show.
    fn dispatch(
        &self,
        change: &str,
        artifact: &str,
        feedback: Option<&str>,
    ) -> PortFuture<Result<String, String>>;

    /// Opens a change's review queue — its requirements, then its design
    /// decisions — resuming where the last session stopped. `None` when it
    /// has no specs yet. A future: it reads every spec file of the change.
    fn open_review(&self, change: &str) -> PortFuture<Option<ReviewSession>>;
    /// Persists a session's decisions and cursor. Synchronous on purpose:
    /// every decision is written before the next key is read, in order, so a
    /// crash mid-review loses nothing — and it is one small JSON file.
    fn save_session(&self, session: &ReviewSession) -> Result<(), String>;
    /// Re-parses a change's queue from disk, after the files changed under
    /// the session: an edit, a marked example, a promotion.
    fn reparse(&self, change: &str) -> PortFuture<Vec<ReviewItem>>;
    /// Wraps a flagged value of a requirement in `{{example: …}}`, in its file.
    fn mark_example(&self, requirement: &ReviewItem, value: &str)
        -> PortFuture<Result<(), String>>;
    /// Lifts a global design decision to a project-wide ADR, leaving a
    /// reference in `design.md`. `Ok` carries the ADR's name: `ADR-0001`.
    fn promote(&self, change: &str, decision: &Decision) -> PortFuture<Result<String, String>>;
    /// Per-project linter tuning, read once when the app starts.
    fn lint_config(&self) -> LintConfig;
    /// A written, single-file artifact: its path and its content, for reading
    /// it in full. Specs span a file per capability, so they are refused.
    fn read_artifact(
        &self,
        change: &str,
        artifact: &str,
    ) -> PortFuture<Result<(PathBuf, String), String>>;

    /// Where the project is in getting started, re-derived from disk.
    fn stage(&self) -> ProjectStage;
    /// The same, read off the loop's thread — what the ground rules re-read
    /// after every answer, so the stepper moves on as soon as the last one
    /// is saved.
    fn read_stage(&self) -> PortFuture<ProjectStage>;
    /// Whether the project starts from nothing — no baseline specs yet.
    fn greenfield(&self) -> bool;
    fn roadmap(&self) -> Option<Roadmap>;
    /// The Foundation questions, in the order the setup asks them. A future:
    /// it reads every Foundation file, and the ground-rules screen re-reads
    /// after every answer and every piece of advice.
    fn questions(&self) -> PortFuture<Vec<GuidedQuestion>>;
    /// Writes an answer into its question's section. Synchronous on purpose,
    /// like [`Ports::save_session`]: an answer is a decision, written before
    /// the next key is read, and a refusal (the section moved, the file is
    /// gone) has to keep you on the question with your answer still typed.
    fn answer(&self, question: &GuidedQuestion, text: &str) -> Result<(), String>;

    /// Why there are no AI suggestions, or `None` when there is an advisor.
    /// Read once, when the app starts.
    fn advisor_note(&self) -> Option<String>;
    /// What the advisor remembers about each question, by id.
    fn advisor_meta(&self) -> PortFuture<Meta>;
    /// After an answer is saved: follow-ups on it, options for the next
    /// question, answers that now follow — `core::advisor`'s `after_answer`.
    fn after_answer(
        &self,
        question: &GuidedQuestion,
        answer: &str,
    ) -> PortFuture<Result<AfterAnswer, String>>;
    /// Options for a question on screen that nobody has asked about yet.
    fn suggest(&self, question: &GuidedQuestion) -> PortFuture<Result<(), String>>;
    /// Help with a question the developer cannot answer: an explanation,
    /// examples, and simpler questions put before it.
    fn coach(&self, question: &GuidedQuestion) -> PortFuture<Result<Coached, String>>;
    /// Removes a question the advisor added; whether it was there to remove.
    fn dismiss(&self, question: &GuidedQuestion) -> PortFuture<bool>;

    /// Makes the folder a spec-tacular project: OpenSpec, schema, Foundation.
    fn setup(&self) -> PortFuture<Result<(), String>>;
    fn create_change(&self, name: &str, description: &str) -> PortFuture<Result<(), String>>;
    /// The file to write an artifact in by hand, created from its template if
    /// new.
    fn artifact_file(&self, change: &str, artifact: &str) -> PortFuture<Result<PathBuf, String>>;

    /// Better names for a change than its own words give, best first — the
    /// model-backed half of naming. `None` when there is nothing to ask,
    /// which is always, until the advisor lands in stage 8.
    fn propose_names(
        &self,
        _description: &str,
        _taken: &[String],
    ) -> Option<PortFuture<Vec<String>>> {
        None
    }
}

/// The real thing: OpenSpec through the adapter, jobs on disk, the Foundation
/// in the project's files.
pub struct ProjectPorts {
    root: PathBuf,
    adapter: OpenSpecAdapter,
    driver: String,
    /// OpenSpec's status per change, from the last reload. `stage` counts it
    /// and `artifact_file` looks paths up in it, as the TypeScript did.
    statuses: Arc<Mutex<BTreeMap<String, OpenSpecChangeStatus>>>,
}

impl ProjectPorts {
    pub fn new(root: impl Into<PathBuf>, openspec_bin: Option<PathBuf>, driver: &str) -> Self {
        let root = root.into();
        Self {
            adapter: OpenSpecAdapter::new(&root, openspec_bin),
            root,
            driver: driver.to_owned(),
            statuses: Arc::default(),
        }
    }

    fn statuses(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, OpenSpecChangeStatus>> {
        // A poisoned lock means a reload panicked mid-write; the map it left
        // is still a map, and the next reload replaces it.
        self.statuses
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Ports for ProjectPorts {
    fn root(&self) -> &Path {
        &self.root
    }

    fn reload(&self) -> PortFuture<Result<Snapshot, String>> {
        let adapter = self.adapter.clone();
        let root = self.root.clone();
        let statuses = Arc::clone(&self.statuses);
        Box::pin(async move {
            // Before setup there is nothing to ask OpenSpec about.
            if !is_openspec_project(&root) {
                statuses
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clear();
                return Ok(Snapshot::default());
            }
            let loaded = load_pipelines(&adapter, &root)
                .await
                .map_err(|error| error.describe())?;
            *statuses
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = loaded.statuses;
            Ok(Snapshot {
                pipelines: loaded.pipelines,
                failed: loaded.failed,
            })
        })
    }

    fn read_jobs(&self, selected: usize, change: Option<&str>) -> PortFuture<JobsView> {
        let root = self.root.clone();
        let change = change.map(str::to_owned);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                jobs_view(list_jobs(&root), rendered_tail, selected, change.as_deref())
            })
            .await
            // Only a panic in the read gets here; an empty pane is the
            // honest thing to show for it, and the next poll tries again.
            .unwrap_or_default()
        })
    }

    fn cancel_job(&self, job: &Job) {
        cancel_job(&self.root, &job.id);
    }

    fn prune_jobs(&self) -> usize {
        prune_jobs(&self.root)
    }

    fn dispatch(
        &self,
        change: &str,
        artifact: &str,
        feedback: Option<&str>,
    ) -> PortFuture<Result<String, String>> {
        let adapter = self.adapter.clone();
        let root = self.root.clone();
        let driver = self.driver.clone();
        let change = change.to_owned();
        let artifact = artifact.to_owned();
        let feedback = feedback.map(str::to_owned);
        Box::pin(async move {
            dispatch(
                &adapter,
                &root,
                &change,
                &artifact,
                &driver,
                feedback.as_deref(),
            )
            .await
        })
    }

    fn open_review(&self, change: &str) -> PortFuture<Option<ReviewSession>> {
        let status = self.statuses().get(change).cloned();
        let root = self.root.clone();
        Box::pin(blocking(None, move || {
            let status = status?;
            let queue = queue_for(&root, &status)?;
            let items: Vec<ReviewItem> = queue.requirements.into_iter().map(|r| r.item).collect();
            Some(open_session(&status.change_name, &items, queue.review))
        }))
    }

    fn save_session(&self, session: &ReviewSession) -> Result<(), String> {
        save_review(&self.root, &session.review)
            .map_err(|error| format!("Could not save the review: {error}"))
    }

    fn reparse(&self, change: &str) -> PortFuture<Vec<ReviewItem>> {
        let status = self.statuses().get(change).cloned();
        let root = self.root.clone();
        Box::pin(blocking(Vec::new(), move || {
            status
                .and_then(|status| queue_for(&root, &status))
                .map(|queue| queue.requirements.into_iter().map(|r| r.item).collect())
                .unwrap_or_default()
        }))
    }

    fn mark_example(
        &self,
        requirement: &ReviewItem,
        value: &str,
    ) -> PortFuture<Result<(), String>> {
        let requirement = requirement.clone();
        let value = value.to_owned();
        Box::pin(blocking(
            Err("Could not mark the example".to_owned()),
            move || mark_example_in_file(&requirement, &value).map(|_| ()),
        ))
    }

    fn promote(&self, change: &str, decision: &Decision) -> PortFuture<Result<String, String>> {
        let root = self.root.clone();
        let change = change.to_owned();
        let decision = decision.clone();
        Box::pin(blocking(
            Err("Could not promote the decision".to_owned()),
            move || promote(&root, &change, &decision),
        ))
    }

    fn lint_config(&self) -> LintConfig {
        load_lint_config(&self.root)
    }

    fn read_artifact(
        &self,
        change: &str,
        artifact: &str,
    ) -> PortFuture<Result<(PathBuf, String), String>> {
        let file = self
            .statuses()
            .get(change)
            .and_then(|s| s.artifact_paths.get(artifact))
            .map(|p| p.resolved_output_path.clone())
            .unwrap_or_default();
        let artifact = artifact.to_owned();
        Box::pin(blocking(
            Err(format!("{artifact} has not been written yet")),
            move || read_document(&file, &artifact),
        ))
    }

    fn stage(&self) -> ProjectStage {
        let count = self.statuses().len();
        project_stage(&self.root, count)
    }

    fn read_stage(&self) -> PortFuture<ProjectStage> {
        let count = self.statuses().len();
        let root = self.root.clone();
        Box::pin(blocking(ProjectStage::NoOpenspec, move || {
            project_stage(&root, count)
        }))
    }

    fn greenfield(&self) -> bool {
        is_greenfield(&self.root)
    }

    fn roadmap(&self) -> Option<Roadmap> {
        load_roadmap(&self.root)
    }

    fn questions(&self) -> PortFuture<Vec<GuidedQuestion>> {
        let root = self.root.clone();
        Box::pin(blocking(Vec::new(), move || guided_questions(&root)))
    }

    fn answer(&self, question: &GuidedQuestion, text: &str) -> Result<(), String> {
        answer_foundation(&question.item, text)
    }

    /// The advisor is stage 8: until then the screen says so, asks nothing,
    /// and every advisor request below resolves to nothing at all.
    fn advisor_note(&self) -> Option<String> {
        Some(NO_ADVISOR_YET.to_owned())
    }

    fn advisor_meta(&self) -> PortFuture<Meta> {
        Box::pin(async { Meta::new() })
    }

    fn after_answer(
        &self,
        _question: &GuidedQuestion,
        _answer: &str,
    ) -> PortFuture<Result<AfterAnswer, String>> {
        Box::pin(async { Ok(AfterAnswer::default()) })
    }

    fn suggest(&self, _question: &GuidedQuestion) -> PortFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn coach(&self, _question: &GuidedQuestion) -> PortFuture<Result<Coached, String>> {
        Box::pin(async { Ok(Coached::default()) })
    }

    fn dismiss(&self, _question: &GuidedQuestion) -> PortFuture<bool> {
        Box::pin(async { false })
    }
    /// OpenSpec if missing, then the schema, then the Foundation questions.
    /// Each step is skipped when already done, so it is safe on a half-set-up
    /// project, and it never overwrites a schema someone edited — `init` only
    /// does that under `--force`.
    fn setup(&self) -> PortFuture<Result<(), String>> {
        let adapter = self.adapter.clone();
        let root = self.root.clone();
        Box::pin(async move {
            if !is_openspec_project(&root) {
                adapter.init().await.map_err(|error| error.describe())?;
            }
            let written = if schema_installed(&root) {
                scaffold_foundation(&root).map(|_| ())
            } else {
                init_project(&root, true).map(|_| ())
            };
            written.map_err(|error| error.to_string())
        })
    }

    fn create_change(&self, name: &str, description: &str) -> PortFuture<Result<(), String>> {
        let adapter = self.adapter.clone();
        let name = name.to_owned();
        let description = description.to_owned();
        Box::pin(async move {
            adapter
                .new_change(&name, Some(&description))
                .await
                .map_err(|error| error.describe())
        })
    }

    fn artifact_file(&self, change: &str, artifact: &str) -> PortFuture<Result<PathBuf, String>> {
        let adapter = self.adapter.clone();
        let status = self.statuses().get(change).cloned();
        let change = change.to_owned();
        let artifact = artifact.to_owned();
        Box::pin(async move {
            let Some(status) = status else {
                return Err(format!("{change} has no artifact called {artifact}"));
            };
            adapter
                .artifact_file(&status, &artifact)
                .await
                .map_err(|error| error.describe())
        })
    }
}

/// Runs file work on a blocking thread, never on the one that draws. Only a
/// panic in `work` gets `fallback`.
async fn blocking<T: Send + 'static>(fallback: T, work: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(work).await.unwrap_or(fallback)
}

/// A change's review queue with its decisions riding along, so reviewing a
/// change walks its requirements and then its design in one pass. `None`
/// while it has no spec files.
fn queue_for(
    root: &Path,
    status: &OpenSpecChangeStatus,
) -> Option<crate::core::change_review::ChangeReviewQueue> {
    if spec_files_of(status).is_empty() {
        return None;
    }
    Some(load_change_review(root, status, true))
}

/// Promotes, then leaves the reference behind — the TypeScript `promote`.
pub fn promote(root: &Path, change: &str, decision: &Decision) -> Result<String, String> {
    let promoted = promote_decision(
        root,
        decision,
        &PromoteOptions {
            change: Some(change.to_owned()),
            supersedes: None,
        },
    )
    .map_err(|error| error.to_string())?;
    replace_decision_body(decision, &promoted.reference)?;
    Ok(format!("ADR-{:04}", promoted.adr.number))
}

/// A single-file artifact's content, or why it cannot be read.
pub fn read_document(file: &str, artifact: &str) -> Result<(PathBuf, String), String> {
    if file.is_empty() || file.contains('*') {
        return Err(format!("{artifact} is not a single document"));
    }
    std::fs::read_to_string(file)
        .map(|content| (PathBuf::from(file), content))
        .map_err(|_| format!("{artifact} has not been written yet"))
}
