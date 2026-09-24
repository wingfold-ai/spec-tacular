//! The TUI end to end, by keystroke, asserted on the rendered frame.
//!
//! The app runs against [`FakePorts`] and draws into Ratatui's
//! `TestBackend`; spawned work runs on a real (current-thread) tokio runtime
//! and its results are fed back exactly as the event loop feeds them, so what
//! is tested is the app, not a model of it. [`Ui`] is the harness; each
//! submodule ports one TypeScript suite:
//!
//! - [`shell`] — `onboarding-e2e` (its start-screen and overview parts),
//!   `jobs-pane` and the shell half of `concurrency-e2e`;
//! - [`review_screen`], [`review_e2e`], [`review_lint`], [`promote_e2e`] —
//!   the suites of the same names;
//! - [`concurrency_e2e`] — its review half: a job keeps running while
//!   decisions are made;
//! - [`draft`] — `vision-e2e`'s "an agent's draft";
//! - [`ground_rules`] — `onboarding-e2e`'s "the ground rules", with the
//!   advisor's model scripted, and [`ground_rules_screen`] — each of its
//!   states, drawn;
//! - [`vision_e2e`] — `vision-e2e`'s "a new project starts from its vision",
//!   with the interviewer's model scripted, and [`vision_screen`] — each of
//!   its states, drawn. `onboarding-e2e`'s "a new change" (the model's name
//!   proposals) is in [`shell`].

mod concurrency_e2e;
mod draft;
mod ground_rules;
mod ground_rules_screen;
mod promote_e2e;
mod review_e2e;
mod review_lint;
mod review_screen;
mod shell;
mod vision_e2e;
mod vision_screen;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use super::app::{App, Effect, Msg};
use super::fake::FakePorts;
use super::view;

/// What the pretend editor does to the file it is given.
type EditorAction = Box<dyn FnMut(&Path)>;

pub(super) struct Ui {
    pub(super) app: App,
    pub(super) ports: Arc<FakePorts>,
    pub(super) runtime: tokio::runtime::Runtime,
    tx: mpsc::UnboundedSender<Msg>,
    rx: mpsc::UnboundedReceiver<Msg>,
    /// Every file the editor was asked to open, and at which line.
    pub(super) editors: Vec<(PathBuf, usize)>,
    /// What the editor does to the file before it "closes".
    pub(super) on_edit: Option<EditorAction>,
    width: u16,
    height: u16,
}

impl Ui {
    pub(super) fn mount(ports: FakePorts) -> Self {
        Self::mount_sized(ports, 120, 40)
    }

    pub(super) fn mount_sized(ports: FakePorts, width: u16, height: u16) -> Self {
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
            on_edit: None,
            width,
            height,
        };
        ui.run(effects);
        ui.frame();
        ui
    }

    /// Does what the event loop does with effects, then waits for the
    /// spawned work to come back.
    pub(super) fn run(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Spawn(work) => {
                    let tx = self.tx.clone();
                    self.runtime.spawn(async move {
                        let _ = tx.send(work.await);
                    });
                }
                Effect::Editor { file, line, then } => {
                    if let Some(edit) = self.on_edit.as_mut() {
                        edit(&file);
                    }
                    self.editors.push((file, line));
                    let more = self.app.on_msg(
                        self.ports.as_ref(),
                        Msg::EditorClosed {
                            result: Ok(()),
                            then,
                        },
                    );
                    self.run(more);
                }
            }
        }
        self.settle();
    }

    pub(super) fn settle(&mut self) {
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

    /// Re-reads the project, as returning from the editor or the job pane
    /// does — how a test makes a change it just added appear.
    pub(super) fn reload(&mut self) {
        let effect = self.app.reload(self.ports.as_ref(), None, None, None);
        self.run(vec![effect]);
        self.frame();
    }

    /// One tick of the two-second job poll.
    pub(super) fn poll(&mut self) {
        let effects = self.app.on_poll(self.ports.as_ref());
        self.run(effects);
        self.frame();
    }

    pub(super) fn wheel(&mut self, down: bool) {
        let mouse = MouseEvent {
            kind: if down {
                MouseEventKind::ScrollDown
            } else {
                MouseEventKind::ScrollUp
            },
            column: 10,
            row: 10,
            modifiers: KeyModifiers::NONE,
        };
        let effects = self.app.on_mouse(self.ports.as_ref(), &mouse);
        self.run(effects);
        self.frame();
    }

    pub(super) fn key(&mut self, key: KeyEvent) {
        let effects = self.app.on_key(self.ports.as_ref(), &key);
        self.run(effects);
        self.frame();
    }

    pub(super) fn press(&mut self, code: KeyCode) {
        self.key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    pub(super) fn char(&mut self, c: char) {
        self.press(KeyCode::Char(c));
    }

    pub(super) fn ctrl(&mut self, c: char) {
        self.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL));
    }

    pub(super) fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            self.char(c);
        }
    }

    pub(super) fn click(&mut self, column: u16, row: u16) {
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
    pub(super) fn find(&mut self, text: &str) -> (u16, u16) {
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
    pub(super) fn frame(&mut self) -> String {
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
    pub(super) fn expect(&mut self, text: &str) {
        let frame = self.frame();
        assert!(frame.contains(text), "{text:?} is not on screen:\n{frame}");
    }

    #[track_caller]
    pub(super) fn expect_not(&mut self, text: &str) {
        let frame = self.frame();
        assert!(
            !frame.contains(text),
            "{text:?} should not be on screen:\n{frame}"
        );
    }

    /// Setup done, every ground rule answered, and back on the overview —
    /// a project ready for its first change.
    pub(super) fn ready_for_first_change(ports: FakePorts) -> Self {
        let mut ui = Self::mount(ports);
        ui.press(KeyCode::Enter); // Start: on to the ground rules
        ui.ports.settle_ground_rules();
        ui.ctrl('c'); // leave them, answered behind the screen's back
        ui
    }

    /// A project with one change, `name`, whose specs (and design) are real
    /// files — on the overview, that change selected.
    pub(super) fn with_spec_change(
        name: &str,
        specs: &[(&str, &str)],
        design: Option<&str>,
    ) -> Self {
        let mut ui = Self::ready_for_first_change(FakePorts::with_baseline());
        ui.ports.add_spec_change(name, specs, design);
        ui.reload();
        ui
    }

    /// The same, with its review open.
    pub(super) fn reviewing(name: &str, specs: &[(&str, &str)], design: Option<&str>) -> Self {
        let mut ui = Self::with_spec_change(name, specs, design);
        ui.char('r');
        let frame = ui.frame();
        assert_eq!(ui.app.screen, super::app::Screen::Review, "{frame}");
        ui
    }

    /// The open review's session.
    #[track_caller]
    pub(super) fn session(&self) -> &crate::core::session::ReviewSession {
        &self.app.review.as_ref().expect("a review is open").session
    }
}
