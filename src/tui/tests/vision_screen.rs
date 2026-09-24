//! The vision screen, drawn: each state it can be in, as a frame.
//!
//! The session is set directly on the app here — the question on screen, the
//! slices proposed, what the model is doing — so each state is drawn exactly,
//! without scripting a model to reach it. `vision_e2e` drives the same states
//! by keystroke.

use crossterm::event::KeyCode;

use super::vision_e2e::at_vision;
use super::Ui;
use crate::core::advisor::AdviceOption;
use crate::core::vision::{InterviewQuestion, ProposedSlice, VisionSession, VisionTurn};
use crate::tui::fake::FakePorts;

/// On the vision screen with `session` as the saved interview.
fn showing(session: VisionSession) -> Ui {
    let mut ui = at_vision(FakePorts::new().with_vision(std::sync::Arc::new(|_, _| {
        Box::pin(async { Err("not in this test".to_owned()) })
    })));
    ui.app.vision.session = Some(session);
    // A key that does nothing, so the selection is chosen for the question
    // as it is after any answer lands.
    ui.press(KeyCode::F(5));
    ui
}

fn question() -> VisionSession {
    VisionSession {
        vision: "A booking tool for clinics.".to_owned(),
        understood: "Receptionists book rooms for patients.".to_owned(),
        turns: vec![VisionTurn {
            ask: "Who uses it?".to_owned(),
            answer: Some("Staff".to_owned()),
        }],
        pending: Some(InterviewQuestion {
            ask: "What must the first version do?".to_owned(),
            why: "Decides the first slice.".to_owned(),
            options: vec![
                AdviceOption {
                    label: "Book a room".to_owned(),
                    detail: "the core of it".to_owned(),
                    recommended: true,
                },
                AdviceOption {
                    label: "See the week".to_owned(),
                    detail: "a read-only calendar".to_owned(),
                    recommended: false,
                },
            ],
        }),
        ..VisionSession::default()
    }
}

fn sliced() -> VisionSession {
    let slice = |id: &str, title: &str, why: &str| ProposedSlice {
        id: id.to_owned(),
        title: title.to_owned(),
        summary: format!("{title}, end to end."),
        why: why.to_owned(),
        depends_on: Vec::new(),
    };
    VisionSession {
        vision: "A booking tool for clinics.".to_owned(),
        finished: true,
        refined: Some("A booking tool for small clinics, used by receptionists.".to_owned()),
        slices: vec![
            slice("book-a-room", "Book a room", "The core of it"),
            slice("see-the-week", "See the week", ""),
        ],
        ..VisionSession::default()
    }
}

#[test]
fn describing_offers_the_input_the_way_out_and_its_keys() {
    let mut ui = at_vision(FakePorts::new().with_vision(std::sync::Arc::new(|_, _| {
        Box::pin(async { Err("x".to_owned()) })
    })));
    ui.expect("╭─ Your vision ─");
    ui.expect("spec-tacular");
    ui.expect(" › vision");
    ui.expect("What are you building?");
    ui.expect("› ▏e.g. A booking tool for small clinics");
    ui.expect("✦ Then an AI asks a few questions to sharpen it");
    ui.expect("▶ Continue");
    ui.expect("Not a new project — just start a change");
    ui.expect(" enter  continue");
    ui.expect(" ctrl+n  not a new project");
    ui.type_text("Clinics");
    ui.expect("› Clinics▏");
}

#[test]
fn a_question_shows_what_was_understood_its_options_and_the_way_to_stop() {
    let mut ui = showing(question());
    ui.expect("╭─ What I understood so far ─");
    ui.expect("Receptionists book rooms for patients.");
    ui.expect("╭─ Question 2 ─");
    ui.expect("What must the first version do?");
    ui.expect("Decides the first slice.");
    // The recommendation is selected, and marked.
    ui.expect(" ▸ Book a room");
    ui.expect("★  the core of it");
    ui.expect("✎ Write my own answer");
    ui.expect("type your answer — \"skip\" if you do not know, \"done\" when that is enough");
    ui.expect("That's enough — make the slices");
    ui.expect(" tab  skip question");
    ui.expect(" ctrl+d  that's enough — make slices");

    // Typing is choosing to write your own.
    ui.type_text("Both");
    ui.expect("› Both▏");
    ui.expect("   Book a room");
}

#[test]
fn a_question_with_no_options_offers_only_your_own_answer() {
    let mut session = question();
    if let Some(q) = session.pending.as_mut() {
        q.options.clear();
    }
    let mut ui = showing(session);
    ui.expect(" ▸ ✎ Write my answer");
    ui.press(KeyCode::Enter);
    ui.expect("Pick an option or type an answer — tab skips it, \"done\" ends the questions");
}

#[test]
fn while_the_model_thinks_there_is_a_spinner_and_only_ctrl_c() {
    let mut ui = showing(question());
    ui.app.vision.busy = Some("Thinking about your answer…".to_owned());
    ui.expect("Thinking about your answer…");
    ui.expect("What I understood so far");
    ui.expect_not("Question 2");
    ui.expect(" ctrl+c  back");
    ui.expect_not(" enter ");
    // Keys do nothing, except going back.
    ui.char('x');
    assert_eq!(ui.app.vision_screen.as_ref().expect("screen").draft, "");
}

#[test]
fn a_failure_says_so_and_offers_to_ask_again() {
    let mut ui = showing(VisionSession {
        vision: "A booking tool for clinics.".to_owned(),
        ..VisionSession::default()
    });
    ui.app.vision.error = Some("The AI could not continue: offline".to_owned());
    ui.expect("The AI could not continue: offline");
    ui.expect("Press enter to ask again.");
    ui.expect(" enter  ask again");
}

#[test]
fn the_slices_are_numbered_checked_and_toggled_with_space() {
    let mut ui = showing(sliced());
    ui.expect("╭─ Your roadmap — review the slices ─");
    ui.expect("A booking tool for small clinics, used by receptionists.");
    ui.expect("Built in this order, one at a time");
    ui.expect(" ▸ [✓] 1. Book a room   book-a-room");
    ui.expect("       Book a room, end to end.");
    ui.expect("       The core of it");
    ui.expect("   [✓] 2. See the week   see-the-week");
    ui.expect("▶ Create the roadmap — start with “Book a room”");
    ui.expect(" space  keep / drop");

    ui.char(' ');
    ui.expect(" ▸ [ ] 1. Book a room");
    // The first kept slice is what the roadmap starts with.
    ui.expect("▶ Create the roadmap — start with “See the week”");
    ui.char(' ');
    ui.expect(" ▸ [✓] 1. Book a room");

    // j/k and the arrows move; a click selects.
    ui.char('j');
    ui.expect(" ▸ [✓] 2. See the week");
    let (column, row) = ui.find("1. Book a room");
    ui.click(column, row);
    ui.expect(" ▸ [✓] 1. Book a room");
}

#[test]
fn clicking_an_option_answers_with_it() {
    let (ask, prompts) = {
        let prompts = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = std::sync::Arc::clone(&prompts);
        let ask: crate::core::advisor::Ask = std::sync::Arc::new(move |prompt: String, _| {
            seen.lock().expect("prompts").push(prompt);
            Box::pin(async {
                Ok(serde_json::json!({
                    "understood": "u", "enough": false,
                    "question": { "ask": "Next?", "why": "", "options": [] },
                }))
            })
        });
        (ask, prompts)
    };
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.app.vision.session = Some(question());
    // The saved session is what the interviewer answers against.
    std::fs::create_dir_all(ui.ports.path().join(".spec-tacular")).expect("dir");
    std::fs::write(
        crate::core::vision::session_path(ui.ports.path()),
        serde_json::to_string(&question()).expect("json"),
    )
    .expect("write");
    ui.press(KeyCode::F(5));
    let (column, row) = ui.find("See the week");
    ui.click(column, row);
    ui.expect("Next?");
    assert!(prompts.lock().expect("prompts")[0]
        .contains("Q: What must the first version do?\nA: See the week"));
}

#[test]
fn a_narrow_terminal_still_fits_the_describe_panel_and_its_buttons() {
    let (ask, _) = (
        std::sync::Arc::new(
            |_: String, _: serde_json::Value| -> crate::core::advisor::AskFuture {
                Box::pin(async { Err("x".to_owned()) })
            },
        ) as crate::core::advisor::Ask,
        (),
    );
    let mut ui = Ui::mount_sized(FakePorts::new().with_vision(ask), 80, 40);
    ui.press(KeyCode::Enter);
    ui.ports.settle_ground_rules();
    ui.ctrl('c');
    ui.expect("What are you building?");
    ui.expect("▶ Continue");
    ui.expect("Not a new project");
}
