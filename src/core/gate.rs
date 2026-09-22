//! Whether an artifact may be generated yet.
//!
//! This is where the sequencing argument gets teeth. OpenSpec's `requires` is
//! satisfied by a file existing, so `design` unblocks the moment `specs/` is
//! written — not when anyone has agreed the specs are right
//! (docs/problem-analysis.md §1, §2). The gate adds the missing condition:
//! a prerequisite must be *accepted*, not merely present.
//!
//! Enforced in two places on purpose. The schema (`design.requires: [specs]`)
//! fixes the order for anyone running plain `openspec`; this fixes the
//! acceptance condition, which a schema cannot express.

use std::path::Path;

use super::foundation::{foundation_exists, is_unanswered, load_foundation};
use super::pipeline::{ChangePipeline, Stage, StageState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allowed {
        warnings: Vec<String>,
    },
    Refused {
        reason: String,
        blockers: Vec<String>,
        warnings: Vec<String>,
    },
}

impl GateDecision {
    pub fn allowed(&self) -> bool {
        matches!(self, Self::Allowed { .. })
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Allowed { .. } => None,
            Self::Refused { reason, .. } => Some(reason),
        }
    }

    pub fn blockers(&self) -> &[String] {
        match self {
            Self::Allowed { .. } => &[],
            Self::Refused { blockers, .. } => blockers,
        }
    }

    pub fn warnings(&self) -> &[String] {
        match self {
            Self::Allowed { warnings } | Self::Refused { warnings, .. } => warnings,
        }
    }
}

/// Acceptance is only required where it can be measured.
///
/// Today only the specs artifact carries per-requirement review, so a prose
/// artifact (proposal, design, tasks) is gated on existence alone. Claiming
/// otherwise would either block every change forever or quietly treat
/// "unreviewable" as "reviewed" — both worse than saying so. Document-level
/// review is follow-up work; until it lands this function is deliberately
/// honest about what it cannot check.
fn describe_blocker(stage: &Stage) -> Option<String> {
    if matches!(stage.state, StageState::Ready | StageState::Blocked) {
        return Some(format!("{} has not been written yet", stage.id));
    }
    // Written, and nothing reviewable to check.
    let review = stage.review?;
    if review.complete {
        return None;
    }

    if review.total == 0 {
        return Some(format!(
            "{} has no requirements that could be reviewed",
            stage.id
        ));
    }
    let mut parts: Vec<String> = Vec::new();
    if review.pending > 0 {
        parts.push(format!("{} pending", review.pending));
    }
    if review.rejected > 0 {
        parts.push(format!("{} rejected", review.rejected));
    }
    let detail = if parts.is_empty() {
        "unreviewed".to_owned()
    } else {
        parts.join(" and ")
    };
    Some(format!(
        "{}: {detail} of {} requirements",
        stage.id, review.total
    ))
}

/// A prerequisite that drifted after this artifact was written against it.
fn describe_staleness(stage: &Stage) -> Option<String> {
    let drifted = stage.review.map_or(0, |r| r.drifted);
    (drifted > 0).then(|| {
        format!(
            "{} changed after review ({drifted} requirement{})",
            stage.id,
            if drifted == 1 { "" } else { "s" }
        )
    })
}

pub fn gate_for(pipeline: &ChangePipeline, artifact_id: &str) -> GateDecision {
    let Some(target) = pipeline.all_stages().find(|s| s.id == artifact_id) else {
        let known: Vec<&str> = pipeline.all_stages().map(|s| s.id.as_str()).collect();
        return GateDecision::Refused {
            reason: format!("{} has no artifact called '{artifact_id}'", pipeline.name),
            blockers: vec![format!("known artifacts: {}", known.join(", "))],
            warnings: Vec::new(),
        };
    };

    let mut blockers: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for id in &target.requires {
        let Some(prerequisite) = pipeline.stages.iter().find(|s| &s.id == id) else {
            // A schema naming a prerequisite that is not an artifact is a
            // broken schema; refusing is safer than silently ignoring the
            // dependency.
            blockers.push(format!(
                "{id} is required but is not an artifact in this schema"
            ));
            continue;
        };
        if let Some(blocker) = describe_blocker(prerequisite) {
            blockers.push(blocker);
        }
        if let Some(stale) = describe_staleness(prerequisite) {
            warnings.push(stale);
        }
    }

    if blockers.is_empty() {
        GateDecision::Allowed { warnings }
    } else {
        GateDecision::Refused {
            reason: format!("{artifact_id} is not ready to be written"),
            blockers,
            warnings,
        }
    }
}

/// Artifacts written against a prerequisite that has since changed.
///
/// The exact failure the sequencing fix is meant to prevent: a design written
/// against specs that were edited afterwards is silently wrong, and nothing in
/// OpenSpec notices because both files still exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleArtifact {
    pub artifact: String,
    pub because: Vec<String>,
}

pub fn stale_artifacts(pipeline: &ChangePipeline) -> Vec<StaleArtifact> {
    let mut out = Vec::new();
    for stage in &pipeline.stages {
        if !matches!(stage.state, StageState::Written | StageState::Accepted) {
            continue;
        }
        let because: Vec<String> = stage
            .requires
            .iter()
            .filter_map(|id| pipeline.stages.iter().find(|s| &s.id == id))
            .filter_map(describe_staleness)
            .collect();
        if !because.is_empty() {
            out.push(StaleArtifact {
                artifact: stage.id.clone(),
                because,
            });
        }
    }
    out
}

/// Whether the project's ground rules have been settled.
///
/// The first change's design otherwise invents the architecture implicitly, and
/// every later change inherits an accident (docs/problem-analysis.md §9). So
/// the first artifact of a change is gated on the Foundation being answered.
///
/// A project with no Foundation at all is not blocked: spec-tacular has to stay
/// usable on a repository that adopted OpenSpec before it existed. Only a
/// scaffolded-but-unanswered Foundation blocks, because there the questions
/// have been asked and left hanging.
pub fn foundation_gate(project_root: impl AsRef<Path>) -> GateDecision {
    let project_root = project_root.as_ref();
    if !foundation_exists(project_root) {
        return GateDecision::Allowed {
            warnings: vec![
                "no Foundation yet — run `spectacular init` to set the ground rules".to_owned(),
            ],
        };
    }

    let unanswered: Vec<String> = load_foundation(project_root)
        .iter()
        .filter(|item| is_unanswered(item))
        .map(|item| format!("{}: {}", item.capability, item.name))
        .collect();
    if unanswered.is_empty() {
        return GateDecision::Allowed {
            warnings: Vec::new(),
        };
    }

    GateDecision::Refused {
        reason: "the project's ground rules are not settled yet".to_owned(),
        blockers: unanswered,
        warnings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::types::{OpenSpecArtifact, OpenSpecChangeStatus};
    use crate::core::foundation::{foundation_dir, scaffold_foundation};
    use crate::core::pipeline::fixtures::{artifact, reviews, summary};
    use crate::core::pipeline::{build_pipeline, ReviewByArtifact};
    use crate::core::review::ReviewSummary;

    /// The spec-tacular schema's shape: design requires specs.
    fn status(artifacts: Vec<OpenSpecArtifact>) -> OpenSpecChangeStatus {
        OpenSpecChangeStatus {
            change_name: "c".to_owned(),
            schema_name: "spec-tacular".to_owned(),
            change_root: "/tmp/c".to_owned(),
            apply_requires: vec!["tasks".to_owned()],
            artifacts,
            ..OpenSpecChangeStatus::default()
        }
    }

    fn sequenced() -> Vec<OpenSpecArtifact> {
        vec![
            artifact("proposal", "done", &[]),
            artifact("specs", "done", &["proposal"]),
            artifact("design", "ready", &["specs"]),
            artifact("tasks", "blocked", &["specs", "design"]),
        ]
    }

    fn pipeline(r: &ReviewByArtifact) -> ChangePipeline {
        build_pipeline(&status(sequenced()), r)
    }

    fn none() -> ReviewByArtifact {
        ReviewByArtifact::new()
    }

    #[test]
    fn refuses_design_while_spec_requirements_are_still_pending() {
        // M4's exit criterion.
        let gate = gate_for(
            &pipeline(&reviews(&[(
                "specs",
                ReviewSummary {
                    accepted: 4,
                    pending: 6,
                    complete: false,
                    ..summary()
                },
            )])),
            "design",
        );
        assert!(!gate.allowed());
        assert!(gate
            .reason()
            .expect("a reason")
            .contains("design is not ready"));
        assert_eq!(gate.blockers(), ["specs: 6 pending of 10 requirements"]);
    }

    #[test]
    fn a_rejected_requirement_blocks_just_as_a_pending_one_does() {
        let gate = gate_for(
            &pipeline(&reviews(&[(
                "specs",
                ReviewSummary {
                    accepted: 8,
                    rejected: 2,
                    complete: false,
                    ..summary()
                },
            )])),
            "design",
        );
        assert_eq!(gate.blockers()[0], "specs: 2 rejected of 10 requirements");
    }

    #[test]
    fn counts_both_pending_and_rejected_in_the_reason() {
        let gate = gate_for(
            &pipeline(&reviews(&[(
                "specs",
                ReviewSummary {
                    accepted: 5,
                    pending: 3,
                    rejected: 2,
                    complete: false,
                    ..summary()
                },
            )])),
            "design",
        );
        assert_eq!(
            gate.blockers()[0],
            "specs: 3 pending and 2 rejected of 10 requirements"
        );
    }

    #[test]
    fn allows_design_once_every_requirement_is_accepted() {
        assert!(gate_for(&pipeline(&reviews(&[("specs", summary())])), "design").allowed());
    }

    #[test]
    fn deferred_requirements_do_not_block_that_is_the_point_of_deferring() {
        let gate = gate_for(
            &pipeline(&reviews(&[(
                "specs",
                ReviewSummary {
                    accepted: 8,
                    deferred: 2,
                    complete: true,
                    ..summary()
                },
            )])),
            "design",
        );
        assert!(gate.allowed());
    }

    #[test]
    fn refuses_when_a_prerequisite_has_not_been_written_at_all() {
        let p = build_pipeline(
            &status(vec![
                artifact("proposal", "ready", &[]),
                artifact("specs", "blocked", &["proposal"]),
            ]),
            &none(),
        );
        assert_eq!(
            gate_for(&p, "specs").blockers(),
            ["proposal has not been written yet"]
        );
    }

    #[test]
    fn an_artifact_with_no_prerequisites_is_always_allowed() {
        assert!(gate_for(&pipeline(&none()), "proposal").allowed());
    }

    #[test]
    fn reports_every_unmet_prerequisite_not_just_the_first() {
        let p = build_pipeline(
            &status(vec![
                artifact("proposal", "done", &[]),
                artifact("specs", "ready", &["proposal"]),
                artifact("design", "ready", &["specs"]),
                artifact("tasks", "blocked", &["specs", "design"]),
            ]),
            &none(),
        );
        assert_eq!(
            gate_for(&p, "tasks").blockers(),
            [
                "specs has not been written yet",
                "design has not been written yet"
            ]
        );
    }

    #[test]
    fn an_unknown_artifact_is_refused_and_the_known_ones_are_listed() {
        let gate = gate_for(&pipeline(&none()), "nonsense");
        assert!(!gate.allowed());
        assert!(gate.blockers()[0].contains("proposal, specs, design, tasks"));
    }

    #[test]
    fn a_prerequisite_that_is_not_an_artifact_in_the_schema_is_refused_not_ignored() {
        let p = build_pipeline(
            &status(vec![
                artifact("proposal", "done", &[]),
                artifact("design", "ready", &["ghost"]),
            ]),
            &none(),
        );
        assert!(gate_for(&p, "design").blockers()[0].contains("ghost is required"));
    }

    #[test]
    fn a_prose_artifact_is_gated_on_existence_since_acceptance_is_unmeasurable_there() {
        // Honest about what cannot be checked: requiring acceptance with no
        // review data would block forever, and assuming it would be a lie.
        assert!(gate_for(&pipeline(&none()), "specs").allowed());
    }

    #[test]
    fn apply_is_gated_by_the_schema_apply_requires() {
        assert!(!gate_for(&pipeline(&none()), "apply").allowed());
    }

    fn drifted() -> ReviewByArtifact {
        reviews(&[(
            "specs",
            ReviewSummary {
                accepted: 9,
                pending: 1,
                drifted: 1,
                complete: false,
                ..summary()
            },
        )])
    }

    #[test]
    fn drift_on_a_prerequisite_blocks_and_warns() {
        let gate = gate_for(&pipeline(&drifted()), "design");
        assert!(!gate.allowed());
        assert_eq!(
            gate.warnings(),
            ["specs changed after review (1 requirement)"]
        );
    }

    #[test]
    fn a_written_artifact_whose_prerequisite_drifted_is_flagged_stale() {
        // Both files still exist, so OpenSpec reports this change as fine.
        let p = build_pipeline(
            &status(vec![
                artifact("proposal", "done", &[]),
                artifact("specs", "done", &["proposal"]),
                artifact("design", "done", &["specs"]),
            ]),
            &drifted(),
        );
        assert_eq!(
            stale_artifacts(&p),
            vec![StaleArtifact {
                artifact: "design".to_owned(),
                because: vec!["specs changed after review (1 requirement)".to_owned()],
            }]
        );
    }

    #[test]
    fn nothing_is_stale_when_no_prerequisite_drifted() {
        let p = build_pipeline(
            &status(vec![
                artifact("proposal", "done", &[]),
                artifact("specs", "done", &["proposal"]),
                artifact("design", "done", &["specs"]),
            ]),
            &reviews(&[("specs", summary())]),
        );
        assert!(stale_artifacts(&p).is_empty());
    }

    #[test]
    fn an_unwritten_artifact_is_never_stale() {
        assert!(stale_artifacts(&pipeline(&drifted())).is_empty());
    }

    #[test]
    fn pluralizes_the_drift_count() {
        let gate = gate_for(
            &pipeline(&reviews(&[(
                "specs",
                ReviewSummary {
                    accepted: 7,
                    pending: 3,
                    drifted: 3,
                    complete: false,
                    ..summary()
                },
            )])),
            "design",
        );
        assert!(gate.warnings()[0].contains("(3 requirements)"));
    }

    #[test]
    fn a_scaffolded_but_unanswered_foundation_blocks_naming_what_is_open() {
        let r = tempfile::tempdir().expect("a temp dir");
        scaffold_foundation(r.path()).expect("the scaffold writes");
        let gate = foundation_gate(r.path());
        assert!(!gate.allowed());
        assert!(gate
            .reason()
            .expect("a reason")
            .contains("ground rules are not settled"));
        assert!(!gate.blockers().is_empty());
        assert!(gate.blockers()[0].contains("foundation/"));
    }

    #[test]
    fn an_answered_foundation_allows() {
        let r = tempfile::tempdir().expect("a temp dir");
        std::fs::create_dir_all(foundation_dir(r.path())).expect("the foundation dir");
        std::fs::write(
            foundation_dir(r.path()).join("stack.md"),
            "# Stack\n\n## Language\n\nTypeScript.\n",
        )
        .expect("the file writes");
        assert!(foundation_gate(r.path()).allowed());
    }

    #[test]
    fn no_foundation_at_all_warns_but_never_blocks() {
        // spec-tacular must stay usable on a repo that adopted OpenSpec before
        // it existed.
        let r = tempfile::tempdir().expect("a temp dir");
        let gate = foundation_gate(r.path());
        assert!(gate.allowed());
        assert!(gate.warnings()[0].contains("no Foundation yet"));
    }
}
