//! The ground-rules screen, drawn: each state it can be in, as a frame.
//!
//! The advisor's state is set directly on the app here — what it proposes,
//! what it is working on — so each state is drawn exactly, without scripting
//! a model to reach it. `ground_rules` drives the same states by keystroke.

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::advisor::{AdviceOption, DerivedAnswer, QuestionMeta};
use crate::tui::fake::FakePorts;
use crate::tui::foundation::{Helping, Waiting};

fn option(label: &str, detail: &str, recommended: bool) -> AdviceOption {
    AdviceOption {
        label: label.to_owned(),
        detail: detail.to_owned(),
        recommended,
    }
}

/// On the intro, with (`true`) or without an advisor.
fn intro(advisor: bool) -> Ui {
    let mut ui = Ui::mount(FakePorts::with_baseline());
    ui.press(KeyCode::Enter); // Start
    if advisor {
        ui.app.ground.note = None;
    }
    ui
}

/// On the first question, no advisor.
fn first_question() -> Ui {
    let mut ui = intro(false);
    ui.press(KeyCode::Enter); // Begin
    ui
}

/// On the first question, pretending an advisor said `meta` about it.
fn advised(meta: QuestionMeta) -> Ui {
    let mut ui = first_question();
    ui.app.ground.note = None;
    let id = ui.app.ground.questions[0].item.id.clone();
    ui.app.ground.meta.insert(id, meta);
    // A key that does nothing, so the selection is chosen for the new rows
    // as it is after any key.
    ui.press(KeyCode::F(5));
    ui
}

#[test]
fn the_intro_explains_the_four_documents_and_offers_the_questions() {
    let mut ui = intro(true);
    ui.expect("╭─ Ground rules ─");
    ui.expect("Before the first change, settle the ground rules.");
    // The table keeps its columns.
    ui.expect("  Stack          what it is built with");
    ui.expect("  Architecture   how the code is shaped and which way dependencies point");
    ui.expect("Not decided yet? Press tab or type \"skip\"");
    ui.expect("✦ An AI assistant digs deeper where an answer leaves something open,");
    ui.expect("  and proposes options with a recommendation. You always choose.");
    ui.expect("▶ Begin — 19 questions");
    ui.expect(" enter  begin ");
    ui.expect(" ctrl+c  back ");
    ui.expect("spec-tacular  ");
    ui.expect(" › ground rules");
}

#[test]
fn the_intro_says_when_ai_suggestions_are_off() {
    let mut ui = intro(false);
    ui.expect("AI suggestions are off: none in this test.");
    ui.expect_not("An AI assistant digs deeper");
}

#[test]
fn a_question_shows_progress_per_section_its_hint_and_an_empty_answer_box() {
    let mut ui = first_question();
    ui.expect("Stack ◆○○○○   Domain ○○○○   Architecture ○○○○○   Conventions ○○○○○");
    ui.expect("0/19");
    ui.expect("╭─ Stack · What the project is built with. ─");
    ui.expect("Language and runtime, with versions.");
    ui.expect("e.g. \"TypeScript 5.6 on Bun 1.4\" or \"Python 3.12, CPython\"");
    ui.expect(" ▸ ✎ Write my answer");
    ui.expect("› ▏type your answer — or \"skip\", or \"?\" if you are not sure");
    ui.expect("AI suggestions off: none in this test");
    ui.expect(" ↑↓  choose ");
    ui.expect(" enter  save ");
    ui.expect(" tab  skip ");
    ui.expect(" ←→  questions ");
    ui.expect(" ctrl+e  editor ");
    ui.expect_not("ctrl+d");
}

#[test]
fn an_answered_question_shows_its_answer_and_enter_keeps_it() {
    let mut ui = first_question();
    ui.type_text("Go 1.23");
    ui.press(KeyCode::Enter);
    ui.press(KeyCode::Left);
    ui.expect("Stack ◆○○○○");
    ui.expect("1/19");
    ui.expect("✓ Current answer: Go 1.23");
    ui.expect(" enter  keep ");
    ui.press(KeyCode::Right);
    ui.expect("Stack ●◆○○○");
}

#[test]
fn a_draft_is_typed_into_the_box_and_wraps() {
    let mut ui = first_question();
    ui.type_text(&"word ".repeat(30));
    ui.expect("› word word");
    ui.expect("  word word");
    ui.expect(" enter  save ");
    ui.expect_not("type your answer —");
}

#[test]
fn options_line_up_with_the_recommendation_starred_and_a_legend() {
    let mut ui = advised(QuestionMeta {
        options: Some(vec![
            option("Rust 1.90", "Current stable", true),
            option("Go 1.25", "Simpler, GC", false),
        ]),
        suggested: Some(true),
        ..QuestionMeta::default()
    });
    // The recommendation starts selected.
    ui.expect(" ▸ Rust 1.90     ★  Current stable");
    ui.expect("   Go 1.25          Simpler, GC");
    ui.expect(" enter  pick ");
    ui.expect("? I'm not sure — explain it, show examples, ask me simpler questions");
    ui.expect("✎ Write my own answer");
    ui.expect("   ★ recommended · ↑↓ or click to choose");
    ui.expect("› or type your own answer…");
    ui.expect(" ?  not sure ");
    ui.press(KeyCode::Down);
    ui.expect(" ▸ Go 1.25");
    ui.press(KeyCode::Up);
    ui.press(KeyCode::Up);
    ui.expect(" ▸ ✎ Write my own answer");
    ui.expect("› ▏type your answer");
    ui.expect(" enter  save ");
}

#[test]
fn a_follow_up_says_what_raised_it_and_can_be_dismissed() {
    let mut ui = advised(QuestionMeta {
        parent: Some("Framework, if any".to_owned()),
        why: Some("It decides the router.".to_owned()),
        ..QuestionMeta::default()
    });
    ui.expect("✦ follow-up to “Framework, if any” — It decides the router.");
    // A follow-up's own why replaces the scaffold's hint.
    ui.expect_not("e.g. \"TypeScript 5.6");
    ui.expect(" ctrl+d  not relevant ");
}

#[test]
fn a_simpler_question_says_which_one_it_helps_decide() {
    let mut ui = advised(QuestionMeta {
        helps: Some("Datastore and how schema changes are managed.".to_owned()),
        ..QuestionMeta::default()
    });
    ui.expect(
        "✦ a simpler question, to help decide “Datastore and how schema changes are managed.”",
    );
    ui.expect(" ctrl+d  not relevant ");
}

#[test]
fn a_derived_answer_comes_first_on_its_own_line_with_its_reason_below() {
    let mut ui = advised(QuestionMeta {
        derived: Some(DerivedAnswer {
            answer: "TypeScript on Node 24".to_owned(),
            reason: "a website".to_owned(),
        }),
        explain: Some("Which language, and what runs it.".to_owned()),
        ..QuestionMeta::default()
    });
    ui.expect("Which language, and what runs it.");
    ui.expect("⇐ TypeScript on Node 24");
    ui.expect("     from your earlier answers: a website");
    ui.expect("   ⇐ derived from earlier answers · ★ recommended · ↑↓ or click to choose");
}

#[test]
fn waiting_on_the_advice_shows_the_answer_and_how_to_move_on() {
    let mut ui = first_question();
    if let Some(screen) = ui.app.foundation.as_mut() {
        screen.waiting = Some(Waiting {
            token: 1,
            answer: "Python".to_owned(),
            settled: None,
        });
    }
    ui.expect("✓ Saved: Python");
    ui.expect(
        "Looking at your answer — does it leave anything open? It may also answer later questions.",
    );
    ui.expect("  enter continues without waiting");
    ui.expect(" enter  continue without waiting ");
    // The choices and the box wait too.
    ui.expect_not("Write my answer");
    ui.expect_not("type your answer");
    assert!(ui.app.animating());
}

#[test]
fn asking_for_help_shows_a_spinner_over_the_choices() {
    let mut ui = first_question();
    if let Some(screen) = ui.app.foundation.as_mut() {
        screen.helping = Some(Helping {
            token: 1,
            settled: None,
        });
    }
    ui.expect("Working out how to help — an explanation, examples, and simpler questions…");
    ui.expect("✎ Write my answer");
}

#[test]
fn the_status_line_says_what_the_advisor_is_thinking_about() {
    let mut ui = advised(QuestionMeta::default());
    ui.app.ground.thinking = vec!["Language and runtime, with versions.".to_owned()];
    ui.expect("AI is thinking about “Language and runtime, with versions.”…");
    ui.expect("looking for options…");
    assert!(ui.app.animating());

    ui.app.ground.thinking.clear();
    ui.app.ground.notice = Some("✦ 2 follow-ups on “Language”".to_owned());
    ui.expect("✦ 2 follow-ups on “Language”");
    ui.expect_not("looking for options…");
}

#[test]
fn an_error_shows_under_the_answer_box() {
    let mut ui = first_question();
    ui.press(KeyCode::Enter);
    ui.expect("Type an answer, or press tab (or type \"skip\") to leave it for now");
    // Typing clears it.
    ui.char('G');
    ui.expect_not("Type an answer, or press tab");
}

#[test]
fn the_done_panel_says_where_the_answers_live() {
    let mut ui = first_question();
    ui.ports.settle_ground_rules();
    // One more answer, the rest behind the screen's back: then a re-read.
    let effect = ui.app.read_foundation(ui.ports.as_ref());
    ui.run(vec![effect]);
    ui.type_text("x");
    ui.press(KeyCode::Enter);
    ui.expect("✓ All 19 ground rules are answered.");
    // Wrapped at the TypeScript's 72 columns.
    ui.expect("They live in spec-tacular/foundation/ and go into every agent's");
    ui.expect("Change one any time with f from the overview, or by editing the");
    ui.expect("▶ Continue to your first change");
    ui.expect(" enter  continue ");
    ui.expect(" ←  revisit an answer ");
}

#[test]
fn a_small_terminal_still_draws_the_keys() {
    let mut ui = Ui::mount_sized(FakePorts::with_baseline(), 80, 20);
    ui.press(KeyCode::Enter);
    ui.expect("▶ Begin — 19 questions");
    ui.press(KeyCode::Enter);
    ui.expect("Language and runtime, with versions.");
    ui.expect(" ↑↓  choose ");
    ui.expect("AI suggestions off");
}
