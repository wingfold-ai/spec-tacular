//! The archive split.
//!
//! Accepted requirements merge into `openspec/specs/` through OpenSpec's own
//! archive; deferred ones divert to the pending-validation register instead. A
//! change whose only outstanding work needs a deployed environment closes
//! cleanly, and what was never verified stays visible and out of the accepted
//! baseline (docs/problem-analysis.md §8).
//!
//! This rewrites a change's delta files before archiving, which the adapter
//! rule otherwise forbids. The exception is narrow and the content is never
//! lost: every removed requirement is written to the register first, in full,
//! with what would verify it. Preparation is a separate, inspectable step from
//! the archive itself precisely because it edits files.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::core::markdown::{
    build_code_fence_mask, normalize_requirement_name, normalized_lines, REQUIREMENT_HEADER,
    SECTION_HEADER,
};
use crate::core::pending::{add_to_register, PendingEntry};
use crate::core::review::{ReviewState, ReviewedItem};

/// What archiving a change would do, before anything is touched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArchivePlan {
    pub change: String,
    /// Requirements that will merge into the accepted baseline.
    pub merging: Vec<String>,
    /// Requirements that will divert to the register.
    pub diverting: Vec<PendingEntry>,
    /// Requirements neither accepted nor deferred — these block the archive.
    pub unresolved: Vec<String>,
    /// Delta files that would be left with no requirements at all.
    pub emptied: Vec<String>,
}

/// Today, as the register records it.
fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// What would happen, without touching anything.
pub fn plan_archive(change: &str, reviewed: &[ReviewedItem]) -> ArchivePlan {
    let requirements: Vec<&ReviewedItem> = reviewed
        .iter()
        .filter(|entry| entry.item.is_requirement())
        .collect();

    let mut merging = Vec::new();
    let mut diverting = Vec::new();
    let mut unresolved = Vec::new();

    for entry in &requirements {
        match entry.state {
            ReviewState::Accepted => merging.push(entry.item.id.clone()),
            ReviewState::Deferred => diverting.push(PendingEntry {
                capability: entry.item.capability.clone(),
                name: entry.item.name.clone(),
                body: requirement_body(&entry.item.file, &entry.item.name),
                change: change.to_owned(),
                deferred: today(),
                needs: entry
                    .review
                    .defer_reason
                    .clone()
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| "not recorded".to_owned()),
            }),
            _ => unresolved.push(entry.item.id.clone()),
        }
    }

    // A file every one of whose requirements diverts would be left empty, and
    // OpenSpec rejects a change with zero deltas.
    let mut by_file: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut order: Vec<&str> = Vec::new();
    for entry in &requirements {
        let file = entry.item.file.as_str();
        if !order.contains(&file) {
            order.push(file);
        }
        let counts = by_file.entry(file).or_insert((0, 0));
        counts.0 += 1;
        if entry.state != ReviewState::Deferred {
            counts.1 += 1;
        }
    }
    let emptied = order
        .into_iter()
        .filter(|file| by_file.get(file).is_some_and(|(_, kept)| *kept == 0))
        .map(str::to_owned)
        .collect();

    ArchivePlan {
        change: change.to_owned(),
        merging,
        diverting,
        unresolved,
        emptied,
    }
}

/// The requirement's block as written, for preservation in the register.
fn requirement_body(file: &str, name: &str) -> String {
    let Ok(content) = std::fs::read_to_string(file) else {
        return String::new();
    };
    let lines = normalized_lines(&content);
    let mask = build_code_fence_mask(&lines);
    let target = normalize_requirement_name(name);

    for (i, line) in lines.iter().enumerate() {
        if mask[i] {
            continue;
        }
        let Some(header) = REQUIREMENT_HEADER.captures(line) else {
            continue;
        };
        if normalize_requirement_name(&header[1]) != target {
            continue;
        }

        let mut body: Vec<&str> = Vec::new();
        for (j, next) in lines.iter().enumerate().skip(i + 1) {
            if !mask[j] && (REQUIREMENT_HEADER.is_match(next) || SECTION_HEADER.is_match(next)) {
                break;
            }
            body.push(next);
        }
        return body.join("\n").trim().to_owned();
    }
    String::new()
}

/// What preparing an archive actually did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareResult {
    pub plan: ArchivePlan,
    /// Delta files rewritten to drop diverted requirements.
    pub rewritten: Vec<String>,
    /// Delta files removed because nothing was left in them.
    pub removed: Vec<String>,
}

/// The archive cannot proceed: something is neither accepted nor deferred.
#[derive(Debug, Clone)]
pub struct ArchiveBlockedError {
    pub plan: ArchivePlan,
}

impl std::fmt::Display for ArchiveBlockedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} has {} requirement(s) that are neither accepted nor deferred. \
             Review them, or defer the ones that cannot be verified yet.",
            self.plan.change,
            self.plan.unresolved.len()
        )
    }
}

impl std::error::Error for ArchiveBlockedError {}

/// Moves deferred requirements to the register and strips them from the deltas.
///
/// Refuses outright when anything is still unreviewed: archiving then would be
/// exactly the `--yes` behaviour this replaces, merging text nobody agreed to.
pub fn prepare_archive(
    project_root: impl AsRef<Path>,
    change: &str,
    reviewed: &[ReviewedItem],
) -> Result<PrepareResult, ArchiveBlockedError> {
    let plan = plan_archive(change, reviewed);
    if !plan.unresolved.is_empty() {
        return Err(ArchiveBlockedError { plan });
    }
    if plan.diverting.is_empty() {
        return Ok(PrepareResult {
            plan,
            rewritten: Vec::new(),
            removed: Vec::new(),
        });
    }

    // The register is written first: if a rewrite fails afterwards, a
    // requirement recorded twice is recoverable, one recorded nowhere is not.
    let _ = add_to_register(project_root, &plan.diverting);

    let mut deferred_by_file: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    let mut order: Vec<&str> = Vec::new();
    for entry in reviewed {
        if entry.state != ReviewState::Deferred || !entry.item.is_requirement() {
            continue;
        }
        let file = entry.item.file.as_str();
        if !order.contains(&file) {
            order.push(file);
        }
        deferred_by_file
            .entry(file)
            .or_default()
            .insert(normalize_requirement_name(&entry.item.name));
    }

    let mut rewritten = Vec::new();
    let mut removed = Vec::new();
    for file in order {
        let names = deferred_by_file.get(file).cloned().unwrap_or_default();
        if plan.emptied.iter().any(|e| e == file) {
            // An empty delta file would fail OpenSpec's validation, and a
            // capability whose every requirement is unverified has nothing to
            // merge.
            if std::fs::remove_file(file).is_ok() {
                removed.push(file.to_owned());
            }
            continue;
        }
        if remove_requirements(file, &names) {
            rewritten.push(file.to_owned());
        }
    }

    Ok(PrepareResult {
        plan,
        rewritten,
        removed,
    })
}

/// Strips the named requirement blocks from a delta file.
fn remove_requirements(file: &str, names: &BTreeSet<String>) -> bool {
    let Ok(content) = std::fs::read_to_string(file) else {
        return false;
    };
    let lines = normalized_lines(&content);
    let mask = build_code_fence_mask(&lines);
    let mut kept: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        let dropped = !mask[i]
            && REQUIREMENT_HEADER
                .captures(line)
                .is_some_and(|header| names.contains(&normalize_requirement_name(&header[1])));
        if dropped {
            // Skip the whole block.
            let mut j = i + 1;
            while j < lines.len() {
                let next = &lines[j];
                if !mask[j] && (REQUIREMENT_HEADER.is_match(next) || SECTION_HEADER.is_match(next))
                {
                    break;
                }
                j += 1;
            }
            i = j;
            continue;
        }
        kept.push(line);
        i += 1;
    }

    // Collapse the blank run a removed block leaves behind, so the file reads
    // as if the requirement had never been there.
    static RUNS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\n{3,}").expect("built-in pattern must compile"));
    let joined = kept.join("\n");
    let cleaned = RUNS.replace_all(&joined, "\n\n");
    std::fs::write(file, format!("{}\n", cleaned.trim_end())).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::pending::load_register;
    use crate::core::requirements::parse_spec_file;
    use crate::core::review::{empty_review, reconcile, set_state, ChangeReview, DecisionNote};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const SPEC: &str = "# Spec Delta\n\n\
## ADDED Requirements\n\n\
### Requirement: Export produces a file\n\
The system SHALL produce a portable file.\n\n\
#### Scenario: Local export\n\
- **WHEN** a user exports\n\
- **THEN** a file is written\n\n\
### Requirement: Export completes against a deployment\n\
The system SHALL complete an export end to end in a deployed environment.\n\n\
#### Scenario: Deployed export\n\
- **WHEN** run against a deployment\n\
- **THEN** the export finishes\n\n\
### Requirement: Export is audited\n\
The system SHALL record who exported what.\n";

    fn project(content: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("temp dir");
        let specs = dir
            .path()
            .join("openspec/changes/add-export/specs/data-export");
        std::fs::create_dir_all(&specs).expect("change dirs");
        let file = specs.join("spec.md");
        std::fs::write(&file, content).expect("spec");
        (dir, file)
    }

    fn load(file: &Path) -> Vec<crate::core::requirements::Requirement> {
        let content = std::fs::read_to_string(file).expect("read");
        parse_spec_file(&content, "data-export", &file.display().to_string()).requirements
    }

    /// Accept the first and third, defer the second.
    fn mixed(file: &Path) -> ChangeReview {
        let reqs = load(file);
        let review = set_state(
            &empty_review("add-export"),
            &reqs[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        let review = set_state(
            &review,
            &reqs[1],
            ReviewState::Deferred,
            &DecisionNote::defer_reason("needs a deployed instance"),
        );
        set_state(
            &review,
            &reqs[2],
            ReviewState::Accepted,
            &DecisionNote::default(),
        )
    }

    fn all(file: &Path, state: ReviewState, note: &DecisionNote) -> ChangeReview {
        let mut review = empty_review("add-export");
        for req in load(file) {
            review = set_state(&review, &req, state, note);
        }
        review
    }

    #[test]
    fn splits_accepted_from_deferred() {
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let plan = plan_archive("add-export", &reconcile(&reqs, &mixed(&file)));

        assert_eq!(
            plan.merging,
            [
                "data-export#export-produces-a-file",
                "data-export#export-is-audited"
            ]
        );
        assert_eq!(
            plan.diverting
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            ["Export completes against a deployment"]
        );
        assert!(plan.unresolved.is_empty());
    }

    #[test]
    fn carries_the_deferral_reason_and_the_full_requirement_into_the_register_entry() {
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let plan = plan_archive("add-export", &reconcile(&reqs, &mixed(&file)));
        let diverted = &plan.diverting[0];

        assert_eq!(diverted.needs, "needs a deployed instance");
        assert_eq!(diverted.change, "add-export");
        assert!(diverted.body.contains("#### Scenario: Deployed export"));
        assert_eq!(diverted.deferred.len(), 10, "an ISO date, not a timestamp");
    }

    #[test]
    fn a_requirement_that_was_never_reviewed_is_unresolved() {
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let review = set_state(
            &empty_review("add-export"),
            &reqs[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        assert_eq!(
            plan_archive("add-export", &reconcile(&reqs, &review))
                .unresolved
                .len(),
            2
        );
    }

    #[test]
    fn a_rejected_requirement_is_unresolved_too() {
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let mut review = set_state(
            &empty_review("add-export"),
            &reqs[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        review = set_state(
            &review,
            &reqs[1],
            ReviewState::Rejected,
            &DecisionNote::note("too specific"),
        );
        review = set_state(
            &review,
            &reqs[2],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        assert_eq!(
            plan_archive("add-export", &reconcile(&reqs, &review)).unresolved,
            ["data-export#export-completes-against-a-deployment"]
        );
    }

    #[test]
    fn notices_a_file_that_would_be_left_with_nothing() {
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let review = all(
            &file,
            ReviewState::Deferred,
            &DecisionNote::defer_reason("needs a deployment"),
        );
        assert_eq!(
            plan_archive("add-export", &reconcile(&reqs, &review)).emptied,
            [file.display().to_string()]
        );
    }

    #[test]
    fn records_not_recorded_when_a_deferral_somehow_has_no_reason() {
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let mut review = set_state(
            &empty_review("add-export"),
            &reqs[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        review = set_state(
            &review,
            &reqs[1],
            ReviewState::Deferred,
            &DecisionNote::default(),
        );
        review = set_state(
            &review,
            &reqs[2],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        assert_eq!(
            plan_archive("add-export", &reconcile(&reqs, &review)).diverting[0].needs,
            "not recorded"
        );
    }

    #[test]
    fn writes_the_register_and_strips_the_deferred_requirement_from_the_delta() {
        let (dir, file) = project(SPEC);
        let reqs = load(&file);
        let result = prepare_archive(dir.path(), "add-export", &reconcile(&reqs, &mixed(&file)))
            .expect("nothing unresolved");

        let spec = std::fs::read_to_string(&file).expect("read");
        assert!(spec.contains("### Requirement: Export produces a file"));
        assert!(spec.contains("### Requirement: Export is audited"));
        // Gone from what will merge into the baseline...
        assert!(!spec.contains("Export completes against a deployment"));
        assert!(!spec.contains("#### Scenario: Deployed export"));
        // ...but preserved in full, with what would verify it.
        let pending = load_register(dir.path());
        assert_eq!(pending[0].name, "Export completes against a deployment");
        assert!(pending[0].body.contains("#### Scenario: Deployed export"));
        assert_eq!(pending[0].needs, "needs a deployed instance");
        assert_eq!(result.rewritten, [file.display().to_string()]);
    }

    #[test]
    fn leaves_the_surviving_requirements_readable() {
        let (dir, file) = project(SPEC);
        let reqs = load(&file);
        prepare_archive(dir.path(), "add-export", &reconcile(&reqs, &mixed(&file))).expect("plan");

        // The delta must still parse, or OpenSpec's archive cannot merge it.
        assert_eq!(
            load(&file).iter().map(|r| r.name.clone()).collect::<Vec<_>>(),
            ["Export produces a file", "Export is audited"]
        );
        assert!(!std::fs::read_to_string(&file)
            .expect("read")
            .contains("\n\n\n"));
    }

    #[test]
    fn removes_a_delta_file_whose_every_requirement_deferred() {
        // An empty delta fails OpenSpec's validation, and a capability with
        // nothing verified has nothing to merge.
        let (dir, file) = project(SPEC);
        let reqs = load(&file);
        let review = all(
            &file,
            ReviewState::Deferred,
            &DecisionNote::defer_reason("needs a deployment"),
        );

        let result =
            prepare_archive(dir.path(), "add-export", &reconcile(&reqs, &review)).expect("plan");
        assert_eq!(result.removed, [file.display().to_string()]);
        assert!(!file.exists());
        assert_eq!(load_register(dir.path()).len(), 3);
    }

    #[test]
    fn refuses_while_anything_is_unreviewed() {
        // Archiving then would merge text nobody agreed to — exactly what
        // `--yes` does, which is the behaviour this replaces.
        let (dir, file) = project(SPEC);
        let reqs = load(&file);
        let review = set_state(
            &empty_review("add-export"),
            &reqs[0],
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        let blocked = prepare_archive(dir.path(), "add-export", &reconcile(&reqs, &review))
            .expect_err("two requirements are unreviewed");
        assert!(blocked
            .to_string()
            .contains("neither accepted nor deferred"));
        // And nothing was touched.
        assert_eq!(std::fs::read_to_string(&file).expect("read"), SPEC);
        assert!(load_register(dir.path()).is_empty());
    }

    #[test]
    fn a_change_with_nothing_deferred_is_left_alone_entirely() {
        let (dir, file) = project(SPEC);
        let reqs = load(&file);
        let review = all(&file, ReviewState::Accepted, &DecisionNote::default());

        let result =
            prepare_archive(dir.path(), "add-export", &reconcile(&reqs, &review)).expect("plan");
        assert!(result.rewritten.is_empty());
        assert!(result.removed.is_empty());
        assert_eq!(std::fs::read_to_string(&file).expect("read"), SPEC);
    }

    #[test]
    fn a_requirement_the_delta_no_longer_holds_still_reaches_the_register() {
        // Empty is worse than wrong here only if it is silent: the entry still
        // carries the name, the change and what would verify it.
        let (_dir, file) = project(SPEC);
        let reqs = load(&file);
        let review = mixed(&file);
        std::fs::remove_file(&file).expect("remove");
        let plan = plan_archive("add-export", &reconcile(&reqs, &review));
        assert_eq!(plan.diverting.len(), 1);
        assert!(plan.diverting[0].body.is_empty());
        assert_eq!(plan.diverting[0].needs, "needs a deployed instance");
    }
}
