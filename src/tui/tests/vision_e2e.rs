//! A new project, by keystroke: `vision-e2e`'s "a new project starts from its
//! vision" — describe the vision, be interviewed, review the slices, and land
//! on the first slice's change — plus the ways out of it: not a new project,
//! no model at all, a model that fails.
//!
//! The interviewer is the real `core::vision` writing real files; only the
//! model behind it is scripted, answering by what the prompt contains — the
//! TypeScript suite's fake `Ask`, at the same boundary.

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crossterm::event::{Event, KeyCode};
use serde_json::{json, Value};

use super::Ui;
use crate::core::advisor::Ask;
use crate::core::guide::ProjectStage;
use crate::core::roadmap::{load_roadmap, SliceStatus};
use crate::core::vision::{session_path, vision_path, VisionSession};
use crate::tui::app::{Msg, Screen};
use crate::tui::fake::FakePorts;
use crate::tui::ports::VisionAnswer;
use crate::tui::vision::StepKind;

fn slices() -> Value {
    json!({
        "vision": "A booking tool for small clinics, used by receptionists.",
        "slices": [
            { "id": "book-a-room", "title": "Book a room", "summary": "A receptionist books a free room.", "why": "The core of it", "dependsOn": [] },
            { "id": "see-the-week", "title": "See the week", "summary": "See every booking for the week.", "why": "Needs bookings", "dependsOn": ["book-a-room"] },
            { "id": "cancel-bookings", "title": "Cancel bookings", "summary": "Cancel and free the room.", "why": "Needs bookings", "dependsOn": ["book-a-room"] },
        ],
    })
}

/// A model that answers every prompt with `answer(prompt)`, recording them.
fn model(
    answer: impl Fn(&str) -> Result<Value, String> + Send + Sync + 'static,
) -> (Ask, Arc<Mutex<Vec<String>>>) {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&prompts);
    let ask: Ask = Arc::new(move |prompt: String, _schema| {
        let result = answer(&prompt);
        seen.lock().expect("prompts").push(prompt);
        Box::pin(async move { result })
    });
    (ask, prompts)
}

/// Asks one question, then has enough, then slices.
fn interviewer() -> (Ask, Arc<Mutex<Vec<String>>>) {
    model(|prompt| {
        if prompt.starts_with("Split a new project into slices") {
            return Ok(slices());
        }
        let answered = prompt.contains("A: ");
        Ok(json!({
            "understood": if answered {
                "Receptionists book rooms; patients never touch it."
            } else {
                "A clinic booking tool."
            },
            "enough": answered,
            "question": if answered {
                json!({ "ask": "", "why": "", "options": [] })
            } else {
                json!({
                    "ask": "Who books the rooms?",
                    "why": "Decides whose screens the first slice needs.",
                    "options": [
                        { "label": "Receptionists", "detail": "staff on the front desk", "recommended": true },
                        { "label": "Patients", "detail": "self-service", "recommended": false },
                    ],
                })
            },
        }))
    })
}

/// A new project with every ground rule answered, on the vision screen —
/// reached the way the developer reaches it: Start, the ground rules, and
/// leaving them once they are all answered.
pub(super) fn at_vision(ports: FakePorts) -> Ui {
    let mut ui = Ui::mount(ports);
    ui.press(KeyCode::Enter); // Start: sets the folder up
    ui.ports.settle_ground_rules();
    ui.ctrl('c'); // leave the ground rules: all answered
    let frame = ui.frame();
    assert_eq!(ui.app.screen, Screen::Vision, "{frame}");
    ui
}

const DESCRIPTION: &str = "A booking tool for clinics so rooms are never double-booked";

#[test]
fn describe_then_interview_then_slices_and_the_first_slice_is_the_first_change() {
    let (ask, prompts) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));

    ui.expect("What are you building?");
    ui.expect("3. Vision");
    ui.expect("Not a new project");

    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);

    // The interview: what it understood, and one question with options.
    {
        let prompts = prompts.lock().expect("prompts");
        assert!(prompts[0].contains(DESCRIPTION));
        assert!(prompts[0].contains("Ground rules already settled (never ask about these)"));
    }
    ui.expect("What I understood so far");
    ui.expect("A clinic booking tool.");
    ui.expect("Who books the rooms?");
    ui.expect("▸ Receptionists");

    // Answering — and the model has enough, so it slices straight away.
    ui.press(KeyCode::Enter);
    assert!(prompts
        .lock()
        .expect("prompts")
        .iter()
        .any(|p| p.contains("Q: Who books the rooms?\nA: Receptionists")));
    ui.expect("Your roadmap — review the slices");
    ui.expect("1. Book a room");
    ui.expect("3. Cancel bookings");

    // Drop one, then create the roadmap.
    ui.press(KeyCode::Down);
    ui.press(KeyCode::Down);
    ui.char(' ');
    ui.expect("[ ]");
    ui.press(KeyCode::Enter);

    assert_eq!(
        ui.ports.created(),
        vec![(
            "book-a-room".to_owned(),
            "Book a room: A receptionist books a free room.\n\nWhy now: The core of it".to_owned()
        )]
    );
    let roadmap = load_roadmap(ui.ports.path()).expect("roadmap");
    let shape: Vec<(&str, SliceStatus)> = roadmap
        .slices
        .iter()
        .map(|s| (s.id.as_str(), s.status))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("book-a-room", SliceStatus::Active),
            ("see-the-week", SliceStatus::Planned),
        ]
    );
    let vision = fs::read_to_string(vision_path(ui.ports.path())).expect("vision.md");
    assert!(vision.contains("A booking tool for small clinics, used by receptionists."));
    assert!(vision.contains("**Who books the rooms?**\n\nReceptionists"));

    // On the overview: the change, its next step, and the roadmap.
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("Roadmap saved: 2 slices. First up: Book a room.");
    ui.expect("◉ book-a-room");
    ui.expect("○ see-the-week");
    ui.expect("Write the proposal");
}

#[test]
fn questions_can_be_skipped_and_done_ends_the_interview() {
    let asked = Arc::new(Mutex::new(0));
    let count = Arc::clone(&asked);
    let (ask, _) = model(move |prompt| {
        if prompt.starts_with("Split a new project") {
            return Ok(slices());
        }
        let mut n = count.lock().expect("count");
        *n += 1;
        Ok(json!({
            "understood": "x", "enough": false,
            "question": { "ask": format!("Question {n}?"), "why": "", "options": [] },
        }))
    });
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);
    ui.expect("Question 1?");
    ui.press(KeyCode::Tab);
    ui.expect("Question 2?");
    ui.type_text("done");
    ui.press(KeyCode::Enter);
    ui.expect("Your roadmap — review the slices");
    assert_eq!(*asked.lock().expect("count"), 2);

    // The skip is in the transcript as one.
    let session: VisionSession =
        serde_json::from_str(&fs::read_to_string(session_path(ui.ports.path())).expect("session"))
            .expect("json");
    assert_eq!(session.turns[0].answer, None);
}

#[test]
fn typed_skip_words_skip_and_ctrl_d_ends_it_too() {
    let (ask, prompts) = model(|prompt| {
        if prompt.starts_with("Split a new project") {
            return Ok(slices());
        }
        Ok(json!({
            "understood": "x", "enough": false,
            "question": { "ask": "Anything else?", "why": "", "options": [] },
        }))
    });
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);
    ui.type_text("Not sure.");
    ui.press(KeyCode::Enter);
    assert!(prompts
        .lock()
        .expect("prompts")
        .iter()
        .any(|p| p.contains("A: (skipped")));
    ui.ctrl('d');
    ui.expect("Your roadmap — review the slices");
}

#[test]
fn not_a_new_project_goes_straight_to_describing_a_single_change() {
    let (ask, prompts) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.ctrl('n');
    ui.expect("What do you want to change, and why?");
    // And it is not offered again.
    assert!(session_path(ui.ports.path()).exists());
    assert_eq!(ui.app.stage, ProjectStage::NoChanges);
    assert!(prompts.lock().expect("prompts").is_empty());

    // The single change goes on as any other does.
    ui.type_text("Let users book rooms");
    ui.press(KeyCode::Enter);
    ui.press(KeyCode::Enter);
    assert_eq!(ui.ports.created()[0].0, "book-rooms");
}

#[test]
fn the_not_a_new_project_button_is_clickable() {
    let (ask, _) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    let (column, row) = ui.find("Not a new project — just start a change");
    ui.click(column, row);
    ui.expect("What do you want to change, and why?");
}

#[test]
fn without_a_model_the_vision_is_kept_and_a_change_is_described_next() {
    let mut ui = at_vision(FakePorts::new());
    ui.expect("(AI is off: none in this test — your description is saved as the vision.)");
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);

    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("What do you want to change, and why?");
    ui.expect("Your vision is saved to spec-tacular/vision.md");
    let vision = fs::read_to_string(vision_path(ui.ports.path())).expect("vision.md");
    assert!(vision.contains(DESCRIPTION));
    // Never offered again: this project goes on change by change.
    assert_eq!(ui.app.stage, ProjectStage::NoChanges);
}

#[test]
fn a_description_too_short_to_interview_about_asks_for_more() {
    let (ask, prompts) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text("A tool");
    ui.press(KeyCode::Enter);
    ui.expect("Say a little more — a few sentences about what you want to build");
    assert!(prompts.lock().expect("prompts").is_empty());
}

#[test]
fn a_paste_is_appended_to_the_description_with_its_line_breaks() {
    let (ask, prompts) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text("Clinics: ");
    let effects = ui.app.on_event(
        ui.ports.as_ref(),
        &Event::Paste("rooms are double-booked.\r\nReceptionists need a week view.".to_owned()),
    );
    ui.run(effects);
    assert_eq!(
        ui.app.vision_screen.as_ref().expect("screen").draft,
        "Clinics: rooms are double-booked.\nReceptionists need a week view."
    );
    ui.expect("› Clinics: rooms are double-booked.");
    ui.press(KeyCode::Enter);
    assert!(prompts.lock().expect("prompts")[0]
        .contains("Clinics: rooms are double-booked.\nReceptionists need a week view."));
}

#[test]
fn a_failing_model_is_a_line_on_screen_and_enter_asks_again() {
    let offline = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&offline);
    let (ask, _) = model(move |_| {
        if flag.load(Ordering::SeqCst) {
            return Err("out of credit".to_owned());
        }
        Ok(json!({
            "understood": "A clinic booking tool.", "enough": false,
            "question": { "ask": "Who books the rooms?", "why": "", "options": [] },
        }))
    });
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);
    ui.expect("The AI could not continue: out of credit");
    ui.expect("Press enter to ask again.");

    offline.store(false, Ordering::SeqCst);
    ui.press(KeyCode::Enter);
    ui.expect("Who books the rooms?");
    ui.expect_not("could not continue");
}

#[test]
fn leaving_mid_interview_resumes_where_it_was_from_the_start_screen() {
    let (ask, _) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);
    ui.expect("Who books the rooms?");
    ui.ctrl('c');
    assert_eq!(ui.app.screen, Screen::Home);
    ui.expect("▶ Continue your vision");
    ui.press(KeyCode::Enter);
    ui.expect("Question 1");
    ui.expect("Who books the rooms?");
}

#[test]
fn a_new_project_is_offered_its_vision_from_the_start_screen() {
    let (ask, _) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.ctrl('c');
    ui.expect("Ground rules are set. Now: what are you building?");
    ui.expect("▶ Describe your vision");
    ui.press(KeyCode::Enter);
    ui.expect("What are you building?");
}

#[test]
fn a_stale_answer_never_replaces_a_fresher_one() {
    let (ask, _) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);
    ui.expect("Who books the rooms?");
    let older = ui.app.latest.vision - 1;
    let effects = ui.app.on_msg(
        ui.ports.as_ref(),
        Msg::Vision {
            generation: older,
            kind: StepKind::Interview,
            answer: VisionAnswer {
                session: None,
                error: Some("an old failure".to_owned()),
            },
        },
    );
    ui.run(effects);
    ui.expect("Who books the rooms?");
    ui.expect_not("an old failure");
}

#[test]
fn every_slice_dropped_is_refused_rather_than_an_empty_roadmap() {
    let (ask, _) = interviewer();
    let mut ui = at_vision(FakePorts::new().with_vision(ask));
    ui.type_text(DESCRIPTION);
    ui.press(KeyCode::Enter);
    ui.press(KeyCode::Enter);
    for _ in 0..3 {
        ui.char(' ');
        ui.press(KeyCode::Down);
    }
    ui.press(KeyCode::Enter);
    ui.expect("Keep at least one slice");
    assert!(ui.ports.created().is_empty());
    assert!(load_roadmap(ui.ports.path()).is_none());
}
