//! Concreteness findings in the review, and marking one as an example — the
//! TypeScript `review-lint` suite. Marking really rewrites the spec file
//! here, and the queue is re-parsed from it, so what is asserted is the file
//! and the screen rather than a callback.

use std::fs;

use super::Ui;
use crate::core::review::ReviewState;

const SPEC: &str = "## ADDED Requirements

### Requirement: Export
The system SHALL expose POST /v1/export and store user_email, returning {{example: CSV}}.

#### Scenario: Works
- **WHEN** called
- **THEN** it works
";

fn mount() -> Ui {
    Ui::reviewing("c", &[("cap", SPEC)], None)
}

fn spec_file(ui: &Ui) -> String {
    fs::read_to_string(ui.ports.path().join("openspec/changes/c/specs/cap/spec.md")).expect("spec")
}

// --- findings in review -----------------------------------------------------

#[test]
fn shows_each_finding_numbered_as_a_question() {
    let mut ui = mount();
    ui.expect("1. names an HTTP endpoint: POST /v1/export");
    ui.expect("2. names a field or table: user_email");
    ui.expect("m mark example");
}

#[test]
fn already_marked_values_are_shown_as_examples_not_flagged() {
    let mut ui = mount();
    ui.expect("examples, not contracts: CSV");
    assert!(ui.app.findings().iter().all(|f| f.value != "CSV"));
}

#[test]
fn the_requirement_reads_without_the_braces() {
    let mut ui = mount();
    ui.expect("returning CSV.");
    ui.expect_not("{{example:");
}

#[test]
fn a_finding_never_blocks_acceptance_the_linter_is_advisory() {
    let mut ui = mount();
    ui.char('a');
    assert_eq!(ui.session().items[0].state, ReviewState::Accepted);
}

// --- marking a value as an example ------------------------------------------

#[test]
fn m_then_a_number_marks_that_finding_in_the_file() {
    let mut ui = mount();
    ui.char('m');
    ui.expect("Mark which as an example? 1-2");
    ui.char('1');
    assert!(
        spec_file(&ui).contains("{{example: POST /v1/export}}"),
        "{}",
        spec_file(&ui)
    );
    // Re-parsed: it is an example now, not a finding.
    ui.expect("examples, not contracts: POST /v1/export, CSV");
    ui.expect("1. names a field or table: user_email");
    ui.expect_not("names an HTTP endpoint");
}

#[test]
fn picks_the_numbered_finding_not_the_first() {
    let mut ui = mount();
    ui.char('m');
    ui.char('2');
    let spec = spec_file(&ui);
    assert!(spec.contains("{{example: user_email}}"), "{spec}");
    assert!(!spec.contains("{{example: POST"), "{spec}");
}

#[test]
fn marking_an_accepted_requirement_drops_it_back_as_drift() {
    // The text changed, so the hash changed: an accepted requirement must
    // come back for review exactly as any other edit would make it.
    let mut ui = mount();
    ui.char('a');
    ui.char('p');
    ui.char('m');
    ui.char('1');
    ui.expect("! changed since you marked it accepted — review it again");
    ui.expect("0 accepted");
}

#[test]
fn an_out_of_range_number_cancels_rather_than_marking_something_arbitrary() {
    let mut ui = mount();
    ui.char('m');
    ui.char('9');
    assert_eq!(spec_file(&ui), SPEC);
    ui.expect_not("Mark which as an example?");
}

#[test]
fn any_other_key_cancels() {
    let mut ui = mount();
    ui.char('m');
    ui.char('z');
    assert_eq!(spec_file(&ui), SPEC);
    ui.expect_not("Mark which as an example?");
}

#[test]
fn marking_mode_swallows_decision_keys() {
    // Otherwise `m` then a mistyped `a` would silently accept.
    let mut ui = mount();
    ui.char('m');
    ui.char('a');
    assert_eq!(ui.session().items[0].state, ReviewState::Pending);
    assert_eq!(spec_file(&ui), SPEC);
}

#[test]
fn m_does_nothing_when_there_is_nothing_flagged() {
    let clean = "## ADDED Requirements\n\n### Requirement: Clean\nThe system SHALL let a user export data.\n";
    let mut ui = Ui::reviewing("c", &[("cap", clean)], None);
    ui.char('m');
    ui.expect_not("Mark which");
    assert!(!ui.app.review.as_ref().is_some_and(|r| r.marking));
}

#[test]
fn a_file_that_moved_under_the_review_is_refused_not_guessed_at() {
    let mut ui = mount();
    // Something else rewrote the file: the requirement's line no longer
    // holds its header.
    let file = ui.ports.path().join("openspec/changes/c/specs/cap/spec.md");
    fs::write(&file, format!("\n\n{SPEC}")).expect("spec");
    ui.char('m');
    ui.char('1');
    ui.expect("the file changed since it was read — reopen the change");
    assert_eq!(
        fs::read_to_string(&file).expect("spec"),
        format!("\n\n{SPEC}")
    );
}
