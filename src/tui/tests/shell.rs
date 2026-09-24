//! The shell: the start screen, the overview, help and the job pane.

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::jobs::JobStatus;
use crate::tui::app::{Effect, Msg, Screen, QUIT_HINT};
use crate::tui::fake::{change_with, job, FakePorts, Names};
use crate::tui::ports::Ports;

// --- the start screen -------------------------------------------------------

#[test]
fn the_start_screen_shows_the_logo_and_a_start_button_that_sets_the_folder_up() {
    let mut ui = Ui::mount(FakePorts::new());
    ui.app.tick = 100; // the logo has typed itself in
    ui.expect("███████╗");
    ui.expect("spec-driven development — every requirement reviewed before it is built");
    ui.expect("This folder is not set up yet — Start sets it up here.");
    ui.expect("▶ Start");
    ui.expect("Quit");

    ui.press(KeyCode::Enter);
    assert_eq!(ui.app.screen, Screen::Foundation);
    ui.expect("Before the first change, settle the ground rules.");
    ui.expect("✓ Set up");
    ui.expect("2. Ground rules");
    ui.expect("▶ Begin — 19 questions");
}

#[test]
fn the_logo_types_itself_in() {
    let mut ui = Ui::mount(FakePorts::new());
    ui.app.tick = 0;
    let first = ui.frame();
    ui.app.tick = 100;
    let whole = ui.frame();
    let count = |frame: &str| frame.matches('█').count();
    assert!(count(&first) > 0);
    assert!(count(&whole) > count(&first) * 5, "{whole}");
}

#[test]
fn a_narrow_terminal_gets_the_compact_logo() {
    let mut ui = Ui::mount_sized(FakePorts::new(), 80, 30);
    ui.app.tick = 100;
    ui.expect_not("███████╗");
    ui.expect("█▀▀");
    ui.expect("▶ Start");
}

#[test]
fn ctrl_c_on_the_start_screen_does_not_quit_it_says_q_does() {
    let mut ui = Ui::mount(FakePorts::new());
    ui.ctrl('c');
    assert!(!ui.app.quit);
    ui.expect(QUIT_HINT);
    ui.char('q');
    assert!(ui.app.quit);
}

#[test]
fn start_screen_buttons_cycle_with_the_arrows_and_the_last_is_quit() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.reload();
    ui.char('h'); // back to the start screen
                  // Working: Open project, New change, Ground rules, Quit.
    ui.press(KeyCode::Enter); // Open project
    ui.char('h');
    ui.expect("1 change");
    ui.press(KeyCode::Right);
    ui.press(KeyCode::Tab);
    ui.press(KeyCode::Right);
    assert_eq!(ui.app.home.focus, 3);
    ui.press(KeyCode::Right);
    assert_eq!(ui.app.home.focus, 0, "focus wraps");
    ui.press(KeyCode::Left);
    ui.press(KeyCode::Enter); // Quit
    assert!(ui.app.quit);
}

#[test]
fn a_start_screen_button_is_clickable() {
    let mut ui = Ui::mount(FakePorts::new());
    let (x, y) = ui.find("▶ Start");
    ui.click(x, y);
    assert_eq!(ui.app.screen, Screen::Foundation);
}

// --- the overview -----------------------------------------------------------

#[test]
fn an_empty_folder_is_guided_to_its_first_proposal() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());

    // First change: explained, then created from the overview.
    ui.expect("Ground rules are set. Next: your first change.");
    ui.expect("+ New change");
    ui.expect("Changes · 0");

    // What first, the name last — proposed from the description.
    ui.char('n');
    ui.expect("What do you want to change, and why?");
    ui.press(KeyCode::Enter);
    ui.expect("Describe the change first");
    ui.type_text("Let users log in with email");
    ui.press(KeyCode::Enter);
    ui.expect("A name for it — proposed from your description");
    ui.expect("› log-email▏");

    // Adjustable: clear it, try an invalid one, then a valid one.
    ui.ctrl('u');
    ui.type_text("Add Login");
    ui.press(KeyCode::Enter);
    ui.expect("lowercase words joined by dashes");
    ui.ctrl('u');
    ui.type_text("add-login");
    ui.press(KeyCode::Enter);

    assert_eq!(
        ui.ports.created(),
        [(
            "add-login".to_owned(),
            "Let users log in with email".to_owned()
        )]
    );
    ui.expect("Created add-login.");
    ui.expect("Changes · 1");
    ui.expect("▸ add-login");
    ui.expect("◉ proposal ── ○ specs ── ○ design ── ○ tasks ── ○ apply");
    ui.expect("Write the proposal");
    ui.expect("✦ Let an agent draft it  w");
    ui.expect("✎ Write it myself  e");

    // Enter presses the highlighted button: the next step.
    ui.press(KeyCode::Enter);
    assert_eq!(ui.ports.dispatched(), ["add-login/proposal"]);
    ui.expect("drafting add-login/proposal");
    // …and the agent's work shows under the change, live.
    ui.expect("Claude Code is drafting the proposal");
    ui.expect("working on proposal…");
    ui.expect("jobs: 1 running");
}

#[test]
fn a_taken_name_is_refused() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.reload();
    ui.char('n');
    ui.type_text("anything");
    ui.press(KeyCode::Enter);
    ui.ctrl('u');
    ui.type_text("add-login");
    ui.press(KeyCode::Enter);
    ui.expect("There is already a change called add-login");
}

#[test]
fn ctrl_c_cancels_the_prompt_one_level_and_never_quits() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.char('n');
    ui.type_text("half a thought");
    ui.ctrl('c');
    assert!(ui.app.prompt.is_none());
    assert!(!ui.app.quit);
    ui.expect_not("What do you want to change");

    // At the top of the overview there is nothing left to cancel: a hint.
    ui.ctrl('c');
    assert!(!ui.app.quit);
    ui.expect(QUIT_HINT);
    ui.char('q');
    assert!(ui.app.quit, "q quits from the overview, without asking");
}

#[test]
fn leaving_the_ground_rules_half_done_blocks_a_change() {
    let mut ui = Ui::mount(FakePorts::with_baseline());
    ui.press(KeyCode::Enter); // Start
    ui.ctrl('c'); // out of the ground rules, none answered
    ui.expect("Ground rules: 0 of 19 answered.");
    ui.char('n');
    ui.expect("Settle the ground rules first — f continues them");
    ui.expect("Settle the ground rules first — f.");
    ui.expect_not("+ New change");
}

#[test]
fn a_better_name_is_proposed_and_tab_cycles_the_suggestions() {
    let ports = FakePorts::with_baseline();
    *ports.names.lock().expect("names") = Names::Now(vec![
        "add-email-login".to_owned(),
        "email-sign-in".to_owned(),
    ]);
    let mut ui = Ui::ready_for_first_change(ports);
    ui.char('n');
    ui.type_text("Let users log in with email");
    ui.press(KeyCode::Enter);
    ui.expect("› add-email-login▏");
    ui.expect("suggestions: add-email-login · email-sign-in · log-email");
    ui.press(KeyCode::Tab);
    ui.expect("› email-sign-in▏");
    ui.press(KeyCode::Enter);
    assert_eq!(ui.ports.created()[0].0, "email-sign-in");
}

#[test]
fn a_name_being_adjusted_is_never_overwritten_by_a_late_proposal() {
    let ports = FakePorts::with_baseline();
    let (release, later) = tokio::sync::oneshot::channel();
    *ports.names.lock().expect("names") = Names::Later(later);
    let mut ui = Ui::ready_for_first_change(ports);
    ui.char('n');
    ui.type_text("Let users log in with email");
    ui.press(KeyCode::Enter);
    ui.expect("proposing a better name");
    ui.type_text("-v2");
    release
        .send(vec!["add-email-login".to_owned()])
        .expect("release");
    ui.settle();
    ui.expect("› log-email-v2▏");
    ui.expect("suggestions: add-email-login · log-email");
}

#[test]
fn the_model_is_asked_with_the_description_and_its_names_are_filtered() {
    let ports = FakePorts::with_baseline();
    // The model's best is not a name OpenSpec would take; its alternative is.
    *ports.names.lock().expect("names") = Names::Now(vec![
        "Add Email Login".to_owned(),
        "email-sign-in".to_owned(),
    ]);
    let mut ui = Ui::ready_for_first_change(ports);
    ui.char('n');
    ui.type_text("Let users log in with email");
    ui.press(KeyCode::Enter);
    let prompts = ui.ports.name_prompts.lock().expect("prompts").clone();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("The change: Let users log in with email"));
    ui.expect("› email-sign-in▏");
    ui.expect("suggestions: email-sign-in · log-email");
}

#[test]
fn a_proposal_for_an_earlier_description_is_dropped() {
    let ports = FakePorts::with_baseline();
    let (release, later) = tokio::sync::oneshot::channel();
    *ports.names.lock().expect("names") = Names::Later(later);
    let mut ui = Ui::ready_for_first_change(ports);
    ui.char('n');
    ui.type_text("Let users log in with email");
    ui.press(KeyCode::Enter);
    ui.expect("proposing a better name");
    ui.ctrl('c'); // cancelled while it was asked
    ui.char('n');
    ui.type_text("Export invoices as PDF");
    ui.press(KeyCode::Enter);
    release
        .send(vec!["add-email-login".to_owned()])
        .expect("release");
    ui.settle();
    ui.expect("› export-invoices-pdf▏");
    ui.expect_not("add-email-login");
}

#[test]
fn question_mark_explains_every_key_and_any_key_closes_it() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.char('?');
    ui.expect("let an agent draft the next artifact");
    ui.expect("the ground rules: stack, domain, architecture, conventions");
    ui.expect("Pipeline marks");
    ui.char('x');
    ui.expect_not("Pipeline marks");

    // ctrl+c closes it too — one level — and does not reach the quit hint.
    ui.char('?');
    ui.ctrl('c');
    ui.expect_not("Pipeline marks");
    ui.expect_not(QUIT_HINT);
    assert!(!ui.app.quit);
}

#[test]
fn the_next_step_buttons_cycle_and_enter_presses_the_focused_one() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.reload();
    ui.press(KeyCode::Right);
    assert_eq!(ui.app.focused_action(), 1);
    ui.press(KeyCode::Right);
    assert_eq!(ui.app.focused_action(), 0, "wraps");
    ui.press(KeyCode::Left);
    assert_eq!(ui.app.focused_action(), 1);
    ui.press(KeyCode::Enter); // ✎ Write it myself
    ui.expect("not in this test");
    assert!(ui.ports.dispatched().is_empty());
}

#[test]
fn changes_are_selected_with_the_keys_or_a_click_clamped_at_the_ends() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.ports
        .add_change(change_with("fix-export", &["proposal"]));
    ui.reload();
    ui.expect("Changes · 2");
    assert_eq!(ui.app.index, 0);
    ui.char('k');
    assert_eq!(ui.app.index, 0, "clamped, not wrapping");
    ui.char('j');
    ui.expect("▸ fix-export");
    ui.expect("● proposal ── ◉ specs");
    ui.press(KeyCode::Down);
    assert_eq!(ui.app.index, 1);

    let (x, y) = ui.find("add-login");
    ui.click(x, y);
    assert_eq!(ui.app.index, 0);
    ui.expect("▸ add-login");
}

#[test]
fn r_on_a_change_without_specs_says_so() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.reload();
    ui.char('r');
    ui.expect("add-login has no specs to review yet");
}

#[test]
fn h_goes_back_to_the_start_screen() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.char('h');
    assert_eq!(ui.app.screen, Screen::Home);
    ui.expect("Ground rules are set — time for your first change.");
    ui.expect("▶ Start your first change");
    ui.press(KeyCode::Enter);
    ui.expect("What do you want to change, and why?");
}

#[test]
fn a_finished_job_is_noticed_and_one_that_wrote_nothing_says_so() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.reload();
    ui.char('w');
    assert_eq!(ui.ports.dispatched(), ["add-login/proposal"]);
    ui.char('w');
    ui.expect("An agent is already working on add-login");

    // It exits 0 but the proposal is still unwritten.
    ui.ports.set_job_status("job-1", JobStatus::Succeeded);
    let effects = ui.app.on_poll(ui.ports.as_ref());
    ui.run(effects);
    ui.expect("The agent finished but did not write the proposal");
    ui.expect("jobs: 1 succeeded");
}

#[test]
fn a_failed_job_points_at_its_log() {
    let ports = FakePorts::with_baseline();
    ports.add_job(job("j1", "add-login", "specs", JobStatus::Running), &[]);
    let mut ui = Ui::ready_for_first_change(ports);
    ui.ports.set_job_status("j1", JobStatus::Failed);
    let effects = ui.app.on_poll(ui.ports.as_ref());
    ui.run(effects);
    ui.expect("add-login/specs failed — ctrl+j shows its log");
}

// --- the jobs pane ----------------------------------------------------------

fn with_jobs(jobs: &[(&str, &str, JobStatus, &[&str])]) -> Ui {
    let ports = FakePorts::with_baseline();
    for (id, change, status, tail) in jobs {
        ports.add_job(job(id, change, "design", *status), tail);
    }
    let mut ui = Ui::ready_for_first_change(ports);
    ui.ctrl('j');
    ui
}

#[test]
fn ctrl_j_toggles_the_jobs_pane_from_anywhere() {
    let mut ui = Ui::mount(FakePorts::new());
    ui.ctrl('j');
    assert!(ui.app.jobs_open, "from the start screen");
    ui.expect("Nothing has been dispatched yet");
    ui.ctrl('j');
    assert!(!ui.app.jobs_open);
    assert_eq!(ui.app.screen, Screen::Home, "back where it was");

    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.char('n');
    ui.ctrl('j');
    assert!(ui.app.jobs_open, "even mid-prompt");
    ui.ctrl('j');
    ui.expect("What do you want to change");
}

#[test]
fn the_pane_lists_jobs_and_shows_the_selected_ones_output() {
    let mut ui = with_jobs(&[
        (
            "j1",
            "add-dark-mode",
            JobStatus::Running,
            &["Writing design.md", "· Write"],
        ),
        ("j2", "other", JobStatus::Succeeded, &[]),
    ]);
    ui.expect("add-dark-mode/design");
    ui.expect("other/design");
    ui.expect("Writing design.md");
    ui.expect("1 running · 1 succeeded");
}

#[test]
fn j_and_k_move_the_selection_and_a_click_picks_a_job() {
    let mut ui = with_jobs(&[
        ("j1", "add-dark-mode", JobStatus::Running, &[]),
        ("j2", "other", JobStatus::Running, &["second job's output"]),
    ]);
    ui.char('j');
    assert_eq!(ui.app.job_index, 1);
    ui.expect("second job's output");
    ui.char('k');
    assert_eq!(ui.app.job_index, 0);
    let (x, y) = ui.find("other/design");
    ui.click(x, y);
    assert_eq!(ui.app.job_index, 1);
}

#[test]
fn cancelling_asks_first_because_it_throws_away_work_in_progress() {
    let mut ui = with_jobs(&[("j1", "add-dark-mode", JobStatus::Running, &[])]);
    ui.char('x');
    ui.expect("Its work in progress is lost");
    assert!(ui.ports.cancelled().is_empty());
    ui.char('y');
    assert_eq!(ui.ports.cancelled(), ["j1"]);
    ui.expect("1 cancelled");
}

#[test]
fn any_key_other_than_y_declines_the_cancel() {
    let mut ui = with_jobs(&[("j1", "add-dark-mode", JobStatus::Running, &[])]);
    ui.char('x');
    ui.char('n');
    assert!(ui.ports.cancelled().is_empty());
    ui.expect_not("work in progress is lost");
    // ctrl+c declines too, and leaves the pane open: one level at a time.
    ui.char('x');
    ui.ctrl('c');
    assert!(ui.ports.cancelled().is_empty());
    assert!(ui.app.jobs_open);
}

#[test]
fn a_job_that_is_not_running_cannot_be_cancelled() {
    let mut ui = with_jobs(&[("j1", "add-dark-mode", JobStatus::Succeeded, &[])]);
    ui.char('x');
    ui.expect_not("work in progress is lost");
}

#[test]
fn q_and_ctrl_c_close_the_pane_and_neither_quits() {
    let mut ui = with_jobs(&[("j1", "add-dark-mode", JobStatus::Running, &[])]);
    ui.char('q');
    assert!(!ui.app.jobs_open);
    assert!(!ui.app.quit);
    ui.ctrl('j');
    ui.ctrl('c');
    assert!(!ui.app.jobs_open);
    assert!(!ui.app.quit);
}

#[test]
fn a_job_with_no_output_yet_says_so_and_interrupted_is_not_failed() {
    let mut ui = with_jobs(&[
        ("j1", "add-dark-mode", JobStatus::Interrupted, &[]),
        ("j2", "other", JobStatus::Failed, &[]),
    ]);
    ui.expect("no output yet");
    ui.expect("interrupted");
    ui.expect("failed");
}

#[test]
fn p_clears_finished_jobs_and_keeps_running_ones() {
    let mut ui = with_jobs(&[
        ("j1", "add-dark-mode", JobStatus::Running, &[]),
        ("j2", "other", JobStatus::Failed, &[]),
    ]);
    ui.char('p');
    ui.expect_not("other/design");
    ui.expect("add-dark-mode/design");
}

#[test]
fn watch_the_full_log_opens_the_pane() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ports.add_change(change_with("add-login", &[]));
    ui.reload();
    ui.char('w');
    let (x, y) = ui.find("Watch the full log");
    ui.click(x, y);
    assert!(ui.app.jobs_open);
    ui.expect("add-login/proposal");
}

// --- matching the TypeScript's frame ----------------------------------------

/// The leading spaces of the first line containing `text`.
fn indent_of(frame: &str, text: &str) -> usize {
    let line = frame
        .lines()
        .find(|l| l.contains(text))
        .unwrap_or_else(|| panic!("{text:?} is not on screen:\n{frame}"));
    line.chars().take_while(|c| *c == ' ').count()
}

#[test]
fn the_start_screen_is_centred_as_the_typescript_centred_it() {
    // Measured from the TypeScript HomeScreen under opentui's testRender:
    // at 120×36 the logo starts at column 7 on row 9 and the tagline at
    // column 24; at 121×37, row 10 and column 25.
    let ports = FakePorts::with_baseline();
    let mut ui = Ui::mount_sized(ports, 120, 36);
    ui.app.tick = 100;
    let frame = ui.frame();
    assert_eq!(indent_of(&frame, "███████╗ ██████╗"), 7, "{frame}");
    assert_eq!(indent_of(&frame, "spec-driven development"), 24, "{frame}");
    let row = frame.lines().position(|l| l.contains("███████╗ ██████╗"));
    assert_eq!(row, Some(9));

    let mut ui = Ui::mount_sized(FakePorts::with_baseline(), 121, 37);
    ui.app.tick = 100;
    let frame = ui.frame();
    assert_eq!(indent_of(&frame, "███████╗ ██████╗"), 7, "{frame}");
    assert_eq!(indent_of(&frame, "spec-driven development"), 25, "{frame}");
    let row = frame.lines().position(|l| l.contains("███████╗ ██████╗"));
    assert_eq!(row, Some(10));
}

#[test]
fn panel_titles_sit_one_dash_in_from_the_corner() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.expect("╭─ Changes · 0 ─");
    ui.expect("╭─ Getting started ─");
    ui.ctrl('j');
    ui.expect("╭─ Jobs ─");
}

#[test]
fn the_job_pane_header_is_two_lines_as_in_the_typescript() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    ui.ctrl('j');
    let frame = ui.frame();
    let lines: Vec<&str> = frame.lines().collect();
    let at = lines
        .iter()
        .position(|l| l.trim_matches(|c| c == '│' || c == ' ') == "jobs")
        .unwrap_or_else(|| panic!("no header line:\n{frame}"));
    assert!(lines[at + 1].contains("  none yet"), "{frame}");
}

// --- the job poll -------------------------------------------------------------

#[test]
fn the_poll_reads_jobs_as_spawned_work_not_on_the_loop() {
    let ports = FakePorts::with_baseline();
    ports.add_job(job("j1", "add-login", "specs", JobStatus::Running), &[]);
    let mut ui = Ui::ready_for_first_change(ports);
    ui.ports.set_job_status("j1", JobStatus::Failed);

    let effects = ui.app.on_poll(ui.ports.as_ref());
    assert_eq!(effects.len(), 1);
    assert!(matches!(effects[0], Effect::Spawn(_)));
    // Nothing read yet: the app still believes what it last heard.
    assert_eq!(ui.app.jobs[0].status, JobStatus::Running);

    ui.run(effects);
    assert_eq!(ui.app.jobs[0].status, JobStatus::Failed);
    ui.expect("add-login/specs failed — ctrl+j shows its log");
}

#[test]
fn a_read_that_arrives_after_the_selection_moved_keeps_its_list_not_its_lines() {
    let mut ui = with_jobs(&[
        (
            "j1",
            "add-dark-mode",
            JobStatus::Running,
            &["first job's output"],
        ),
        ("j2", "other", JobStatus::Running, &["second job's output"]),
    ]);
    ui.char('j');
    ui.expect("second job's output");
    // A read requested for job 0 lands late, after the move to job 1.
    let late = ui.runtime.block_on(ui.ports.read_jobs(0, None));
    let effects = ui.app.on_msg(
        ui.ports.as_ref(),
        Msg::JobsRead {
            view: late,
            job_index: 0,
            change: None,
            poll: false,
        },
    );
    ui.run(effects);
    ui.expect("second job's output");
    ui.expect_not("first job's output");
}
