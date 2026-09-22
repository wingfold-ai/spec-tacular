//! Loads a change's full review queue: every requirement across every
//! capability, joined with its stored review state.

use std::fs;
use std::path::Path;

use crate::adapter::types::OpenSpecChangeStatus;

use super::decisions::{load_decisions, Decision};
use super::requirements::{capability_from_path, parse_spec_file, Rename, Requirement, ReviewItem};
use super::review::{
    apply_renames, load_review, reconcile, summarize, ChangeReview, ReviewSummary, ReviewedItem,
};

#[derive(Debug, Clone)]
pub struct ChangeReviewQueue {
    pub change: String,
    pub requirements: Vec<ReviewedItem>,
    pub summary: ReviewSummary,
    pub review: ChangeReview,
    /// Spec files that could not be read, so the UI can say so rather than
    /// under-report.
    pub unreadable: Vec<String>,
}

/// The id of the artifact that holds requirement specs.
///
/// Found by looking for an artifact whose output path points into `specs/`,
/// rather than assuming the id is literally `specs`. Both the `spec-driven` and
/// `spec-tacular` schemas happen to call it that, but a custom schema need not,
/// and the architecture promises this layer stays schema-agnostic.
pub fn specs_artifact_id(status: &OpenSpecChangeStatus) -> Option<&str> {
    status.artifacts.iter().find_map(|artifact| {
        let path = status
            .artifact_paths
            .get(&artifact.id)
            .map(|p| p.output_path.as_str())
            .unwrap_or_default()
            .replace('\\', "/");
        (path.starts_with("specs/") || path.contains("/specs/")).then_some(artifact.id.as_str())
    })
}

/// The spec files of a change, from the paths OpenSpec already resolved.
pub fn spec_files_of(status: &OpenSpecChangeStatus) -> Vec<String> {
    specs_artifact_id(status)
        .and_then(|id| status.artifact_paths.get(id))
        .map(|paths| paths.existing_output_paths.clone())
        .unwrap_or_default()
}

/// The change's design decisions, reviewable like any other item.
pub fn load_change_decisions(status: &OpenSpecChangeStatus) -> Vec<Decision> {
    load_decisions(Path::new(&status.change_root).join("design.md"))
}

/// Reads every spec file of a change, joins it with the sidecar and reconciles.
///
/// `include_decisions` appends the design's decisions to the queue. They come
/// *after* the requirements: a design is written against settled specs, so
/// reviewing it first would be reviewing it out of order.
pub fn load_change_review(
    project_root: impl AsRef<Path>,
    status: &OpenSpecChangeStatus,
    include_decisions: bool,
) -> ChangeReviewQueue {
    let mut requirements: Vec<Requirement> = Vec::new();
    let mut renames: Vec<Rename> = Vec::new();
    let mut unreadable: Vec<String> = Vec::new();

    // Sorted so the queue order is stable across runs — resuming a review must
    // land you where you left off, and filesystem order does not guarantee
    // that.
    let mut files = spec_files_of(status);
    files.sort();

    for file in files {
        let Ok(content) = fs::read_to_string(&file) else {
            unreadable.push(file);
            continue;
        };
        let parsed = parse_spec_file(&content, &capability_from_path(&file), &file);
        requirements.extend(parsed.requirements);
        renames.extend(parsed.renames);
    }

    let mut items: Vec<ReviewItem> = requirements;
    if include_decisions {
        items.extend(load_change_decisions(status).into_iter().map(|d| d.item));
    }

    let review = apply_renames(load_review(project_root, &status.change_name), &renames);
    let reviewed = reconcile(&items, &review);

    ChangeReviewQueue {
        change: status.change_name.clone(),
        summary: summarize(&reviewed),
        requirements: reviewed,
        review,
        unreadable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::types::{OpenSpecArtifact, OpenSpecArtifactPaths, OpenSpecArtifactStatus};
    use crate::core::review::{save_review, set_state, DecisionNote, ReviewState};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    const SPEC_A: &str = "## ADDED Requirements

### Requirement: Alpha
SHALL alpha.

#### Scenario: A
- **WHEN** a
- **THEN** b
";

    const SPEC_B: &str = "## ADDED Requirements

### Requirement: Beta
SHALL beta.

#### Scenario: B
- **WHEN** a
- **THEN** b
";

    const DESIGN: &str = "# Design

## Decisions

### Use result types
**Scope: global**

**Decision:** Errors are values.
";

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        status: OpenSpecChangeStatus,
    }

    /// A change with two capabilities and a design, laid out the way OpenSpec
    /// lays one out.
    fn fixture(with_design: bool) -> Fixture {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().to_path_buf();
        let change_root = root.join("openspec").join("changes").join("add-thing");

        let mut files = Vec::new();
        // Written in reverse so the sort in `load_change_review` is what puts
        // them back in order, rather than the order they were created.
        for (capability, body) in [("zeta", SPEC_B), ("alpha", SPEC_A)] {
            let dir = change_root.join("specs").join(capability);
            fs::create_dir_all(&dir).expect("mkdir");
            let file = dir.join("spec.md");
            fs::write(&file, body).expect("write spec");
            files.push(file.to_string_lossy().into_owned());
        }
        if with_design {
            fs::create_dir_all(&change_root).expect("mkdir");
            fs::write(change_root.join("design.md"), DESIGN).expect("write design");
        }

        let mut artifact_paths = BTreeMap::new();
        artifact_paths.insert(
            "proposal".to_owned(),
            OpenSpecArtifactPaths {
                output_path: "proposal.md".to_owned(),
                ..Default::default()
            },
        );
        artifact_paths.insert(
            "specs".to_owned(),
            OpenSpecArtifactPaths {
                output_path: "specs/{capability}/spec.md".to_owned(),
                resolved_output_path: String::new(),
                existing_output_paths: files,
            },
        );

        let artifact = |id: &str| OpenSpecArtifact {
            id: id.to_owned(),
            output_path: String::new(),
            status: OpenSpecArtifactStatus::Done,
            requires: Vec::new(),
        };

        Fixture {
            root: root.clone(),
            status: OpenSpecChangeStatus {
                change_name: "add-thing".to_owned(),
                change_root: change_root.to_string_lossy().into_owned(),
                artifact_paths,
                artifacts: vec![artifact("proposal"), artifact("specs")],
                ..Default::default()
            },
            _dir: dir,
        }
    }

    #[test]
    fn finds_the_specs_artifact_by_where_it_writes_not_by_its_name() {
        let f = fixture(false);
        assert_eq!(specs_artifact_id(&f.status), Some("specs"));
    }

    #[test]
    fn a_change_with_no_specs_artifact_has_no_spec_files() {
        let mut status = OpenSpecChangeStatus::default();
        status.artifacts.push(OpenSpecArtifact {
            id: "proposal".to_owned(),
            output_path: String::new(),
            status: OpenSpecArtifactStatus::Ready,
            requires: Vec::new(),
        });
        assert_eq!(specs_artifact_id(&status), None);
        assert!(spec_files_of(&status).is_empty());
    }

    #[test]
    fn the_queue_is_every_capability_in_stable_sorted_order() {
        let f = fixture(false);
        let queue = load_change_review(&f.root, &f.status, false);
        assert_eq!(
            queue
                .requirements
                .iter()
                .map(|r| r.item.id.as_str())
                .collect::<Vec<_>>(),
            ["alpha#alpha", "zeta#beta"]
        );
        assert_eq!(queue.change, "add-thing");
        assert_eq!(queue.summary.total, 2);
        assert!(queue.unreadable.is_empty());
    }

    #[test]
    fn decisions_are_appended_only_when_asked_and_always_after_the_specs() {
        let f = fixture(true);
        assert_eq!(
            load_change_review(&f.root, &f.status, false).summary.total,
            2
        );

        let queue = load_change_review(&f.root, &f.status, true);
        assert_eq!(
            queue
                .requirements
                .iter()
                .map(|r| r.item.id.as_str())
                .collect::<Vec<_>>(),
            ["alpha#alpha", "zeta#beta", "design#use-result-types"]
        );
    }

    #[test]
    fn a_spec_file_that_cannot_be_read_is_reported_rather_than_dropped_silently() {
        let f = fixture(false);
        let mut status = f.status.clone();
        if let Some(paths) = status.artifact_paths.get_mut("specs") {
            paths
                .existing_output_paths
                .push("/nope/specs/ghost/spec.md".to_owned());
        }
        let queue = load_change_review(&f.root, &status, false);
        assert_eq!(queue.unreadable, ["/nope/specs/ghost/spec.md"]);
        // The readable ones still made it.
        assert_eq!(queue.summary.total, 2);
    }

    #[test]
    fn stored_state_is_joined_onto_the_queue() {
        let f = fixture(false);
        let queue = load_change_review(&f.root, &f.status, false);
        let review = set_state(
            &queue.review,
            &queue.requirements[0].item,
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        save_review(&f.root, &review).expect("save");

        let reloaded = load_change_review(&f.root, &f.status, false);
        assert_eq!(reloaded.requirements[0].state, ReviewState::Accepted);
        assert_eq!(reloaded.requirements[1].state, ReviewState::Pending);
        assert_eq!(reloaded.summary.accepted, 1);
    }

    #[test]
    fn an_edit_after_acceptance_drifts_the_item_back_to_pending() {
        let f = fixture(false);
        let queue = load_change_review(&f.root, &f.status, false);
        let review = set_state(
            &queue.review,
            &queue.requirements[0].item,
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        save_review(&f.root, &review).expect("save");

        let file = &queue.requirements[0].item.file;
        fs::write(
            file,
            SPEC_A.replace("SHALL alpha.", "SHALL alpha differently."),
        )
        .expect("edit");

        let reloaded = load_change_review(&f.root, &f.status, false);
        assert!(reloaded.requirements[0].drifted);
        assert_eq!(reloaded.requirements[0].state, ReviewState::Pending);
        assert_eq!(reloaded.summary.drifted, 1);
    }

    #[test]
    fn a_rename_carries_the_review_state_across() {
        let f = fixture(false);
        let queue = load_change_review(&f.root, &f.status, false);
        let review = set_state(
            &queue.review,
            &queue.requirements[0].item,
            ReviewState::Accepted,
            &DecisionNote::default(),
        );
        save_review(&f.root, &review).expect("save");

        // Rename `Alpha` to `Alpha renamed`, keeping the text identical so only
        // the id moves.
        let file = &queue.requirements[0].item.file;
        fs::write(
            file,
            format!(
                "## RENAMED Requirements\n\n- FROM: `### Requirement: Alpha`\n- TO: `### Requirement: Alpha renamed`\n\n{}",
                SPEC_A.replace("### Requirement: Alpha", "### Requirement: Alpha renamed")
            ),
        )
        .expect("rename");

        let reloaded = load_change_review(&f.root, &f.status, false);
        // Without the rename the old id would look deleted and the new one
        // unreviewed, silently discarding the acceptance. It is carried across
        // instead — and then correctly reported as drifted, because the header
        // line is part of the hashed block and the name genuinely changed.
        let renamed = reloaded
            .requirements
            .iter()
            .find(|r| r.item.id == "alpha#alpha-renamed")
            .expect("renamed requirement");
        assert_eq!(renamed.review.state, ReviewState::Accepted);
        assert!(renamed.drifted);
        assert!(!reloaded.review.requirements.contains_key("alpha#alpha"));
    }
}
