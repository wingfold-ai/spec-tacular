//! The guide: where a project is in getting started, and what to do next.
//!
//! The TUI used to assume a project that was already set up, with changes
//! already written — anything else was a blank screen or an exit. This names
//! every state a first run passes through, so each one can say what comes next
//! instead of leaving you to know the right command.
//!
//! Derivation only. Nothing here acts; the TUI offers the action it names.
//!
//! It reads the OpenSpec directory layout — `openspec/` has to exist before
//! there is anything to guide — exactly as the TypeScript `core/guide.ts` did.
//! The rule it must not break is the other direction: nothing outside
//! `adapter/` *writes* to `openspec/`, and nothing here runs `openspec`.

use std::path::Path;

use super::foundation::{foundation_exists, is_unanswered, load_foundation};
use super::gate::gate_for;
use super::pipeline::{ChangePipeline, Stage, StageState};
use super::roadmap::load_roadmap;
use super::vision::{is_greenfield, load_session};

/// Where the project stands in getting started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectStage {
    /// No `openspec/` directory — nothing to work on yet.
    NoOpenspec,
    /// OpenSpec, but not spec-tacular's schema and ground rules.
    NoFoundation,
    /// Ground rules scaffolded; some questions still open.
    Foundation {
        answered: usize,
        total: usize,
    },
    /// Ground rules settled on a new project: describe the vision next.
    Vision,
    /// Ground rules settled; nothing proposed yet.
    NoChanges,
    Working,
}

/// The steps a first run walks through, as the stepper shows them.
///
/// A new project describes its vision before its first change; one with a
/// baseline goes straight to a change.
pub fn setup_steps(greenfield: bool) -> Vec<&'static str> {
    if greenfield {
        vec!["Set up", "Ground rules", "Vision", "First change"]
    } else {
        vec!["Set up", "Ground rules", "First change"]
    }
}

/// Index into [`setup_steps`], or `None` once setup is over.
pub fn setup_step(stage: &ProjectStage, greenfield: bool) -> Option<usize> {
    match stage {
        ProjectStage::NoOpenspec | ProjectStage::NoFoundation => Some(0),
        ProjectStage::Foundation { .. } => Some(1),
        ProjectStage::Vision => Some(2),
        ProjectStage::NoChanges => Some(if greenfield { 3 } else { 2 }),
        ProjectStage::Working => None,
    }
}

/// Whether spec-tacular's own schema is installed in the project.
pub fn schema_installed(project_root: impl AsRef<Path>) -> bool {
    project_root
        .as_ref()
        .join("openspec")
        .join("schemas")
        .join("spec-tacular")
        .exists()
}

/// Where the project is.
///
/// A project that already has changes but no Foundation is `Working`, not sent
/// back to setup: it adopted OpenSpec before spec-tacular existed, and the gate
/// deliberately lets it proceed (`core::gate`). The overview still nudges.
pub fn project_stage(project_root: impl AsRef<Path>, change_count: usize) -> ProjectStage {
    let project_root = project_root.as_ref();
    if !project_root.join("openspec").exists() {
        return ProjectStage::NoOpenspec;
    }

    if !foundation_exists(project_root) {
        return if change_count == 0 {
            ProjectStage::NoFoundation
        } else {
            ProjectStage::Working
        };
    }

    let items = load_foundation(project_root);
    let total = items.len();
    let answered = items.iter().filter(|item| !is_unanswered(item)).count();
    if answered < total {
        return ProjectStage::Foundation { answered, total };
    }

    if change_count > 0 {
        return ProjectStage::Working;
    }

    // A new project with no roadmap yet starts from its vision — unless the
    // developer said it is not new, or it already has a roadmap to work from.
    let skipped = load_session(project_root).is_some_and(|session| session.skipped);
    let has_slices = load_roadmap(project_root).is_some_and(|r| !r.slices.is_empty());
    if is_greenfield(project_root) && !skipped && !has_slices {
        ProjectStage::Vision
    } else {
        ProjectStage::NoChanges
    }
}

/// One of the things the overview offers for a change's next step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NextAction {
    Review,
    Draft,
    Write,
    Foundation,
}

/// What a change's next step is, and which keys act on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextStep {
    pub text: String,
    /// Keys the overview offers for this step.
    pub actions: Vec<NextAction>,
    /// The artifact `Draft`/`Write` act on.
    pub artifact: Option<String>,
}

fn review_noun(stage: &Stage) -> &'static str {
    if stage.id == "design" {
        "decision"
    } else {
        "requirement"
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// The single next thing to do on a change.
///
/// One step, not a list: the point is to never leave someone choosing between
/// five commands they have not learnt yet.
pub fn next_step(pipeline: &ChangePipeline, foundation_settled: bool) -> NextStep {
    let Some(stage) = pipeline.current_stage() else {
        if pipeline.apply.state == StageState::Ready {
            return NextStep {
                text: "Planning is done — an agent can start implementing it, in the background."
                    .to_owned(),
                actions: vec![NextAction::Draft],
                artifact: Some("apply".to_owned()),
            };
        }
        return NextStep {
            text: format!("Waiting on {}.", pipeline.apply.blocked_by.join(", ")),
            actions: Vec::new(),
            artifact: None,
        };
    };

    if stage.state == StageState::Written {
        if let Some(review) = stage.review {
            let noun = review_noun(stage);
            if review.total == 0 {
                return NextStep {
                    text: format!(
                        "{} is written, but has no {noun}s in a format the review can read.",
                        stage.id
                    ),
                    actions: Vec::new(),
                    artifact: None,
                };
            }
            if review.pending == 0 && review.rejected > 0 {
                return NextStep {
                    text: format!(
                        "{} {noun}{} rejected. Revise them in the review (e on each), then accept.",
                        review.rejected,
                        plural(review.rejected)
                    ),
                    actions: vec![NextAction::Review],
                    artifact: None,
                };
            }
            let open = review.pending + review.rejected;
            return NextStep {
                text: format!(
                    "Review the {}: {open} {noun}{} waiting, one at a time.",
                    stage.id,
                    plural(open)
                ),
                actions: vec![NextAction::Review],
                artifact: None,
            };
        }
    }

    if stage.requires.is_empty() && !foundation_settled {
        return NextStep {
            text: format!("Set the ground rules before writing the {}.", stage.id),
            actions: vec![NextAction::Foundation],
            artifact: None,
        };
    }

    let gate = gate_for(pipeline, &stage.id);
    if !gate.allowed() {
        return NextStep {
            text: format!("Blocked: {}.", gate.blockers().join("; ")),
            actions: Vec::new(),
            artifact: None,
        };
    }

    let what = if stage.id == "proposal" {
        "Write the proposal: why this change, and what it changes.".to_owned()
    } else {
        format!("Write the {}.", stage.id)
    };
    NextStep {
        text: format!("{what} Let an agent draft it, or write it yourself."),
        actions: vec![NextAction::Draft, NextAction::Write],
        artifact: Some(stage.id.clone()),
    }
}

/// A change name OpenSpec will accept, or why not.
pub fn validate_change_name(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("A name is required".to_owned());
    }
    // `^[a-z0-9]+(-[a-z0-9]+)*$`, spelled out rather than compiled: it runs on
    // every keystroke of the name prompt.
    let kebab = !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if kebab {
        None
    } else {
        Some("Use lowercase words joined by dashes, e.g. add-user-login".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::types::{OpenSpecArtifact, OpenSpecArtifactStatus, OpenSpecChangeStatus};
    use crate::core::foundation::{answer_foundation, guided_questions, scaffold_foundation};
    use crate::core::pipeline::{build_pipeline, ReviewByArtifact};
    use crate::core::review::ReviewSummary;
    use std::fs;
    use tempfile::TempDir;

    fn with_openspec() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec").join("changes")).expect("openspec");
        dir
    }

    fn answer_all(root: &Path) {
        for question in guided_questions(root) {
            answer_foundation(&question.item, "Decided.").expect("answer");
        }
    }

    fn artifact(id: &str, status: OpenSpecArtifactStatus, requires: &[&str]) -> OpenSpecArtifact {
        OpenSpecArtifact {
            id: id.to_owned(),
            status,
            requires: requires.iter().map(|r| (*r).to_owned()).collect(),
            output_path: format!("{id}.md"),
        }
    }

    fn change(artifacts: Vec<OpenSpecArtifact>) -> OpenSpecChangeStatus {
        OpenSpecChangeStatus {
            change_name: "add-login".to_owned(),
            schema_name: "spec-tacular".to_owned(),
            change_root: "/tmp/add-login".to_owned(),
            apply_requires: vec!["tasks".to_owned()],
            artifacts,
            ..Default::default()
        }
    }

    fn summary(pending: usize, accepted: usize, rejected: usize, complete: bool) -> ReviewSummary {
        ReviewSummary {
            total: 3,
            accepted,
            rejected,
            deferred: 0,
            pending,
            drifted: 0,
            complete,
        }
    }

    fn reviews(summary: ReviewSummary) -> ReviewByArtifact {
        let mut map = ReviewByArtifact::new();
        map.insert("specs".to_owned(), summary);
        map
    }

    #[test]
    fn it_walks_set_up_then_ground_rules_then_first_change_then_working() {
        let bare = TempDir::new().expect("temp dir");
        assert_eq!(project_stage(bare.path(), 0), ProjectStage::NoOpenspec);

        let dir = with_openspec();
        let root = dir.path();
        assert_eq!(project_stage(root, 0), ProjectStage::NoFoundation);

        scaffold_foundation(root).expect("scaffold");
        match project_stage(root, 0) {
            ProjectStage::Foundation { answered, total } => {
                assert_eq!(answered, 0);
                assert!(total > 0);
            }
            other => panic!("expected foundation, got {other:?}"),
        }

        answer_all(root);
        // A new project describes its vision before its first change…
        assert_eq!(project_stage(root, 0), ProjectStage::Vision);
        // …unless it says it is not new.
        crate::core::vision::skip_session(root).expect("skip");
        assert_eq!(project_stage(root, 0), ProjectStage::NoChanges);
        assert_eq!(project_stage(root, 1), ProjectStage::Working);
    }

    #[test]
    fn a_project_with_baseline_specs_goes_straight_to_its_first_change() {
        let dir = with_openspec();
        let root = dir.path();
        fs::create_dir_all(root.join("openspec/specs/auth")).expect("specs");
        fs::write(root.join("openspec/specs/auth/spec.md"), "# Auth\n").expect("spec");
        scaffold_foundation(root).expect("scaffold");
        answer_all(root);

        assert!(!is_greenfield(root));
        assert_eq!(project_stage(root, 0), ProjectStage::NoChanges);
        assert_eq!(
            setup_steps(false),
            ["Set up", "Ground rules", "First change"]
        );
        assert_eq!(
            setup_steps(true),
            ["Set up", "Ground rules", "Vision", "First change"]
        );
        assert_eq!(setup_step(&ProjectStage::NoChanges, true), Some(3));
    }

    #[test]
    fn a_project_with_changes_but_no_foundation_is_not_sent_back_to_setup() {
        // It adopted OpenSpec before spec-tacular; the gate lets it proceed too.
        let dir = with_openspec();
        assert_eq!(project_stage(dir.path(), 2), ProjectStage::Working);
    }

    #[test]
    fn the_stepper_ends_once_there_is_a_change() {
        assert_eq!(setup_step(&ProjectStage::NoOpenspec, false), Some(0));
        assert_eq!(
            setup_step(
                &ProjectStage::Foundation {
                    answered: 1,
                    total: 19
                },
                false
            ),
            Some(1)
        );
        assert_eq!(setup_step(&ProjectStage::NoChanges, false), Some(2));
        assert_eq!(setup_step(&ProjectStage::Working, false), None);
    }

    #[test]
    fn a_fresh_change_asks_for_its_proposal_offering_both_ways_to_write_it() {
        let pipeline = build_pipeline(
            &change(vec![
                artifact("proposal", OpenSpecArtifactStatus::Ready, &[]),
                artifact("specs", OpenSpecArtifactStatus::Blocked, &["proposal"]),
            ]),
            &ReviewByArtifact::new(),
        );
        let step = next_step(&pipeline, true);
        assert!(step.text.contains("Write the proposal"), "{}", step.text);
        assert_eq!(step.actions, [NextAction::Draft, NextAction::Write]);
        assert_eq!(step.artifact.as_deref(), Some("proposal"));
    }

    #[test]
    fn unsettled_ground_rules_come_before_the_proposal() {
        let pipeline = build_pipeline(
            &change(vec![artifact(
                "proposal",
                OpenSpecArtifactStatus::Ready,
                &[],
            )]),
            &ReviewByArtifact::new(),
        );
        let step = next_step(&pipeline, false);
        assert_eq!(step.actions, [NextAction::Foundation]);
        assert!(step.text.contains("ground rules"), "{}", step.text);
    }

    #[test]
    fn written_specs_send_you_to_review_them() {
        let pipeline = build_pipeline(
            &change(vec![
                artifact("proposal", OpenSpecArtifactStatus::Done, &[]),
                artifact("specs", OpenSpecArtifactStatus::Done, &["proposal"]),
                artifact("design", OpenSpecArtifactStatus::Ready, &["specs"]),
            ]),
            &reviews(summary(2, 1, 0, false)),
        );
        let step = next_step(&pipeline, true);
        assert_eq!(step.actions, [NextAction::Review]);
        assert!(
            step.text.contains("2 requirements waiting"),
            "{}",
            step.text
        );
    }

    #[test]
    fn accepted_specs_unlock_the_design() {
        let pipeline = build_pipeline(
            &change(vec![
                artifact("proposal", OpenSpecArtifactStatus::Done, &[]),
                artifact("specs", OpenSpecArtifactStatus::Done, &["proposal"]),
                artifact("design", OpenSpecArtifactStatus::Ready, &["specs"]),
            ]),
            &reviews(summary(0, 3, 0, true)),
        );
        let step = next_step(&pipeline, true);
        assert_eq!(step.artifact.as_deref(), Some("design"));
        assert_eq!(step.actions, [NextAction::Draft, NextAction::Write]);
    }

    #[test]
    fn finished_planning_offers_the_implementation() {
        let pipeline = build_pipeline(
            &change(vec![
                artifact("proposal", OpenSpecArtifactStatus::Done, &[]),
                artifact("tasks", OpenSpecArtifactStatus::Done, &["proposal"]),
            ]),
            &ReviewByArtifact::new(),
        );
        let step = next_step(&pipeline, true);
        assert_eq!(step.artifact.as_deref(), Some("apply"));
        assert_eq!(step.actions, [NextAction::Draft]);
    }

    #[test]
    fn change_names_are_kebab_case() {
        assert_eq!(validate_change_name("add-user-login"), None);
        assert!(validate_change_name("").is_some());
        assert!(validate_change_name("Add Login")
            .expect("refused")
            .contains("lowercase"));
        assert!(validate_change_name("-leading").is_some());
        assert!(validate_change_name("trailing-").is_some());
        assert!(validate_change_name("double--dash").is_some());
        assert_eq!(validate_change_name("add-v2"), None);
    }
}
