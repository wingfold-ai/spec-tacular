//! The commands themselves: what each verb prints, and what it exits with.
//!
//! One function per verb, mirroring the TypeScript `cli.ts` — `runInit`,
//! `checkGate`, `runInstructions`, `runFoundation`, `runAdrs`, `loadPipelines`
//! and the overview branch of `main`. `cli.rs` decides *which* of them runs;
//! this decides what it does.
//!
//! Every one writes through [`Streams`] rather than reaching for
//! `std::io::stdout` directly, so a test asserts on the exact bytes a user
//! would see, exit code included, without running a process.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::io::Write;
use std::path::Path;

use crate::adapter::openspec::{OpenSpecAdapter, OpenSpecError};
use crate::adapter::types::OpenSpecChangeStatus;
use crate::agent::default_registry;
use crate::agent::driver::AgentRequest;
use crate::core::archive::{plan_archive, prepare_archive};
use crate::core::change_review::{load_change_review, spec_files_of, specs_artifact_id};
use crate::core::context::{build_context, build_prompt};
use crate::core::decisions::{list_adrs, AdrStatus};
use crate::core::foundation::{foundation_dir, is_unanswered, load_foundation};
use crate::core::gate::{foundation_gate, gate_for};
use crate::core::init::{init_project, schema_dir, SCHEMA_NAME};
use crate::core::jobs::{cancel_job, list_jobs, start_job, tail_job, StartJobOptions, TAIL_LIMIT};
use crate::core::paths::display_path;
use crate::core::pending::{load_register, register_path};
use crate::core::pipeline::{build_pipeline, sort_by_progress, ChangePipeline, ReviewByArtifact};
use crate::core::roadmap::{
    active_slice, complete_slice, load_roadmap, next_promotable, promote_slice, roadmap_path,
    save_roadmap, scaffold_roadmap, SliceChange,
};
use crate::core::verify::{verify_requirement, VerifyResult};
use crate::render::text::{render_overview, OverviewOptions};

/// Where a command's output goes. Buffers in a test, the process's streams in
/// production.
pub struct Streams<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
}

impl Streams<'_> {
    /// Writes, and ignores a failed write.
    ///
    /// A broken pipe — `spectacular --print | head` — is a normal way for this
    /// program to end, not an error worth a message nobody can read.
    pub(crate) fn out(&mut self, text: impl Display) {
        let _ = write!(self.out, "{text}");
    }

    pub(crate) fn err(&mut self, text: impl Display) {
        let _ = write!(self.err, "{text}");
    }
}

/// Every change, as a pipeline, plus the ones that would not load.
pub struct Loaded {
    pub pipelines: Vec<ChangePipeline>,
    pub failed: Vec<String>,
    /// OpenSpec's own status for each change, keyed by name — what the TUI
    /// needs to find an artifact's file for `e`.
    pub statuses: BTreeMap<String, OpenSpecChangeStatus>,
}

/// The TypeScript `loadPipelines`, all three of its return values.
pub async fn load_pipelines(
    adapter: &OpenSpecAdapter,
    project_root: &Path,
) -> Result<Loaded, OpenSpecError> {
    let status = adapter.status_all().await?;

    let pipelines: Vec<ChangePipeline> = status
        .changes
        .iter()
        .map(|change| {
            let mut reviews = ReviewByArtifact::new();
            // Only an artifact that actually carries requirements gets review
            // state. Attaching an empty summary elsewhere would read as
            // "reviewed, zero requirements" and wrongly mark the stage
            // accepted.
            if let Some(specs) = specs_artifact_id(change) {
                if !spec_files_of(change).is_empty() {
                    let summary = load_change_review(project_root, change, false).summary;
                    reviews.insert(specs.to_owned(), summary);
                }
            }
            build_pipeline(change, &reviews)
        })
        .collect();

    Ok(Loaded {
        pipelines: sort_by_progress(&pipelines),
        failed: status.failed,
        statuses: status
            .changes
            .into_iter()
            .map(|change| (change.change_name.clone(), change))
            .collect(),
    })
}

/// The overview, rendered as text. The TUI renders the same model.
pub async fn run_overview(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    color: bool,
    io: &mut Streams<'_>,
) -> Result<u8, OpenSpecError> {
    let loaded = load_pipelines(adapter, cwd).await?;
    let root = display_path(cwd);
    io.out(format!(
        "{}\n",
        render_overview(
            &loaded.pipelines,
            &OverviewOptions {
                color,
                failed: &loaded.failed,
                root: Some(&root),
            },
        )
    ));
    Ok(0)
}

/// `spectacular init` — install the schema that enforces the sequencing.
pub fn run_init(cwd: &Path, force: bool, io: &mut Streams<'_>) -> u8 {
    let installed = schema_dir(cwd, SCHEMA_NAME);
    if installed.exists() && !force {
        io.err(format!(
            "{SCHEMA_NAME} is already installed at {}.\n\
             Re-run with --force to replace it (local edits to it will be lost).\n",
            display_path(&installed)
        ));
        return 1;
    }

    let result = match init_project(cwd, true) {
        Ok(result) => result,
        Err(err) => {
            // The TypeScript threw here and printed a stack trace. A tool that
            // could not write a file should say which one and stop, not paste
            // its own internals over the terminal.
            io.err(format!(
                "Could not install the {SCHEMA_NAME} schema: {err}\n"
            ));
            return 1;
        }
    };

    io.out(format!(
        "Installed the {SCHEMA_NAME} schema to {}\n",
        display_path(&result.schema_dir)
    ));
    for file in &result.files {
        io.out(format!("  {file}\n"));
    }
    if !result.foundation_created.is_empty() {
        io.out(format!(
            "\nScaffolded the Foundation at {}\n",
            display_path(foundation_dir(cwd))
        ));
        for file in &result.foundation_created {
            io.out(format!("  {file}\n"));
        }
    }
    for file in &result.foundation_skipped {
        io.out(format!("  {file} (kept — it already had answers)\n"));
    }
    for note in &result.notes {
        io.out(format!("\n{note}\n"));
    }
    io.out(
        "\ndesign now requires specs, so a design cannot be written against\n\
         requirements nobody has agreed to yet.\n",
    );
    0
}

/// What the gate decided, for the caller that has to act on it.
pub enum Gate {
    /// Refused, already reported. The exit code to use.
    Refused(u8),
    Allowed {
        artifact: String,
        change: String,
    },
}

/// Runs the gate and reports it.
///
/// Shared by `instructions` and `run` so an agent dispatched in the background
/// can never bypass a check the foreground honours.
pub async fn check_gate(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    artifact: Option<&str>,
    change: Option<&str>,
    verb: &str,
    io: &mut Streams<'_>,
) -> Result<Gate, OpenSpecError> {
    let (Some(artifact), Some(change)) = (artifact, change) else {
        io.err(format!(
            "Usage: spectacular {verb} <artifact> --change <name>\n"
        ));
        return Ok(Gate::Refused(1));
    };

    let loaded = load_pipelines(adapter, cwd).await?;
    let Some(pipeline) = loaded.pipelines.iter().find(|p| p.name == change) else {
        io.err(format!("No change called '{change}'.\n"));
        return Ok(Gate::Refused(1));
    };

    // The first artifact of a change is where the ground rules have to already
    // exist; later ones are downstream of a proposal that already passed this.
    let target = pipeline.all_stages().find(|stage| stage.id == artifact);
    if target.is_some_and(|stage| stage.requires.is_empty()) {
        let foundation = foundation_gate(cwd);
        for warning in foundation.warnings() {
            io.err(format!("Warning: {warning}\n"));
        }
        if let Some(reason) = foundation.reason() {
            io.err(format!("Refused: {reason}\n"));
            for blocker in foundation.blockers() {
                io.err(format!("  - {blocker}\n"));
            }
            io.err(format!(
                "\nAnswer them in {}/spec-tacular/foundation, then try again.\n\
                 See what is outstanding with: spectacular foundation\n",
                display_path(cwd)
            ));
            return Ok(Gate::Refused(1));
        }
    }

    let gate = gate_for(pipeline, artifact);

    // Warnings print either way. A prerequisite that drifted is worth knowing
    // about whether or not something else also blocks — dropping it on refusal
    // would hide it exactly when several things are wrong at once.
    for warning in gate.warnings() {
        io.err(format!("Warning: {warning}\n"));
    }

    if let Some(reason) = gate.reason() {
        io.err(format!("Refused: {reason}\n"));
        for blocker in gate.blockers() {
            io.err(format!("  - {blocker}\n"));
        }
        io.err(format!(
            "\nReview it first: spectacular --cwd {}, select {change}, press enter.\n",
            display_path(cwd)
        ));
        return Ok(Gate::Refused(1));
    }

    Ok(Gate::Allowed {
        artifact: artifact.to_owned(),
        change: change.to_owned(),
    })
}

/// `spectacular instructions <artifact> -c <change>` — the gate, plus the
/// prompt an agent would receive. Useful on its own for piping into a tool
/// spec-tacular has no driver for.
pub async fn run_instructions(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    artifact: Option<&str>,
    change: Option<&str>,
    io: &mut Streams<'_>,
) -> Result<u8, OpenSpecError> {
    let (artifact, change) =
        match check_gate(adapter, cwd, artifact, change, "instructions", io).await? {
            Gate::Refused(code) => return Ok(code),
            Gate::Allowed { artifact, change } => (artifact, change),
        };
    let prompt = compose_prompt(adapter, cwd, &artifact, &change, None).await?;
    io.out(prompt);
    Ok(0)
}

/// Context bundle plus OpenSpec's instructions — exactly what a job runs on.
///
/// `feedback` is a redraft: the developer read the draft and said what to
/// change. No flag reaches it yet — the CLI surface is unchanged — because the
/// UI that collects feedback is the review screen, and that is stage 8. It is a
/// parameter rather than a later edit so the text a redraft is built from is
/// written and tested once.
pub async fn compose_prompt(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    artifact: &str,
    change: &str,
    feedback: Option<&str>,
) -> Result<String, OpenSpecError> {
    let base = adapter.instructions(artifact, change).await?;
    let instructions = match feedback.filter(|f| !f.is_empty()) {
        Some(feedback) => format!(
            "{base}\n\n# Revision requested\n\nA draft of this artifact already exists. \
             The developer read it and asked for\nthese changes:\n\n> {}\n\n\
             Revise the existing file in place. Keep what they did not ask to change.\n",
            quote(feedback)
        ),
        None => base,
    };

    let status = adapter.status_all().await?;
    let status = status.changes.iter().find(|c| c.change_name == change);
    let reviewed = status
        .map(|status| load_change_review(cwd, status, false).requirements)
        .unwrap_or_default();

    // What the developer said the change is for, when they created it. OpenSpec
    // keeps it in the change's README but does not put it in the instructions.
    let intent = status
        .map(|status| change_description(Path::new(&status.change_root)))
        .unwrap_or_default();
    let task = if intent.is_empty() {
        instructions
    } else {
        format!(
            "The developer described this change as:\n\n> {}\n\n{instructions}",
            quote(&intent)
        )
    };

    Ok(build_prompt(&build_context(cwd, &reviewed), &task))
}

/// Text as a markdown blockquote body: every line after the first gets the
/// marker the first one was given by its caller.
fn quote(text: &str) -> String {
    text.replace('\n', "\n> ")
}

/// The description a change was created with: its README, minus the heading.
fn change_description(change_root: &Path) -> String {
    let Ok(readme) = std::fs::read_to_string(change_root.join("README.md")) else {
        return String::new();
    };
    let body = match readme.split_once('\n') {
        Some((first, rest)) if first.starts_with('#') => rest,
        _ => &readme,
    };
    body.trim().to_owned()
}

/// `spectacular run <artifact> -c <change>` — dispatch and return.
///
/// Returning immediately is the point: this is what lets you review one change
/// while another is being implemented, in one terminal.
pub async fn run_agent(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    artifact: Option<&str>,
    change: Option<&str>,
    driver_id: &str,
    io: &mut Streams<'_>,
) -> Result<u8, OpenSpecError> {
    let (artifact, change) = match check_gate(adapter, cwd, artifact, change, "run", io).await? {
        Gate::Refused(code) => return Ok(code),
        Gate::Allowed { artifact, change } => (artifact, change),
    };

    let registry = default_registry();
    let driver = match registry.get(driver_id) {
        Ok(driver) => driver,
        Err(error) => {
            io.err(format!("{error}\n"));
            return Ok(1);
        }
    };

    let prompt = compose_prompt(adapter, cwd, &artifact, &change, None).await?;
    let job = match start_job(StartJobOptions {
        project_root: cwd,
        change: &change,
        artifact: &artifact,
        driver: driver.id(),
        command: driver.build(&AgentRequest {
            prompt: &prompt,
            cwd: &display_path(cwd),
        }),
        cwd,
    }) {
        Ok(job) => job,
        Err(conflict) => {
            io.err(format!("{conflict}\n"));
            return Ok(1);
        }
    };

    io.out(format!(
        "Started {} on {change}/{artifact}\n  job:  {}\n  log:  {}\n\n\
         Follow it with: spectacular jobs --job {}\n",
        driver.label(),
        job.id,
        job.log_path,
        job.id
    ));
    Ok(0)
}

/// `spectacular jobs` — list, tail, or cancel.
pub fn run_jobs(cwd: &Path, job_id: Option<&str>, cancel: bool, io: &mut Streams<'_>) -> u8 {
    let registry = default_registry();

    let Some(job_id) = job_id else {
        let jobs = list_jobs(cwd);
        if jobs.is_empty() {
            io.out("No jobs yet.\n");
            return 0;
        }
        for job in jobs {
            let when = job.ended_at.as_deref().unwrap_or(&job.started_at);
            io.out(format!(
                "{:<11} {}/{}  {when}  {}\n",
                job.status.as_str(),
                job.change,
                job.artifact,
                job.id
            ));
        }
        return 0;
    };

    // A prefix is enough: job ids carry a timestamp and a random suffix, and
    // nobody is going to retype one in full to read its log.
    let Some(job) = list_jobs(cwd)
        .into_iter()
        .find(|j| j.id == job_id || j.id.starts_with(job_id))
    else {
        io.err(format!("No job matching '{job_id}'.\n"));
        return 1;
    };

    if cancel {
        let stopped = cancel_job(cwd, &job.id);
        if stopped {
            io.out(format!("Cancelled {}\n", job.id));
            return 0;
        }
        io.out(format!("{} is not running ({}).\n", job.id, job.status));
        return 1;
    }

    io.out(format!(
        "{}/{}  {}  started {}\n\n",
        job.change, job.artifact, job.status, job.started_at
    ));
    // A job recorded under a driver this build no longer has is still
    // readable — its log is plain text on disk.
    let driver = registry.get(&job.driver).ok();
    for line in tail_job(&job, TAIL_LIMIT) {
        let rendered = match driver {
            Some(driver) => driver.format_line(&line),
            None => Some(line.clone()),
        };
        if let Some(rendered) = rendered {
            io.out(format!("{rendered}\n"));
        }
    }
    0
}

/// `w` in the TUI: the same gates as `spectacular run`, reported as a line.
///
/// It lives here rather than in the TUI so the two paths into an agent cannot
/// drift: whatever `run` refuses, this refuses, in the same order. Its caller
/// is the overview's `w`.
pub async fn dispatch(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    change: &str,
    artifact: &str,
    driver_id: &str,
    feedback: Option<&str>,
) -> Result<String, String> {
    let loaded = load_pipelines(adapter, cwd)
        .await
        .map_err(|error| error.describe())?;
    let Some(pipeline) = loaded.pipelines.iter().find(|p| p.name == change) else {
        return Err(format!("No change called '{change}'"));
    };

    let target = pipeline.all_stages().find(|stage| stage.id == artifact);
    if target.is_some_and(|stage| stage.requires.is_empty()) {
        let foundation = foundation_gate(cwd);
        if let Some(reason) = foundation.reason() {
            return Err(format!("Refused: {reason}"));
        }
    }
    if let Some(reason) = gate_for(pipeline, artifact).reason() {
        return Err(format!("Refused: {reason}"));
    }

    let registry = default_registry();
    let driver = registry.get(driver_id).map_err(|err| err.to_string())?;
    let prompt = compose_prompt(adapter, cwd, artifact, change, feedback)
        .await
        .map_err(|error| error.describe())?;
    start_job(StartJobOptions {
        project_root: cwd,
        change,
        artifact,
        driver: driver.id(),
        command: driver.build(&AgentRequest {
            prompt: &prompt,
            cwd: &display_path(cwd),
        }),
        cwd,
    })
    .map_err(|conflict| conflict.to_string())?;

    Ok(if feedback.is_some() {
        format!(
            "{} is redrafting the {artifact} with your feedback",
            driver.label()
        )
    } else {
        format!(
            "{} is drafting the {artifact} — it opens for you when done",
            driver.label()
        )
    })
}

/// `spectacular archive <change>` — the split.
pub async fn run_archive(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    change: Option<&str>,
    dry_run: bool,
    io: &mut Streams<'_>,
) -> Result<u8, OpenSpecError> {
    let Some(change) = change else {
        io.err("Usage: spectacular archive <change>\n");
        return Ok(1);
    };

    let status = adapter.status_all().await?;
    let Some(status) = status.changes.iter().find(|c| c.change_name == change) else {
        io.err(format!("No change called '{change}'.\n"));
        return Ok(1);
    };

    let queue = load_change_review(cwd, status, false);
    let plan = plan_archive(change, &queue.requirements);

    io.out(format!(
        "{} requirement(s) merge into the baseline\n{} divert to pending validation\n",
        plan.merging.len(),
        plan.diverting.len()
    ));
    for entry in &plan.diverting {
        io.out(format!(
            "  {}: {} — {}\n",
            entry.capability, entry.name, entry.needs
        ));
    }

    if !plan.unresolved.is_empty() {
        io.err(format!(
            "\nRefused: {} requirement(s) are neither accepted nor deferred.\n",
            plan.unresolved.len()
        ));
        for id in &plan.unresolved {
            io.err(format!("  - {id}\n"));
        }
        io.err("\nArchiving now would merge text nobody agreed to — exactly what `--yes` does.\n");
        return Ok(1);
    }

    if dry_run {
        io.out("\nDry run — nothing written.\n");
        return Ok(0);
    }

    match prepare_archive(cwd, change, &queue.requirements) {
        Ok(prepared) => {
            for file in &prepared.rewritten {
                io.out(format!("  rewrote {}\n", display_path(file)));
            }
            for file in &prepared.removed {
                io.out(format!(
                    "  removed {} (every requirement in it deferred)\n",
                    display_path(file)
                ));
            }
        }
        Err(blocked) => {
            io.err(format!("{blocked}\n"));
            return Ok(1);
        }
    }

    // `--yes` is honest here: the only incomplete tasks are ones deliberately
    // deferred, and every deferred requirement is now recorded in the register.
    io.out(adapter.archive(change).await?);
    Ok(0)
}

/// `spectacular pending` — what was accepted but never verified.
pub fn run_pending(cwd: &Path, io: &mut Streams<'_>) -> u8 {
    let entries = load_register(cwd);
    if entries.is_empty() {
        io.out("Nothing is waiting on validation.\n");
        return 0;
    }

    let mut capability = "";
    for entry in &entries {
        if entry.capability != capability {
            capability = &entry.capability;
            io.out(format!("\n{capability}\n"));
        }
        io.out(format!("  {}\n", entry.name));
        io.out(format!("    needs: {}\n", entry.needs));
        io.out(format!(
            "    from:  {} ({})\n",
            entry.change, entry.deferred
        ));
    }
    io.out(format!(
        "\n{} requirement(s) accepted but unverified — not in the baseline.\nRegister: {}\n",
        entries.len(),
        display_path(register_path(cwd))
    ));
    0
}

/// `spectacular verify <capability> --requirement <name>`.
pub async fn run_verify(
    adapter: &OpenSpecAdapter,
    cwd: &Path,
    capability: Option<&str>,
    requirement: Option<&str>,
    io: &mut Streams<'_>,
) -> Result<u8, OpenSpecError> {
    let (Some(capability), Some(requirement)) = (capability, requirement) else {
        io.err("Usage: spectacular verify <capability> --requirement \"<name>\"\n");
        return Ok(1);
    };

    let result = match verify_requirement(cwd, capability, requirement) {
        VerifyResult::Refused { reason } => {
            io.err(format!("{reason}\n"));
            return Ok(1);
        }
        verified => verified,
    };
    let VerifyResult::Verified {
        entry,
        spec_file,
        created,
    } = result
    else {
        unreachable!("a refusal has already returned");
    };

    io.out(format!(
        "Verified '{}' into {}\n",
        entry.name,
        display_path(&spec_file)
    ));
    if created {
        io.out("  (the spec did not exist — fill in its Purpose)\n");
    }

    // This is the one place spec-tacular writes to openspec/specs/, so the
    // result is handed straight back to OpenSpec to confirm it still parses.
    match adapter.validate(capability).await {
        Ok(validation) if validation.trim().is_empty() => io.out("openspec validate: ok\n"),
        Ok(validation) => io.out(format!("{}\n", validation.trim())),
        Err(error) => {
            io.err(format!(
                "Written, but openspec could not validate it: {}\n",
                error.describe()
            ));
            return Ok(1);
        }
    }
    Ok(0)
}

/// `spectacular roadmap` — show, promote, or complete a slice.
pub fn run_roadmap(
    cwd: &Path,
    promote: Option<&str>,
    done: Option<&str>,
    io: &mut Streams<'_>,
) -> u8 {
    let Some(roadmap) = load_roadmap(cwd) else {
        // Nothing there yet is the first run, and the first run scaffolds. A
        // file that exists and does not parse is the other case, and saying so
        // is better than silently replacing what somebody wrote.
        match scaffold_roadmap(cwd) {
            Ok(true) => {
                io.out(format!(
                    "Created {}\nFill in the vision and the slices, then promote one at a time.\n",
                    display_path(roadmap_path(cwd))
                ));
                return 0;
            }
            _ => {
                io.err(format!(
                    "Could not read {}.\n",
                    display_path(roadmap_path(cwd))
                ));
                return 1;
            }
        }
    };

    if let Some(slice) = done.or(promote) {
        let finishing = done.is_some();
        let result = if finishing {
            complete_slice(&roadmap, slice)
        } else {
            promote_slice(&roadmap, slice)
        };
        let SliceChange::Changed { slice, roadmap } = result else {
            let SliceChange::Refused { reason } = result else {
                unreachable!("a change has already been handled");
            };
            io.err(format!("{reason}\n"));
            return 1;
        };
        if let Err(error) = save_roadmap(cwd, &roadmap) {
            io.err(format!(
                "Could not write {}: {error}\n",
                display_path(roadmap_path(cwd))
            ));
            return 1;
        }
        if finishing {
            io.out(format!("'{}' is done.\n", slice.id));
        } else {
            io.out(format!(
                "'{}' is now active. Open a change for it:\n  openspec new change {}\n",
                slice.id, slice.id
            ));
        }
        return 0;
    }

    io.out(format!("{}\n\n", roadmap.vision.trim()));
    for slice in &roadmap.slices {
        let blocked = if slice.depends_on.is_empty() {
            String::new()
        } else {
            format!("  (after {})", slice.depends_on.join(", "))
        };
        io.out(format!(
            "{} {}{blocked}\n    {}\n",
            slice.status.mark(),
            slice.id,
            slice.summary
        ));
    }

    match (active_slice(&roadmap), next_promotable(&roadmap)) {
        (Some(active), _) => io.out(format!(
            "\n'{}' is active. One slice at a time keeps the review queue to one change.\n",
            active.id
        )),
        (None, Some(next)) => io.out(format!(
            "\nNext: spectacular roadmap --promote {}\n",
            next.id
        )),
        (None, None) => io.out("\nNothing left to promote.\n"),
    }
    0
}

/// `spectacular adr` — the project's durable decisions.
pub fn run_adrs(cwd: &Path, io: &mut Streams<'_>) -> u8 {
    let adrs = list_adrs(cwd);
    if adrs.is_empty() {
        io.out(
            "No architectural decisions recorded yet.\n\
             Promote one while reviewing a design: press p on a decision.\n",
        );
        return 0;
    }
    for adr in adrs {
        let status = match (adr.status, adr.superseded_by) {
            (AdrStatus::Superseded, Some(by)) => format!("superseded by ADR-{by:04}"),
            (AdrStatus::Superseded, None) => "superseded".to_owned(),
            (AdrStatus::Accepted, _) => "accepted".to_owned(),
        };
        io.out(format!(
            "ADR-{:04}  {status:<26} {}\n",
            adr.number, adr.title
        ));
    }
    0
}

/// `spectacular foundation` — the ground rules, and what is still TBD.
pub fn run_foundation(cwd: &Path, io: &mut Streams<'_>) -> u8 {
    let items = load_foundation(cwd);
    if items.is_empty() {
        io.err(format!(
            "No Foundation at {}.\nRun `spectacular init` to scaffold it.\n",
            display_path(foundation_dir(cwd))
        ));
        return 1;
    }

    let unanswered = items.iter().filter(|item| is_unanswered(item)).count();
    let mut group = "";
    for item in &items {
        if item.capability != group {
            group = &item.capability;
            io.out(format!("\n{group}\n"));
        }
        io.out(format!(
            "  {} {}\n",
            if is_unanswered(item) { '○' } else { '●' },
            item.name
        ));
    }

    io.out(format!(
        "\n{}/{} answered\n",
        items.len() - unanswered,
        items.len()
    ));
    if unanswered > 0 {
        // Not an error: a half-answered Foundation is a normal state to be in
        // while setting a project up.
        io.out(
            "Unanswered questions are not carried into an agent's context — they are\n\
             decisions nobody has made yet, not constraints.\n",
        );
    }
    0
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::adapter::fake;
    use crate::core::foundation::scaffold_foundation;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Captured output: what the user would have seen on each stream.
    #[derive(Debug, Default)]
    struct Captured {
        out: String,
        err: String,
        code: u8,
    }

    fn capture(run: impl FnOnce(&mut Streams<'_>) -> u8) -> Captured {
        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        let code = run(&mut Streams {
            out: &mut out,
            err: &mut err,
        });
        Captured {
            out: String::from_utf8(out).expect("utf-8 on stdout"),
            err: String::from_utf8(err).expect("utf-8 on stderr"),
            code,
        }
    }

    fn project() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec")).expect("openspec dir");
        dir
    }

    /// A change as OpenSpec's `status --all --json` reports one, with its
    /// files on disk.
    fn change_json(root: &Path, name: &str, specs_written: bool) -> String {
        let change_root = root.join("openspec/changes").join(name);
        fs::create_dir_all(change_root.join("specs/cap")).expect("change dirs");
        fs::write(
            change_root.join("README.md"),
            format!("# {name}\n\nLet people log in.\n"),
        )
        .expect("readme");
        let spec = change_root.join("specs/cap/spec.md");
        if specs_written {
            fs::write(
                &spec,
                "## ADDED Requirements\n\n### Requirement: Alpha\nSHALL alpha.\n\n#### Scenario: ok\n- **WHEN** a\n- **THEN** b\n",
            )
            .expect("spec");
        }
        let specs_status = if specs_written { "done" } else { "ready" };
        let existing = if specs_written {
            format!("\"{}\"", spec.display())
        } else {
            String::new()
        };
        format!(
            r#"{{"changeName":"{name}","schemaName":"spec-tacular","changeRoot":"{root_display}",
               "applyRequires":["tasks"],"isPlanningComplete":false,"nextSteps":[],
               "artifactPaths":{{"specs":{{"outputPath":"specs/**/*.md","resolvedOutputPath":"{spec_display}","existingOutputPaths":[{existing}]}}}},
               "artifacts":[
                 {{"id":"proposal","outputPath":"proposal.md","status":"done","requires":[]}},
                 {{"id":"specs","outputPath":"specs/**/*.md","status":"{specs_status}","requires":["proposal"]}},
                 {{"id":"design","outputPath":"design.md","status":"blocked","requires":["specs"]}}
               ]}}"#,
            root_display = change_root.display(),
            spec_display = spec.display(),
        )
    }

    fn sweep(root: &Path, changes: &[String]) -> String {
        format!(
            r#"cat <<'JSON'
{{"root":{{"path":"{}"}},"changes":[{}]}}
JSON"#,
            root.display(),
            changes.join(",")
        )
    }

    #[test]
    fn init_installs_the_schema_and_says_what_it_wrote() {
        let dir = project();
        let result = capture(|io| run_init(dir.path(), false, io));
        assert_eq!(result.code, 0, "stderr:\n{}", result.err);
        assert!(result.out.contains("Installed the spec-tacular schema to"));
        assert!(result.out.contains("  templates/spec.md\n"));
        assert!(result.out.contains("Scaffolded the Foundation at"));
        assert!(result
            .out
            .ends_with("design now requires specs, so a design cannot be written against\nrequirements nobody has agreed to yet.\n"));
    }

    #[test]
    fn init_refuses_to_replace_an_install_without_force() {
        let dir = project();
        capture(|io| run_init(dir.path(), false, io));

        let again = capture(|io| run_init(dir.path(), false, io));
        assert_eq!(again.code, 1);
        assert!(again
            .err
            .starts_with("spec-tacular is already installed at"));
        assert!(again.err.contains("Re-run with --force"));
        assert!(again.out.is_empty());

        let forced = capture(|io| run_init(dir.path(), true, io));
        assert_eq!(forced.code, 0);
        assert!(forced.out.contains("Local edits to it are gone"));
        // The second run finds the Foundation already there and says so rather
        // than silently leaving it out.
        assert!(forced.out.contains("(kept — it already had answers)"));
    }

    #[test]
    fn foundation_lists_what_is_answered_and_what_is_not() {
        let dir = project();
        scaffold_foundation(dir.path()).expect("scaffold");
        let result = capture(|io| run_foundation(dir.path(), io));

        assert_eq!(result.code, 0);
        assert!(result.out.contains("\nfoundation/stack\n"));
        assert!(result.out.contains("  ○ "));
        assert!(result.out.contains("0/"));
        assert!(result.out.contains("not carried into an agent's context"));
    }

    #[test]
    fn foundation_without_one_says_how_to_get_one() {
        let dir = project();
        let result = capture(|io| run_foundation(dir.path(), io));
        assert_eq!(result.code, 1);
        assert!(result.err.starts_with("No Foundation at "));
        assert!(result
            .err
            .contains("Run `spectacular init` to scaffold it."));
    }

    #[test]
    fn foundation_drops_the_closing_note_once_everything_is_answered() {
        let dir = project();
        scaffold_foundation(dir.path()).expect("scaffold");
        // One document, fully answered, is enough to test the branch.
        let stack = foundation_dir(dir.path()).join("stack.md");
        fs::write(&stack, "# Stack\n\n## Language\n\nRust.\n").expect("write");
        for doc in ["architecture.md", "conventions.md", "domain.md"] {
            fs::remove_file(foundation_dir(dir.path()).join(doc)).expect("remove");
        }

        let result = capture(|io| run_foundation(dir.path(), io));
        assert!(result.out.contains("1/1 answered"));
        assert!(!result.out.contains("not carried into an agent's context"));
    }

    #[test]
    fn adr_with_none_recorded_says_how_one_gets_made() {
        let dir = project();
        let result = capture(|io| run_adrs(dir.path(), io));
        assert_eq!(result.code, 0);
        assert_eq!(
            result.out,
            "No architectural decisions recorded yet.\nPromote one while reviewing a design: press p on a decision.\n"
        );
    }

    #[test]
    fn adr_lists_every_record_with_its_status() {
        let dir = project();
        let decisions = dir.path().join("spec-tacular/decisions");
        fs::create_dir_all(&decisions).expect("mkdir");
        fs::write(
            decisions.join("0001-errors.md"),
            "# ADR-0001: Errors are values\n\n**Status:** superseded by ADR-0002\n",
        )
        .expect("write");
        fs::write(
            decisions.join("0002-errors-again.md"),
            "# ADR-0002: Errors are exceptions\n\n**Status:** accepted\n",
        )
        .expect("write");

        let result = capture(|io| run_adrs(dir.path(), io));
        assert_eq!(
            result.out,
            "ADR-0001  superseded by ADR-0002     Errors are values\n\
             ADR-0002  accepted                   Errors are exceptions\n"
        );
    }

    /// Runs an async command against captured streams.
    macro_rules! captured {
        ($io:ident, $body:expr) => {{
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = {
                let mut $io = Streams {
                    out: &mut out,
                    err: &mut err,
                };
                $body
            };
            Captured {
                out: String::from_utf8(out).expect("utf-8 on stdout"),
                err: String::from_utf8(err).expect("utf-8 on stderr"),
                code,
            }
        }};
    }

    #[tokio::test]
    async fn the_overview_renders_every_change_it_could_load() {
        let dir = project();
        let root = dir.path().to_path_buf();
        let json = change_json(&root, "add-auth", true);
        let adapter = fake::adapter(
            &root,
            &format!(
                r#"cat <<'JSON'
{{"root":{{"path":"{}"}},"changes":[{json},{{"changeName":"broken"}}]}}
JSON"#,
                root.display()
            ),
        );

        let result = captured!(
            io,
            run_overview(&adapter, &root, false, &mut io)
                .await
                .expect("overview")
        );
        assert_eq!(result.code, 0);
        assert!(result.out.contains("add-auth"));
        assert!(result.out.contains("1 change(s) failed to load: broken"));
        assert!(result.out.contains("legend: + accepted"));
        assert!(!result.out.contains('\x1b'), "no colour without a terminal");
    }

    #[tokio::test]
    async fn the_overview_reports_an_openspec_failure_rather_than_an_empty_project() {
        let dir = project();
        let adapter = fake::adapter(dir.path(), r#"echo '{"changes":[],"root":null}'"#);
        let err = captured!(io, {
            match run_overview(&adapter, dir.path(), false, &mut io).await {
                Ok(code) => code,
                Err(err) => {
                    io.err(format!("{}\n", err.message));
                    1
                }
            }
        });
        assert_eq!(err.code, 1);
        assert!(err.err.contains("could not resolve a project root"));
    }

    #[tokio::test]
    async fn instructions_need_both_an_artifact_and_a_change() {
        let dir = project();
        let adapter = fake::adapter(dir.path(), "true");
        let result = captured!(
            io,
            run_instructions(&adapter, dir.path(), Some("specs"), None, &mut io)
                .await
                .expect("instructions")
        );
        assert_eq!(result.code, 1);
        assert_eq!(
            result.err,
            "Usage: spectacular instructions <artifact> --change <name>\n"
        );
    }

    #[tokio::test]
    async fn instructions_for_a_change_that_does_not_exist_say_so() {
        let dir = project();
        let root = dir.path().to_path_buf();
        let adapter = fake::adapter(&root, &sweep(&root, &[]));
        let result = captured!(
            io,
            run_instructions(&adapter, &root, Some("specs"), Some("nope"), &mut io)
                .await
                .expect("instructions")
        );
        assert_eq!(result.code, 1);
        assert_eq!(result.err, "No change called 'nope'.\n");
    }

    #[tokio::test]
    async fn the_foundation_gate_blocks_the_first_artifact_of_a_change() {
        let dir = project();
        let root = dir.path().to_path_buf();
        scaffold_foundation(&root).expect("scaffold");
        let json = change_json(&root, "add-auth", false);
        let adapter = fake::adapter(&root, &sweep(&root, &[json]));

        let result = captured!(
            io,
            run_instructions(&adapter, &root, Some("proposal"), Some("add-auth"), &mut io)
                .await
                .expect("instructions")
        );
        assert_eq!(result.code, 1);
        assert!(result
            .err
            .contains("Refused: the project's ground rules are not settled yet"));
        assert!(result.err.contains("  - foundation/stack: "));
        assert!(result.err.contains(&format!(
            "\nAnswer them in {}/spec-tacular/foundation, then try again.\n",
            root.display()
        )));
        assert!(result
            .err
            .contains("See what is outstanding with: spectacular foundation\n"));
    }

    #[tokio::test]
    async fn a_downstream_artifact_is_refused_until_its_prerequisite_is_accepted() {
        let dir = project();
        let root = dir.path().to_path_buf();
        let json = change_json(&root, "add-auth", true);
        let adapter = fake::adapter(&root, &sweep(&root, &[json]));

        let result = captured!(
            io,
            run_instructions(&adapter, &root, Some("design"), Some("add-auth"), &mut io)
                .await
                .expect("instructions")
        );
        assert_eq!(result.code, 1);
        assert!(result.err.starts_with("Refused: "), "{}", result.err);
        assert!(result.err.contains(&format!(
            "\nReview it first: spectacular --cwd {}, select add-auth, press enter.\n",
            root.display()
        )));
        assert!(result.out.is_empty(), "nothing is printed when refused");
    }

    #[tokio::test]
    async fn an_allowed_artifact_prints_the_context_then_openspec_s_own_instructions() {
        let dir = project();
        let root = dir.path().to_path_buf();
        let json = change_json(&root, "add-auth", false);
        fs::create_dir_all(root.join("spec-tacular/foundation")).expect("mkdir");
        fs::write(
            root.join("spec-tacular/foundation/stack.md"),
            "# Stack\n\n## Language\n\nRust.\n",
        )
        .expect("write");

        // Two commands to answer: the sweep, and the instructions themselves.
        let adapter = fake::adapter(
            &root,
            &format!(
                r#"case "$1" in
  instructions) echo 'WRITE THE PROPOSAL' ;;
  *)
{sweep}
;;
esac"#,
                sweep = sweep(&root, &[json])
            ),
        );

        let result = captured!(
            io,
            run_instructions(&adapter, &root, Some("proposal"), Some("add-auth"), &mut io)
                .await
                .expect("instructions")
        );
        assert_eq!(result.code, 0, "stderr:\n{}", result.err);
        assert!(result.out.contains("# Project ground rules"));
        assert!(result.out.contains("Rust."));
        // The change's README is the developer's own statement of intent.
        assert!(result
            .out
            .contains("The developer described this change as:\n\n> Let people log in."));
        assert!(result.out.contains("WRITE THE PROPOSAL"));
        assert!(
            result.out.find("# Project ground rules") < result.out.find("WRITE THE PROPOSAL"),
            "context comes first"
        );
    }

    #[tokio::test]
    async fn a_redraft_carries_the_developer_s_feedback_into_the_prompt() {
        let dir = project();
        let root = dir.path().to_path_buf();
        let json = change_json(&root, "add-auth", false);
        let adapter = fake::adapter(
            &root,
            &format!(
                r#"case "$1" in
  instructions) echo 'BASE' ;;
  *)
{sweep}
;;
esac"#,
                sweep = sweep(&root, &[json])
            ),
        );

        let prompt = compose_prompt(
            &adapter,
            &root,
            "proposal",
            "add-auth",
            Some("Too vague.\nName the capabilities."),
        )
        .await
        .expect("prompt");

        assert!(prompt.contains("# Revision requested"));
        assert!(prompt.contains("> Too vague.\n> Name the capabilities."));
        assert!(prompt.contains("Revise the existing file in place."));
        // Without feedback the block is absent entirely.
        let plain = compose_prompt(&adapter, &root, "proposal", "add-auth", None)
            .await
            .expect("prompt");
        assert!(!plain.contains("# Revision requested"));
    }

    #[test]
    fn a_change_description_is_its_readme_without_the_heading() {
        let dir = TempDir::new().expect("temp dir");
        fs::write(
            dir.path().join("README.md"),
            "# add-auth\n\nLet people log in.\n",
        )
        .expect("write");
        assert_eq!(change_description(dir.path()), "Let people log in.");

        // No README at all is not an error; there is simply no stated intent.
        assert_eq!(change_description(&PathBuf::from("/nonexistent-xyz")), "");
    }

    #[test]
    fn a_readme_with_no_heading_is_kept_whole() {
        let dir = TempDir::new().expect("temp dir");
        fs::write(dir.path().join("README.md"), "Let people log in.\n").expect("write");
        assert_eq!(change_description(dir.path()), "Let people log in.");
    }

    #[test]
    fn a_blockquote_marks_every_line() {
        assert_eq!(quote("one\ntwo"), "one\n> two");
    }
}
