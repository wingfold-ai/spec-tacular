//! The ground rules, by keystroke: `onboarding-e2e`'s "the ground rules".
//!
//! The advisor is the real `core::advisor` writing real Foundation files; only
//! the model behind it is scripted, answering by what the prompt contains —
//! the TypeScript suite's fake `Ask`, at the same boundary.

use std::fs;
use std::sync::{Arc, Mutex};

use crossterm::event::KeyCode;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::Ui;
use crate::core::advisor::Ask;
use crate::core::foundation::{foundation_dir, guided_questions, GuidedQuestion};
use crate::tui::app::{Msg, Screen};
use crate::tui::fake::{change_with, FakePorts};
use crate::tui::ports::{Ports, ProjectPorts, NO_ADVISOR_YET};

/// A model that answers every prompt with `answer(prompt)`.
fn model(answer: impl Fn(&str) -> Result<Value, String> + Send + Sync + 'static) -> Ask {
    Arc::new(move |prompt: String, _schema| {
        let result = answer(&prompt);
        Box::pin(async move { result })
    })
}

/// Records every prompt it is sent.
fn recording(
    answer: impl Fn(&str) -> Value + Send + Sync + 'static,
) -> (Ask, Arc<Mutex<Vec<String>>>) {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&prompts);
    let ask = model(move |prompt| {
        seen.lock().expect("prompts").push(prompt.to_owned());
        Ok(answer(prompt))
    });
    (ask, prompts)
}

/// A model that knows exactly one thing: Python needs a version.
fn python_advisor() -> (Ask, Arc<Mutex<Vec<String>>>) {
    recording(|prompt| {
        if prompt.contains("Answer: Python") {
            json!({
                "followUps": [{
                    "ask": "Which Python version?",
                    "why": "Pins the syntax code and CI can rely on.",
                    "options": [
                        { "label": "3.14", "detail": "Latest stable", "recommended": true },
                        { "label": "3.13", "detail": "Previous stable", "recommended": false },
                    ],
                }],
                "upcoming": [
                    { "label": "FastAPI", "detail": "Async, typed", "recommended": true },
                    { "label": "Django", "detail": "Batteries included", "recommended": false },
                ],
            })
        } else {
            json!({ "followUps": [], "upcoming": [] })
        }
    })
}

/// An existing project — the vision step is for new ones — with `ask` as
/// its model, or no advisor.
fn mount(ask: Option<Ask>) -> Ui {
    let ports = FakePorts::with_baseline();
    Ui::mount(match ask {
        Some(ask) => ports.with_ask(ask),
        None => ports,
    })
}

/// Set up, past the intro, on the first question.
fn begun(ask: Option<Ask>) -> Ui {
    let mut ui = mount(ask);
    ui.press(KeyCode::Enter); // Start
    ui.press(KeyCode::Enter); // Begin
    ui
}

fn stack(ui: &Ui) -> String {
    fs::read_to_string(foundation_dir(ui.ports.path()).join("stack.md")).expect("stack.md")
}

fn questions(ui: &Ui) -> Vec<GuidedQuestion> {
    guided_questions(ui.ports.path())
}

#[test]
fn an_empty_folder_is_guided_all_the_way_to_its_first_proposal() {
    let mut ui = begun(None);
    ui.expect("Stack · What the project is built with.");
    ui.expect("Language and runtime, with versions.");
    ui.expect("e.g. \"TypeScript 5.6 on Bun 1.4\"");
    ui.expect("type your answer — or \"skip\"");

    ui.type_text("TypeScript on Bun");
    ui.expect("› TypeScript on Bun");
    ui.press(KeyCode::Enter);
    ui.expect("Framework, if any");
    assert!(stack(&ui).contains("TypeScript on Bun"));

    // Enter on an empty, unanswered question explains instead of skipping.
    ui.press(KeyCode::Enter);
    ui.expect("press tab (or type \"skip\")");

    for i in 1..19 {
        ui.type_text(&format!("answer {i}"));
        ui.press(KeyCode::Enter);
    }
    ui.expect("All 19 ground rules are answered.");
    ui.expect("▶ Continue to your first change");
    ui.press(KeyCode::Enter);

    // First change: explained, then created from the overview.
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("Ground rules are set. Next: your first change.");
    ui.expect("+ New change");
    ui.char('n');
    ui.expect("What do you want to change, and why?");
    ui.type_text("Let users log in with email");
    ui.press(KeyCode::Enter);
    ui.expect("› log-email▏");
    ui.ctrl('u');
    ui.type_text("add-login");
    ui.press(KeyCode::Enter);
    ui.expect("Created add-login.");
    ui.expect("Write the proposal");

    // Enter presses the highlighted button: the next step.
    ui.press(KeyCode::Enter);
    assert_eq!(ui.ports.dispatched(), ["add-login/proposal"]);
    ui.expect("drafting add-login/proposal");
}

#[test]
fn the_advisor_digs_into_an_answer_before_moving_on_and_proposes_options() {
    let (ask, prompts) = python_advisor();
    let mut ui = mount(Some(ask));
    ui.press(KeyCode::Enter);
    ui.expect("Not sure? Press ?");
    ui.expect("✦ An AI assistant digs deeper");
    ui.press(KeyCode::Enter);

    ui.type_text("Python");
    ui.press(KeyCode::Enter);

    // The answer was sent with everything decided so far.
    let advised = prompts
        .lock()
        .expect("prompts")
        .iter()
        .find(|p| p.contains("Answer: Python"))
        .cloned()
        .expect("the answer was advised on");
    assert!(advised.contains("Just answered — [Stack] Language and runtime, with versions."));
    assert!(advised.contains("most recent stable release"));

    // What the answer left open is asked straight away, not after the rest.
    ui.expect("Which Python version?");
    ui.expect("✦ follow-up to “Language and runtime, with versions.” — Pins the syntax");
    ui.expect("▸ 3.14");
    ui.expect("★ recommended");
    ui.expect("✦ 1 follow-up on “Language and runtime, with versions.”");

    // ↓ moves off the recommendation; enter takes what is selected.
    ui.press(KeyCode::Down);
    ui.expect("▸ 3.13");
    ui.press(KeyCode::Enter);
    assert!(stack(&ui).contains("## Which Python version?\n\n3.13"));

    // Then on: the next question's options came with the first request.
    ui.expect("Framework, if any");
    ui.expect("▸ FastAPI");
    ui.expect("✎ Write my own answer");
    ui.press(KeyCode::Enter);
    assert!(
        stack(&ui).contains("## Framework, if any, and why it over the alternatives.\n\nFastAPI")
    );
}

#[test]
fn while_it_looks_at_an_answer_enter_moves_on_without_waiting() {
    let (release, held) = oneshot::channel::<Value>();
    let held = Arc::new(Mutex::new(Some(held)));
    let ask: Ask = Arc::new(move |prompt: String, _schema| {
        // The advice on the answer waits for the test; anything else — the
        // options for the question on screen — never comes back at all.
        let rx = prompt
            .contains("Answer: Python")
            .then(|| held.lock().expect("held").take())
            .flatten();
        Box::pin(async move {
            match rx {
                Some(rx) => rx.await.map_err(|e| e.to_string()),
                None => std::future::pending().await,
            }
        })
    });
    let mut ui = begun(Some(ask));
    ui.type_text("Python");
    ui.press(KeyCode::Enter);
    ui.expect("✓ Saved: Python");
    ui.expect("Looking at your answer");
    ui.expect("continue without waiting");
    ui.press(KeyCode::Enter);
    ui.expect("Framework, if any");

    // What arrives late is a notice, and does not pull the cursor back.
    release
        .send(json!({
            "followUps": [{ "ask": "Which Python version?", "why": "", "options": [] }],
            "upcoming": [],
        }))
        .expect("release");
    ui.settle();
    ui.expect("Framework, if any");
    ui.expect("✦ 1 follow-up on “Language and runtime, with versions.”");
    assert!(stack(&ui).contains("## Which Python version?"));
}

#[test]
fn not_sure_an_explanation_examples_and_a_simpler_question_first() {
    let ask = model(|prompt| {
        Ok(if prompt.contains("does not know how to answer") {
            json!({
                "explain": "Which language the code is written in, and the program that runs it.",
                "examples": [
                    { "label": "TypeScript on Node 24", "detail": "web and tooling", "recommended": true },
                    { "label": "Python 3.14", "detail": "data and scripting", "recommended": false },
                ],
                "probes": [{
                    "ask": "What will people use it through?",
                    "why": "A browser app and a data pipeline want different languages.",
                    "options": [{ "label": "A website", "detail": "", "recommended": true }],
                }],
            })
        } else if prompt.contains("Answer: A website") {
            json!({
                "followUps": [],
                "upcoming": [],
                "derived": [{
                    "question": "Language and runtime, with versions.",
                    "answer": "TypeScript on Node 24",
                    "reason": "a website",
                }],
            })
        } else {
            json!({ "followUps": [], "upcoming": [], "derived": [] })
        })
    });
    let mut ui = begun(Some(ask));
    ui.expect("? I'm not sure");

    ui.type_text("not sure");
    ui.press(KeyCode::Enter);

    // A simpler question comes first, marked as helping the harder one.
    ui.expect("What will people use it through?");
    ui.expect("✦ a simpler question, to help decide “Language and runtime, with versions.”");
    ui.expect("✦ 1 simpler question first");
    ui.press(KeyCode::Enter); // "A website"

    // Back to the hard one: explained, with examples — and an answer derived
    // from the simpler one, selected, waiting for a yes.
    ui.expect("Language and runtime, with versions.");
    ui.expect("💡");
    ui.expect("Which language the code is written in");
    ui.expect("▸ ⇐ TypeScript on Node 24");
    ui.expect("from your earlier answers: a website");
    ui.expect("⇐ derived from earlier answers");
    ui.press(KeyCode::Enter);
    assert!(stack(&ui).contains("## Language and runtime, with versions.\n\nTypeScript on Node 24"));
}

#[test]
fn question_mark_and_an_empty_enter_both_ask_for_help() {
    let coached = Arc::new(Mutex::new(0));
    let count = Arc::clone(&coached);
    let ask = model(move |prompt| {
        if prompt.contains("does not know how to answer") {
            *count.lock().expect("count") += 1;
        }
        Ok(json!({
            "explain": "x", "examples": [], "probes": [],
            "followUps": [], "upcoming": [], "derived": [],
        }))
    });
    let mut ui = begun(Some(ask));
    ui.char('?');
    // Help stays on the question when there is nothing simpler to ask.
    ui.expect("Language and runtime, with versions.");
    ui.expect("💡");
    ui.press(KeyCode::Down); // onto the help row
    ui.press(KeyCode::Enter);
    assert_eq!(*coached.lock().expect("count"), 2);
    // And enter on nothing, with "write my answer" chosen, asks too.
    ui.press(KeyCode::Down); // back to "write my answer"
    ui.press(KeyCode::Enter);
    assert_eq!(*coached.lock().expect("count"), 3);
}

#[test]
fn typing_skip_skips() {
    let mut ui = begun(None);
    ui.type_text("skip");
    ui.press(KeyCode::Enter);
    ui.expect("Framework, if any");
    assert!(!stack(&ui).contains("skip"));
}

#[test]
fn a_follow_up_can_be_dismissed_as_not_relevant() {
    let (ask, _) = python_advisor();
    let mut ui = begun(Some(ask));
    ui.type_text("Python");
    ui.press(KeyCode::Enter);
    ui.expect("Which Python version?");
    ui.expect("ctrl+d");
    ui.ctrl('d');
    ui.expect("Removed “Which Python version?”");
    assert!(!stack(&ui).contains("Which Python version?"));
}

#[test]
fn typing_replaces_a_proposed_option_with_your_own_answer() {
    let (ask, _) = python_advisor();
    let mut ui = begun(Some(ask));
    ui.type_text("Python");
    ui.press(KeyCode::Enter);
    ui.expect("▸ 3.14");
    ui.type_text("3.12.4, pinned by our platform team");
    ui.expect_not("▸ 3.14");
    ui.press(KeyCode::Enter);
    assert!(stack(&ui).contains("3.12.4, pinned by our platform team"));
}

#[test]
fn a_failing_advisor_is_a_line_on_screen_never_a_blocker() {
    let mut ui = begun(Some(model(|_| Err("rate limited".to_owned()))));
    ui.type_text("Go 1.23");
    ui.press(KeyCode::Enter);
    ui.expect("AI suggestions failed: rate limited");
    ui.expect("Framework, if any");
    // Not re-asked for as long as the question is shown.
    assert!(ui.app.ground.thinking.is_empty());
}

#[test]
fn leaving_half_done_is_fine_but_blocks_a_change() {
    let mut ui = begun(None);
    ui.type_text("Go 1.23");
    ui.press(KeyCode::Enter);
    ui.ctrl('c');

    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("Ground rules: 1 of 19 answered.");
    ui.char('n');
    ui.expect("Settle the ground rules first");

    // f comes back to the next open question, not the intro.
    ui.char('f');
    ui.expect("Framework, if any");
    ui.expect_not("▶ Begin");
}

#[test]
fn tab_skips_a_question_and_left_returns_to_it() {
    let mut ui = begun(None);
    ui.press(KeyCode::Tab);
    ui.expect("Framework, if any");
    ui.press(KeyCode::Left);
    ui.expect("Language and runtime, with versions.");
    ui.expect("0/19");
}

// --- beyond the TypeScript suite ---------------------------------------------

#[test]
fn skipped_questions_come_after_the_open_ones() {
    let mut ui = begun(None);
    ui.press(KeyCode::Tab); // skip the language
    for i in 1..19 {
        ui.type_text(&format!("answer {i}"));
        ui.press(KeyCode::Enter);
    }
    // Everything else answered: back to the one skipped.
    ui.expect("Language and runtime, with versions.");
    ui.type_text("Go");
    ui.press(KeyCode::Enter);
    ui.expect("All 19 ground rules are answered.");
}

#[test]
fn the_done_panel_goes_back_to_the_last_answer_with_left() {
    let mut ui = begun(None);
    for i in 0..19 {
        ui.type_text(&format!("answer {i}"));
        ui.press(KeyCode::Enter);
    }
    ui.expect("✓ All 19 ground rules are answered.");
    ui.press(KeyCode::Left);
    ui.expect("Anything a new contributor reliably gets wrong.");
    ui.expect("✓ Current answer: answer 18");
    ui.expect("enter  keep");
    // Enter on an answered question keeps it and moves on: to the end.
    ui.press(KeyCode::Enter);
    ui.expect("✓ All 19 ground rules are answered.");
}

#[test]
fn without_an_advisor_help_says_so_and_is_not_offered() {
    let mut ui = begun(None);
    ui.expect("AI suggestions off: none in this test");
    ui.expect_not("? I'm not sure");
    ui.expect_not("?  not sure");
    ui.char('?');
    ui.expect("AI help is off (none in this test). Type what you know, or tab to skip.");
}

#[test]
fn ctrl_e_opens_the_question_in_the_editor_and_reads_it_back() {
    let mut ui = begun(None);
    ui.on_edit = Some(Box::new(|file| {
        let text = fs::read_to_string(file).expect("read");
        fs::write(file, text.replacen("TBD", "Rust 1.90, edition 2024", 1)).expect("write");
    }));
    ui.ctrl('e');
    let first = questions(&ui).remove(0);
    let (file, line) = ui.editors.last().cloned().expect("an editor");
    assert_eq!(file.display().to_string(), first.item.file);
    assert_eq!(line, first.item.line);
    ui.expect("✓ Current answer: Rust 1.90, edition 2024");
    ui.expect("1/19");
}

#[test]
fn a_choice_is_picked_with_a_click() {
    let (ask, _) = python_advisor();
    let mut ui = begun(Some(ask));
    ui.type_text("Python");
    ui.press(KeyCode::Enter);
    let (x, y) = ui.find("3.13");
    ui.click(x, y);
    assert!(stack(&ui).contains("## Which Python version?\n\n3.13"));
}

#[test]
fn begin_and_continue_are_clickable() {
    let mut ui = mount(None);
    ui.press(KeyCode::Enter); // Start
    let (x, y) = ui.find("▶ Begin — 19 questions");
    ui.click(x, y);
    ui.expect("Language and runtime, with versions.");
}

#[test]
fn continue_ground_rules_on_the_start_screen_returns_to_the_next_open_question() {
    let mut ui = begun(None);
    ui.type_text("Go 1.23");
    ui.press(KeyCode::Enter);
    ui.ctrl('c');
    ui.char('h');
    ui.expect("Ground rules: 1 of 19 answered.");
    ui.expect("▶ Continue ground rules");
    ui.press(KeyCode::Enter);
    assert_eq!(ui.app.screen, Screen::Foundation);
    ui.expect("Framework, if any");
}

#[test]
fn f_on_a_project_without_a_foundation_sets_it_up_first() {
    // Adopted OpenSpec before spec-tacular: changes, but no ground rules.
    let ports = FakePorts::with_baseline();
    fs::create_dir_all(ports.path().join("openspec/changes")).expect("openspec");
    ports.add_change(change_with("add-login", &[]));
    let mut ui = Ui::mount(ports);
    ui.press(KeyCode::Enter); // Open project
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.char('f');
    assert_eq!(ui.app.screen, Screen::Foundation);
    ui.expect("▶ Begin — 19 questions");
    assert_eq!(questions(&ui).len(), 19);
}

#[test]
fn advice_that_arrives_after_leaving_does_not_pull_you_back() {
    let (release, held) = oneshot::channel::<Value>();
    let held = Arc::new(Mutex::new(Some(held)));
    let ask: Ask = Arc::new(move |_prompt: String, _schema| {
        let rx = held.lock().expect("held").take();
        Box::pin(async move {
            match rx {
                Some(rx) => rx.await.map_err(|e| e.to_string()),
                None => Ok(json!({ "followUps": [], "upcoming": [] })),
            }
        })
    });
    let mut ui = mount(Some(ask));
    ui.press(KeyCode::Enter); // Start
    ui.press(KeyCode::Enter); // Begin: the first question's options are asked for, and held
    ui.expect("AI is thinking about “Language and runtime, with versions.”");
    ui.expect("looking for options…");
    ui.ctrl('c');
    assert_eq!(ui.app.screen, Screen::Overview);
    release
        .send(json!({ "followUps": [], "upcoming": [{ "label": "Go", "detail": "", "recommended": true }] }))
        .expect("release");
    ui.settle();
    assert_eq!(ui.app.screen, Screen::Overview);
    assert!(ui.app.ground.thinking.is_empty());
    // It was not wasted: the options are there when you come back.
    ui.char('f');
    ui.press(KeyCode::Enter); // Begin — nothing is answered yet
    ui.expect("▸ Go");
}

#[test]
fn a_stale_read_of_the_questions_is_dropped() {
    let mut ui = begun(None);
    let fresh = ui.app.ground.questions.clone();
    let older = ui.app.latest.foundation - 1;
    let effects = ui.app.on_msg(
        ui.ports.as_ref(),
        Msg::FoundationRead {
            generation: older,
            questions: Vec::new(),
            meta: Default::default(),
        },
    );
    ui.run(effects);
    assert_eq!(ui.app.ground.questions, fresh);
    ui.expect("Language and runtime, with versions.");
}

#[test]
fn a_refused_answer_keeps_you_on_the_question_with_it_still_typed() {
    let mut ui = begun(None);
    // The section is renamed behind the screen's back.
    let first = questions(&ui).remove(0);
    let text = fs::read_to_string(&first.item.file).expect("read");
    fs::write(
        &first.item.file,
        text.replace("## Language and runtime, with versions.", "## Language."),
    )
    .expect("write");
    ui.type_text("Go");
    ui.press(KeyCode::Enter);
    ui.expect("is no longer in");
    ui.expect("› Go▏");
}

#[test]
fn the_real_ports_say_the_advisor_is_stage_8() {
    let dir = tempfile::tempdir().expect("temp dir");
    let ports = ProjectPorts::new(dir.path(), None, "claude");
    assert_eq!(ports.advisor_note().as_deref(), Some(NO_ADVISOR_YET));
}
