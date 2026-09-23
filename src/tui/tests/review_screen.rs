//! The review screen, by keystroke — the TypeScript `review-screen` suite,
//! run through the whole app rather than the screen alone: `r` on the
//! overview opens it, every decision lands in the sidecar on disk, and `q`
//! brings the overview back with the new count.

use std::fs;

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::review::{load_review, ReviewState};
use crate::tui::app::Screen;

const SPEC: &str = "## ADDED Requirements

### Requirement: Theme selection
The app SHALL let users switch between light and dark themes.

#### Scenario: User toggles dark mode
- **WHEN** the user clicks the theme toggle
- **THEN** the app switches to dark mode

### Requirement: Export data
The app SHALL let users export their data.
";

fn mount() -> Ui {
    Ui::reviewing("c", &[("cap", SPEC)], None)
}

#[test]
fn shows_one_requirement_with_its_scenario_and_the_key_hints() {
    let mut ui = mount();
    ui.expect("Requirement: Theme selection");
    ui.expect("Scenario: User toggles dark mode");
    ui.expect("the user clicks the theme toggle");
    ui.expect("requirement 1 of 2");
    ui.expect("a accept");
    // One decision at a time: the next requirement must not be on screen.
    ui.expect_not("Requirement: Export data");
    // Where you are, in the header and the panel.
    ui.expect("› c › specs");
    ui.expect("╭─ c › review ─");
    ui.expect("cap   requirement 1 of 2   [ADDED]");
}

#[test]
fn progress_counts_are_on_screen_from_the_start() {
    let mut ui = mount();
    ui.expect("0 accepted · 2 pending");
    ui.expect("░░░░░░░░░░░░░░░░░░░░░░░░░░░░");
}

#[test]
fn a_accepts_and_advances_to_the_next_requirement() {
    let mut ui = mount();
    ui.char('a');
    assert_eq!(ui.session().items[0].state, ReviewState::Accepted);
    ui.expect("Requirement: Export data");
    ui.expect("requirement 2 of 2");
    ui.expect("1 accepted · 1 pending");
}

#[test]
fn every_decision_is_on_disk_before_the_next_key() {
    let mut ui = mount();
    ui.char('a');
    let stored = load_review(ui.ports.path(), "c");
    let id = &ui.session().items[0].item.id;
    assert_eq!(stored.requirements[id].state, ReviewState::Accepted);
    // …and so is where you are.
    assert_eq!(
        stored.cursor_id(),
        Some(ui.session().items[1].item.id.as_str())
    );
}

#[test]
fn n_and_p_move_without_deciding() {
    let mut ui = mount();
    ui.char('n');
    ui.expect("requirement 2 of 2");
    ui.char('p');
    ui.expect("requirement 1 of 2");
    ui.press(KeyCode::Down);
    ui.expect("requirement 2 of 2");
    ui.char('k');
    ui.expect("requirement 1 of 2");
    assert_eq!(ui.session().summary.pending, 2);
}

#[test]
fn s_skips_without_recording_a_decision() {
    let mut ui = mount();
    ui.char('s');
    assert_eq!(ui.session().items[0].state, ReviewState::Pending);
    ui.expect("requirement 2 of 2");
}

#[test]
fn r_prompts_for_a_reason_and_records_it() {
    let mut ui = mount();
    ui.char('r');
    ui.expect("Why reject?");
    ui.type_text("names an endpoint");
    ui.expect("names an endpoint_");
    ui.press(KeyCode::Enter);
    let item = &ui.session().items[0];
    assert_eq!(item.state, ReviewState::Rejected);
    assert_eq!(item.review.note.as_deref(), Some("names an endpoint"));
    ui.expect("1 rejected");
}

#[test]
fn an_empty_rejection_reason_is_allowed() {
    let mut ui = mount();
    ui.char('r');
    ui.press(KeyCode::Enter);
    assert_eq!(ui.session().items[0].state, ReviewState::Rejected);
}

#[test]
fn ctrl_c_cancels_a_prompt_without_deciding() {
    // Not escape: a lone ESC is the prefix of every escape sequence, so a
    // terminal parser cannot deliver it until it sees what follows.
    let mut ui = mount();
    ui.char('r');
    ui.type_text("half a thought");
    ui.ctrl('c');
    assert_eq!(ui.session().items[0].state, ReviewState::Pending);
    ui.expect_not("half a thought");
    assert_eq!(ui.app.screen, Screen::Review, "one level, not two");
}

#[test]
fn ctrl_c_at_the_top_level_goes_back_and_never_quits() {
    let mut ui = mount();
    ui.ctrl('c');
    assert_eq!(ui.app.screen, Screen::Overview);
    assert!(!ui.app.quit);
}

#[test]
fn backspace_edits_the_prompt_draft() {
    let mut ui = mount();
    ui.char('r');
    ui.type_text("abc");
    ui.press(KeyCode::Backspace);
    ui.expect("ab_");
    ui.press(KeyCode::Enter);
    assert_eq!(ui.session().items[0].review.note.as_deref(), Some("ab"));
}

#[test]
fn d_refuses_an_empty_reason_because_a_deferral_must_say_what_would_verify_it() {
    let mut ui = mount();
    ui.char('d');
    ui.expect("What would verify it?");
    ui.expect("a reason is required");
    ui.press(KeyCode::Enter);
    // Still prompting, nothing decided.
    assert_eq!(ui.session().items[0].state, ReviewState::Pending);
    ui.expect("What would verify it?");

    ui.type_text("needs a deployed instance");
    ui.press(KeyCode::Enter);
    let item = &ui.session().items[0];
    assert_eq!(item.state, ReviewState::Deferred);
    assert_eq!(
        item.review.defer_reason.as_deref(),
        Some("needs a deployed instance")
    );
}

#[test]
fn keys_that_decide_are_inert_while_a_prompt_is_open() {
    let mut ui = mount();
    ui.char('r');
    ui.char('a'); // must type an 'a', not accept
    assert_eq!(ui.session().items[0].state, ReviewState::Pending);
    ui.press(KeyCode::Enter);
    assert_eq!(ui.session().items[0].review.note.as_deref(), Some("a"));
}

#[test]
fn question_mark_shows_help_and_any_key_dismisses_it() {
    let mut ui = mount();
    ui.char('?');
    ui.expect("asks what would verify it");
    ui.char('a'); // dismisses, does not accept
    assert_eq!(ui.session().items[0].state, ReviewState::Pending);
    ui.expect_not("asks what would verify it");
}

#[test]
fn e_opens_the_item_in_the_editor_at_its_line_and_q_goes_back() {
    let mut ui = mount();
    ui.char('e');
    let (file, line) = ui.editors.last().cloned().expect("an editor");
    assert!(
        file.ends_with("openspec/changes/c/specs/cap/spec.md"),
        "{file:?}"
    );
    assert_eq!(line, 3);
    assert_eq!(ui.app.screen, Screen::Review, "back in the review after");
    ui.char('q');
    assert_eq!(ui.app.screen, Screen::Overview);
    assert!(!ui.app.quit);
}

#[test]
fn an_edit_after_acceptance_is_drift_and_says_so() {
    let mut ui = mount();
    ui.char('a');
    ui.char('p');
    ui.expect("accepted");
    ui.on_edit = Some(Box::new(|file| {
        let text = fs::read_to_string(file).expect("spec");
        fs::write(file, text.replacen("SHALL", "MUST", 1)).expect("spec");
    }));
    ui.char('e');
    ui.expect("The app MUST let users switch");
    ui.expect("! changed since you marked it accepted — review it again");
    ui.expect("0 accepted");
}

#[test]
fn a_decided_requirement_shows_its_state_when_revisited() {
    let mut ui = mount();
    ui.char('r');
    ui.type_text("too vague");
    ui.press(KeyCode::Enter);
    ui.char('p');
    ui.expect("rejected — too vague");
}

#[test]
fn an_empty_queue_says_so_instead_of_rendering_nothing() {
    let mut ui = Ui::reviewing("c", &[("cap", "## ADDED Requirements\n")], None);
    ui.expect("Nothing to review");
}

#[test]
fn leaving_the_review_updates_the_overview() {
    let mut ui = mount();
    ui.expect_not("▸ c");
    ui.char('a');
    ui.char('q');
    ui.expect("▸ c");
    ui.expect("1/2");
}

#[test]
fn a_change_without_specs_has_nothing_to_review() {
    let mut ui = Ui::ready_for_first_change(crate::tui::fake::FakePorts::with_baseline());
    ui.ports.add_spec_change("c", &[], None);
    ui.reload();
    ui.char('r');
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("c has no specs to review yet");
}

#[test]
fn enter_on_the_review_button_opens_it_and_ctrl_j_still_works_from_it() {
    let mut ui = Ui::with_spec_change("c", &[("cap", SPEC)], None);
    ui.expect("▶ Review  enter");
    ui.press(KeyCode::Enter);
    assert_eq!(ui.app.screen, Screen::Review);
    ui.ctrl('j');
    assert!(ui.app.jobs_open);
    ui.ctrl('j');
    assert_eq!(ui.app.screen, Screen::Review, "your place is kept");
    ui.expect("Requirement: Theme selection");
}
