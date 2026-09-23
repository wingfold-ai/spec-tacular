//! The TUI end to end, by keystroke, asserted on the rendered frame.
//!
//! Ported from the TypeScript `onboarding-e2e` (its start-screen and overview
//! parts), `jobs-pane` and `concurrency-e2e` suites. The app runs against
//! [`FakePorts`] and draws into Ratatui's `TestBackend`; spawned work runs on
//! a real (current-thread) tokio runtime and its results are fed back exactly
//! as the event loop feeds them, so what is tested is the app, not a model of
//! it.

use std::path::PathBuf;
use std::sync::Arc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use super::app::{App, Effect, Msg, Screen, QUIT_HINT};
use super::fake::{change_with, job, FakePorts, Names};
use super::view;
use crate::core::jobs::JobStatus;

struct Ui {
    app: App,
    ports: Arc<FakePorts>,
    runtime: tokio::runtime::Runtime,
    tx: mpsc::UnboundedSender<Msg>,
    rx: mpsc::UnboundedReceiver<Msg>,
    /// Every file the editor was asked to open, and at which line.
    editors: Vec<(PathBuf, usize)>,
    width: u16,
    height: u16,
}

impl Ui {
    fn mount(ports: FakePorts) -> Self {
        Self::mount_sized(ports, 120, 40)
    }

    fn mount_sized(ports: FakePorts, width: u16, height: u16) -> Self {
        let ports = Arc::new(ports);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (tx, rx) = mpsc::unbounded_channel();
        let (app, effects) = App::new(ports.as_ref());
        let mut ui = Self {
            app,
            ports,
            runtime,
            tx,
            rx,
            editors: Vec::new(),
            width,
            height,
        };
        ui.run(effects);
        ui.frame();
        ui
    }

    /// Does what the event loop does with effects, then waits for the
    /// spawned work to come back.
    fn run(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Spawn(work) => {
                    let tx = self.tx.clone();
                    self.runtime.spawn(async move {
                        let _ = tx.send(work.await);
                    });
                }
                Effect::Editor { file, line, select } => {
                    self.editors.push((file, line));
                    let more = self.app.on_msg(
                        self.ports.as_ref(),
                        Msg::EditorClosed {
                            result: Ok(()),
                            select,
                        },
                    );
                    self.run(more);
                }
            }
        }
        self.settle();
    }

    fn settle(&mut self) {
        loop {
            self.runtime.block_on(async {
                for _ in 0..8 {
                    tokio::task::yield_now().await;
                }
            });
            let mut any = false;
            while let Ok(msg) = self.rx.try_recv() {
                any = true;
                let more = self.app.on_msg(self.ports.as_ref(), msg);
                self.run(more);
            }
            if !any {
                return;
            }
        }
    }

    fn key(&mut self, key: KeyEvent) {
        let effects = self.app.on_key(self.ports.as_ref(), &key);
        self.run(effects);
        self.frame();
    }

    fn press(&mut self, code: KeyCode) {
        self.key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    fn char(&mut self, c: char) {
        self.press(KeyCode::Char(c));
    }

    fn ctrl(&mut self, c: char) {
        self.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL));
    }

    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            self.char(c);
        }
    }

    fn click(&mut self, column: u16, row: u16) {
        let mouse = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        };
        let effects = self.app.on_mouse(self.ports.as_ref(), &mouse);
        self.run(effects);
        self.frame();
    }

    /// Where `text` is on screen, as (column, row).
    fn find(&mut self, text: &str) -> (u16, u16) {
        let frame = self.frame();
        for (row, line) in frame.lines().enumerate() {
            if let Some(byte) = line.find(text) {
                let column = line[..byte].chars().count();
                return (
                    u16::try_from(column).expect("column"),
                    u16::try_from(row).expect("row"),
                );
            }
        }
        panic!("{text:?} is not on screen:\n{frame}");
    }

    /// Renders, and records where the clickable things landed — as a real
    /// frame does.
    fn frame(&mut self) -> String {
        let mut terminal =
            Terminal::new(TestBackend::new(self.width, self.height)).expect("terminal");
        let mut hits = Vec::new();
        terminal
            .draw(|frame| hits = view::render(&self.app, frame))
            .expect("draw");
        self.app.hits = hits;
        let buffer = terminal.backend().buffer();
        let mut out = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[track_caller]
    fn expect(&mut self, text: &str) {
        let frame = self.frame();
        assert!(frame.contains(text), "{text:?} is not on screen:\n{frame}");
    }

    #[track_caller]
    fn expect_not(&mut self, text: &str) {
        let frame = self.frame();
        assert!(
            !frame.contains(text),
            "{text:?} should not be on screen:\n{frame}"
        );
    }

    /// Setup done, every ground rule answered, and back from the editor —
    /// a project ready for its first change.
    fn ready_for_first_change(ports: FakePorts) -> Self {
        let mut ui = Self::mount(ports);
        ui.press(KeyCode::Enter); // Start
        ui.ports.settle_ground_rules();
        ui.char('f'); // the editor opens, and closes again
        ui
    }
}

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
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("✓ Set up");
    ui.expect("2. Ground rules");
    ui.expect("Ground rules: 0 of 19 answered.");
    ui.expect("f opens the first question in your editor");
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
    let mut ui = Ui::mount(FakePorts::with_baseline());
    ui.press(KeyCode::Enter); // Start
    ui.ports.settle_ground_rules();
    ui.ports.add_change(change_with("add-login", &[]));
    ui.char('h'); // back to the start screen
    ui.settle();
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
    assert_eq!(ui.app.screen, Screen::Overview);
}

// --- the overview -----------------------------------------------------------

#[test]
fn an_empty_folder_is_guided_to_its_first_proposal() {
    let mut ui = Ui::ready_for_first_change(FakePorts::with_baseline());
    assert_eq!(
        ui.editors.len(),
        1,
        "f opened the ground rules in the editor"
    );

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
    ui.char('f');
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
    ui.expect("Ground rules: 0 of 19 answered.");
    ui.char('n');
    ui.expect("Settle the ground rules first — f continues them");
    ui.expect("Settle the ground rules first — f.");
    ui.expect_not("+ New change");
}

#[test]
fn f_opens_the_next_open_question_in_the_editor() {
    let mut ui = Ui::mount(FakePorts::with_baseline());
    ui.press(KeyCode::Enter);
    let questions = crate::core::foundation::guided_questions(ui.ports.path());
    crate::core::foundation::answer_foundation(&questions[0].item, "Go 1.23").expect("answer");
    ui.char('f');
    let (file, line) = ui.editors.last().cloned().expect("an editor");
    assert_eq!(file, PathBuf::from(&questions[1].item.file));
    assert_eq!(line, questions[1].item.line);
    ui.expect("Ground rules: 1 of 19 answered.");
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
    ui.char('f');
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
    ui.char('f');
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
    ui.char('f');
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
    ui.char('f');
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
    ui.char('f');
    ui.char('w');
    let (x, y) = ui.find("Watch the full log");
    ui.click(x, y);
    assert!(ui.app.jobs_open);
    ui.expect("add-login/proposal");
}
