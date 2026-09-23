//! Promoting a decision to a project-wide ADR — the TypeScript
//! `promote-e2e` suite: a decision promoted while reviewing change A appears
//! in the context of change B's design generation, and `p` on the review
//! screen promotes only a global decision.

use std::fs;

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::context::{build_context, build_prompt};
use crate::core::decisions::{
    list_adrs, parse_decisions, promote_decision, replace_decision_body, Decision, DecisionScope,
    PromoteOptions,
};
use crate::core::review::ReviewState;

const DESIGN_A: &str = "# Design

## Decisions

### Errors are values
**Scope: global**

**Decision:** Every fallible operation returns a result type rather than throwing.

**Rationale:** Exceptions escape the type checker.

### Cache the schema in memory
**Scope: local**

**Decision:** Parse once per process.
";

/// A spec file with no requirements, so the queue is the design alone.
const NO_REQUIREMENTS: &str = "## ADDED Requirements\n";

fn project() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let change = dir.path().join("changes/change-a");
    fs::create_dir_all(&change).expect("change");
    let design = change.join("design.md");
    fs::write(&design, DESIGN_A).expect("design");
    (dir, design)
}

fn load(design: &std::path::Path) -> Vec<Decision> {
    parse_decisions(
        &fs::read_to_string(design).expect("design"),
        &design.display().to_string(),
    )
}

fn change_a() -> Option<String> {
    Some("change-a".to_owned())
}

// --- promotion end to end -----------------------------------------------------

#[test]
fn a_decision_promoted_in_change_a_reaches_change_bs_prompt() {
    let (root, design) = project();
    let global = &load(&design)[0];
    let promoted = promote_decision(
        root.path(),
        global,
        &PromoteOptions {
            change: change_a(),
            supersedes: None,
        },
    )
    .expect("promote");
    replace_decision_body(global, &promoted.reference).expect("reference");

    // Change B knows nothing about change A; it only reads the project store.
    let prompt = build_prompt(
        &build_context(root.path(), &[]),
        "WRITE THE DESIGN FOR CHANGE B",
    );
    assert!(
        prompt.contains("Accepted architectural decisions"),
        "{prompt}"
    );
    assert!(prompt.contains(&format!("ADR-000{}", promoted.adr.number)));
    assert!(prompt.contains("returns a result type rather than throwing"));
    assert!(prompt.contains("never diverge silently"));
    let rule = prompt.find("result type").expect("rule");
    let task = prompt.find("WRITE THE DESIGN").expect("task");
    assert!(rule < task);
}

#[test]
fn change_a_keeps_a_reference_so_the_two_cannot_drift() {
    let (root, design) = project();
    let global = &load(&design)[0];
    let promoted = promote_decision(
        root.path(),
        global,
        &PromoteOptions {
            change: change_a(),
            supersedes: None,
        },
    )
    .expect("promote");
    replace_decision_body(global, &promoted.reference).expect("reference");

    let updated = fs::read_to_string(&design).expect("design");
    assert!(updated.contains("### Errors are values"));
    assert!(updated.contains("ADR-0001"));
    assert!(!updated.contains("Exceptions escape the type checker."));
    // The local decision is untouched.
    assert!(updated.contains("Parse once per process."));
}

#[test]
fn a_local_decision_is_not_promotable() {
    let (_root, design) = project();
    assert_eq!(load(&design)[1].scope, DecisionScope::Local);
}

// --- promoting from the review screen -------------------------------------------

fn reviewing(design: &str) -> Ui {
    Ui::reviewing("change-a", &[("cap", NO_REQUIREMENTS)], Some(design))
}

#[test]
fn a_global_decision_offers_promotion_and_p_performs_it() {
    let mut ui = reviewing(DESIGN_A);
    ui.expect("decision 1 of 2");
    ui.expect("marked global — p promotes it");
    ui.expect("p promote to ADR");

    ui.char('p');
    ui.expect("promoted to ADR-0001");
    let adrs = list_adrs(ui.ports.path());
    assert_eq!(adrs.len(), 1);
    assert_eq!(adrs[0].title, "Errors are values");
    let design = fs::read_to_string(ui.ports.path().join("openspec/changes/change-a/design.md"))
        .expect("design");
    assert!(design.contains("See ADR-0001"), "{design}");

    // The session was refreshed from the rewritten file: the decision now
    // reads as its reference, and is no longer offered for promotion.
    ui.expect("See ADR-0001");
    ui.expect_not("marked global");
    ui.expect("decision 1 of 2");
}

#[test]
fn on_a_local_decision_p_is_still_previous() {
    // The two share a key; only a global decision reassigns it.
    let local_first = DESIGN_A.replace("**Scope: global**", "**Scope: local**");
    let mut ui = reviewing(&local_first);
    ui.char('n');
    ui.expect("decision 2 of 2");
    ui.expect_not("marked global");
    ui.char('p');
    ui.expect("decision 1 of 2");
    assert!(list_adrs(ui.ports.path()).is_empty());
}

#[test]
fn a_decision_renders_without_scenarios_and_is_still_acceptable() {
    let mut ui = reviewing(DESIGN_A);
    // Named for what it is: a decision is not a requirement.
    ui.expect("Decision: Errors are values");
    ui.expect_not("Scenario");
    ui.char('a');
    assert_eq!(ui.session().summary.accepted, 1);
    assert_eq!(ui.session().items[0].state, ReviewState::Accepted);
}

#[test]
fn decisions_follow_the_requirements_in_one_pass() {
    let spec = "## ADDED Requirements\n\n### Requirement: Alpha\nThe system SHALL alpha.\n";
    let mut ui = Ui::reviewing("change-a", &[("cap", spec)], Some(DESIGN_A));
    ui.expect("requirement 1 of 3");
    ui.char('a');
    ui.expect("design   decision 2 of 3");
    ui.expect("Decision: Errors are values");
    ui.press(KeyCode::Up);
    ui.expect("Requirement: Alpha");
}
