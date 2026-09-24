//! An agent's draft: watched while it is written, opened to be read when it
//! lands, and moved on from, edited or redrafted with feedback — the "an
//! agent's draft" half of the TypeScript `vision-e2e` suite, plus the
//! document viewer's own keys.

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::jobs::JobStatus;
use crate::tui::app::Screen;
use crate::tui::fake::{change_with, FakePorts};

const PROPOSAL: &str =
    "# book-rooms\n\n## Why\n\nClinics double-book rooms.\n\n## What Changes\n\n- Add booking\n";

/// A new change, `book-rooms`, with an agent drafting its proposal.
fn drafting() -> Ui {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.char('n');
    ui.type_text("Let users book rooms");
    ui.press(KeyCode::Enter);
    ui.press(KeyCode::Enter); // accept the proposed name
    ui.expect("Created book-rooms.");
    ui.press(KeyCode::Enter); // ✦ Let an agent draft it
    assert_eq!(ui.ports.dispatched(), ["book-rooms/proposal"]);
    ui
}

/// …and the proposal has landed and opened.
fn reading() -> Ui {
    let mut ui = drafting();
    ui.ports.finish_job("book-rooms", "proposal", PROPOSAL);
    ui.poll();
    let frame = ui.frame();
    assert_eq!(ui.app.screen, Screen::Document, "{frame}");
    ui
}

#[test]
fn is_watched_while_it_is_written_then_opens_to_be_read() {
    let mut ui = drafting();
    ui.expect("Claude Code is drafting the proposal");
    ui.expect("reading the ground rules");
    ui.expect("It opens here for you to read when it is done");

    ui.ports.finish_job("book-rooms", "proposal", PROPOSAL);
    ui.poll();
    ui.expect("book-rooms › proposal");
    ui.expect("Clinics double-book rooms.");
    ui.expect("• Add booking");
    ui.expect("✓ Looks good — draft the specs");
    ui.expect("↻ Redraft with feedback");
    ui.expect("✦ The proposal of book-rooms is drafted");

    // Feedback goes back to the agent.
    ui.char('f');
    ui.expect("What should change? The agent redrafts it with this.");
    ui.type_text("mention cancellations");
    ui.expect("› mention cancellations▏");
    ui.press(KeyCode::Enter);
    assert_eq!(
        ui.ports.dispatched().last().map(String::as_str),
        Some("book-rooms/proposal (mention cancellations)")
    );
    assert_eq!(ui.app.screen, Screen::Overview);
}

#[test]
fn looks_good_drafts_the_next_artifact_and_v_reads_it_again() {
    let mut ui = reading();
    ui.press(KeyCode::Enter); // ✓ Looks good — draft the specs
    assert_eq!(
        ui.ports.dispatched().last().map(String::as_str),
        Some("book-rooms/specs")
    );
    ui.expect("Claude Code is drafting the specs");

    ui.char('v');
    ui.expect("book-rooms › proposal");
    assert_eq!(ui.app.screen, Screen::Document);
}

#[test]
fn the_overview_offers_the_latest_draft_to_read() {
    let mut ui = reading();
    ui.char('q');
    assert_eq!(ui.app.screen, Screen::Overview);
    // The emoji is two cells wide; a test frame shows its second half as a
    // space.
    ui.expect("📄  Read the proposal  v");
    let (x, y) = ui.find("Read the proposal");
    ui.click(x, y);
    assert_eq!(ui.app.screen, Screen::Document);
}

#[test]
fn an_empty_redraft_is_not_sent_and_ctrl_c_closes_the_line_not_the_document() {
    let mut ui = reading();
    ui.char('f');
    ui.press(KeyCode::Enter);
    assert_eq!(ui.ports.dispatched(), ["book-rooms/proposal"]);
    ui.expect("What should change?");
    ui.ctrl('c');
    ui.expect_not("What should change?");
    assert_eq!(ui.app.screen, Screen::Document);
    ui.ctrl('c');
    assert_eq!(ui.app.screen, Screen::Overview);
    assert!(!ui.app.quit);
}

#[test]
fn the_buttons_cycle_and_a_click_presses_one() {
    let mut ui = reading();
    ui.press(KeyCode::Right);
    ui.press(KeyCode::Right);
    ui.press(KeyCode::Enter); // ↻ Redraft with feedback
    ui.expect("What should change?");
    ui.ctrl('c');
    ui.press(KeyCode::Left);
    ui.press(KeyCode::Left);
    ui.press(KeyCode::Left); // wraps to ← Back
    ui.press(KeyCode::Enter);
    assert_eq!(ui.app.screen, Screen::Overview);

    ui.char('v');
    let (x, y) = ui.find("← Back");
    ui.click(x, y);
    assert_eq!(ui.app.screen, Screen::Overview);
}

#[test]
fn e_edits_it_and_it_is_read_again_afterwards() {
    let mut ui = reading();
    ui.char('e');
    let (file, line) = ui.editors.last().cloned().expect("an editor");
    assert_eq!(file.display().to_string(), "/tmp/book-rooms/proposal.md");
    assert_eq!(line, 1);
    assert_eq!(ui.app.screen, Screen::Document);
    ui.expect("Clinics double-book rooms.");
}

#[test]
fn a_long_document_scrolls_by_line_by_page_to_the_ends_and_by_wheel() {
    let body: String = (1..=100).map(|i| format!("line {i}\n\n")).collect();
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("long", &["proposal"]));
    ui.ports
        .docs
        .lock()
        .expect("docs")
        .insert("long/proposal".to_owned(), body);
    ui.reload();
    ui.char('v');
    ui.expect("long › proposal · ");
    ui.expect("lines");
    ui.expect("line 1 ");
    ui.char('j');
    ui.char('j');
    ui.expect_not("line 1 ");
    ui.expect("line 2 ");
    ui.char('k');
    ui.char('k');
    ui.expect("line 1 ");
    ui.char('G');
    ui.expect("line 100");
    ui.expect("100% · ");
    ui.char('g');
    ui.expect("line 1 ");
    ui.char(' ');
    ui.expect_not("line 1 ");
    ui.press(KeyCode::PageUp);
    ui.expect("line 1 ");
    ui.wheel(true);
    ui.wheel(true);
    ui.expect_not("line 3 ");
    ui.wheel(false);
    ui.wheel(false);
    ui.expect("line 1 ");
}

#[test]
fn a_draft_does_not_open_by_itself_while_you_are_busy() {
    let mut ui = drafting();
    ui.char('n'); // typing a new change's description
    ui.type_text("something else");
    ui.ports.finish_job("book-rooms", "proposal", PROPOSAL);
    ui.poll();
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("something else");
    ui.expect("✦ The proposal of book-rooms is drafted");
}

#[test]
fn a_draft_the_agent_did_not_write_says_so_and_does_not_open() {
    let mut ui = drafting();
    // It exits 0, but the proposal is still unwritten.
    ui.ports.set_job_status("job-1", JobStatus::Succeeded);
    ui.poll();
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("The agent finished but did not write the proposal — ctrl+j shows what it did");
}

#[test]
fn a_draft_that_cannot_be_read_stays_quietly_behind_its_button() {
    let mut ui = drafting();
    ui.ports.finish_job("book-rooms", "proposal", PROPOSAL);
    ui.ports.docs.lock().expect("docs").clear();
    ui.poll();
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("✦ The proposal of book-rooms is drafted");
    // Asked for, the same failure is worth saying.
    ui.char('v');
    ui.expect("proposal is not a single document");
}
