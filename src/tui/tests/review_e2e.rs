//! A real change reviewed end to end by keystroke — the TypeScript
//! `review-e2e` suite.
//!
//! Real spec files from the OpenSpec repository (its
//! `simplify-skill-installation` change, copied into `tests/fixtures/` with
//! its licence), real parsing, and a real sidecar on disk; only `openspec
//! status` is stepped around. The TypeScript ran this only where a checkout
//! of OpenSpec happened to sit at a fixed path; the fixture makes it run
//! everywhere.

use std::path::Path;

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::requirements::{capability_from_path, parse_spec_file, Requirement};
use crate::core::review::{load_review, ReviewState};
use crate::tui::app::Screen;
use crate::tui::fake::FakePorts;

const CHANGE: &str = "simplify-skill-installation";

fn fixture() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/simplify-skill-installation/specs"
    ))
}

/// The fixture's requirements, in queue order.
fn real_requirements() -> Vec<Requirement> {
    let mut files: Vec<_> = std::fs::read_dir(fixture())
        .expect("fixture")
        .flatten()
        .map(|e| e.path().join("spec.md"))
        .collect();
    files.sort();
    files
        .iter()
        .flat_map(|f| {
            let file = f.display().to_string();
            let content = std::fs::read_to_string(f).expect("spec");
            parse_spec_file(&content, &capability_from_path(&file), &file).requirements
        })
        .collect()
}

fn mount() -> Ui {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_fixture_change(CHANGE, fixture());
    ui.reload();
    ui.char('r');
    assert_eq!(ui.app.screen, Screen::Review);
    ui
}

#[test]
fn the_fixture_is_the_large_change_the_review_is_meant_to_handle() {
    assert_eq!(real_requirements().len(), 26);
}

#[test]
fn accepts_every_requirement_by_keyboard_then_reports_complete() {
    let total = real_requirements().len();
    let mut ui = mount();
    ui.expect(&format!("requirement 1 of {total}"));
    for _ in 0..total {
        ui.char('a');
    }
    let summary = ui.session().summary;
    assert_eq!(summary.total, total);
    assert_eq!(summary.accepted, total);
    assert_eq!(summary.pending, 0);
    assert!(summary.complete);
    ui.expect(&format!("{total} accepted"));
    ui.expect(&"█".repeat(28));

    // And the overview agrees.
    ui.char('q');
    ui.expect(&format!("{total}/{total}"));
}

#[test]
fn quits_halfway_and_resumes_at_the_same_requirement() {
    let mut ui = mount();
    for _ in 0..7 {
        ui.char('a');
    }
    let stopped_at = ui.session().items[ui.session().cursor].item.id.clone();
    assert_eq!(ui.session().summary.accepted, 7);
    ui.char('q');
    ui.expect("7/26");

    // Opened again, it reads only what is on disk — the same thing a fresh
    // process would do.
    ui.char('r');
    assert_eq!(ui.session().summary.accepted, 7);
    assert_eq!(ui.session().items[ui.session().cursor].item.id, stopped_at);
    ui.expect("7 accepted");
    ui.expect("requirement 8 of 26");
}

#[test]
fn a_mixed_pass_records_each_decision_with_its_reason_and_survives_a_restart() {
    let requirements = real_requirements();
    let mut ui = mount();
    ui.char('a');
    ui.char('r');
    ui.type_text("names an endpoint that is not decided");
    ui.press(KeyCode::Enter);
    ui.char('d');
    ui.type_text("needs a deployed instance");
    ui.press(KeyCode::Enter);
    ui.char('s');

    let stored = load_review(ui.ports.path(), CHANGE);
    let states: Vec<ReviewState> = requirements[..4]
        .iter()
        .map(|r| {
            stored
                .requirements
                .get(&r.id)
                .map_or(ReviewState::Pending, |s| s.state)
        })
        .collect();
    assert_eq!(
        states,
        [
            ReviewState::Accepted,
            ReviewState::Rejected,
            ReviewState::Deferred,
            ReviewState::Pending
        ]
    );
    assert_eq!(
        stored.requirements[&requirements[1].id].note.as_deref(),
        Some("names an endpoint that is not decided")
    );
    assert_eq!(
        stored.requirements[&requirements[2].id]
            .defer_reason
            .as_deref(),
        Some("needs a deployed instance")
    );
}

#[test]
fn rejected_requirements_come_back_around_in_the_same_pass() {
    let requirements = real_requirements();
    let mut ui = mount();
    // Reject the first, accept every other one; the rejection is the only
    // thing left needing attention, so review must return to it.
    ui.char('r');
    ui.press(KeyCode::Enter);
    for _ in 1..requirements.len() {
        ui.char('a');
    }
    assert_eq!(
        ui.session().items[ui.session().cursor].item.id,
        requirements[0].id
    );
    assert_eq!(ui.session().summary.rejected, 1);
    assert!(!ui.session().summary.complete);
}
