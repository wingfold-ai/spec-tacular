//! The ground rules: one Foundation question at a time.
//!
//! The TypeScript `foundation.tsx`, and the advisor half of its `app.tsx`.
//! Asked before the first change because the first change's design otherwise
//! invents the architecture implicitly (docs/problem-analysis.md §9). The same
//! rule as the review screen applies — one thing on screen at a time.
//!
//! An advisor may propose options and add follow-up questions
//! ([`crate::core::advisor`]). It proposes; the developer decides. Nothing is
//! written until an option is picked or an answer typed, so the Foundation
//! still holds only decisions somebody made.
//!
//! Two kinds of state, as in the TypeScript. [`GroundRules`] is the app's:
//! the questions, what the advisor remembers about them and what it is
//! working on — it outlives the screen, because advice keeps arriving after
//! you leave. [`FoundationScreen`] is the screen's own — the cursor, the
//! draft, what was skipped — and goes when you leave it.
//!
//! Every answer is written before the next key is read, as a review decision
//! is. Everything else — re-reading the questions, and every advisor request —
//! runs off the loop's thread and comes back as a message. A re-read carries a
//! request number and a stale one is dropped; what the screen was waiting on
//! (the advice on an answer, help with a question) is held in its state and
//! acted on when the next fresh read lands, so it is acted on against the
//! questions that include what the advisor just added.

use std::collections::BTreeSet;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Paragraph};
use ratatui::Frame;

use super::app::{spawn, AfterEditor, AfterSetup, App, Effect, Hits, Msg, Screen, Target};
use super::input::{edit_line, is_cancel, is_ctrl, is_enter};
use super::ports::Ports;
use super::theme;
use super::widgets::{
    clip, panel, panel_inner, render_key_bar, spinner_line, Button, Flow, BUTTON_HEIGHT,
};
use crate::core::advisor::{AdviceOption, AfterAnswer, Coached, Meta, QuestionMeta};
use crate::core::foundation::GuidedQuestion;
use crate::render::requirement::wrap;

/// Typed instead of an answer, these ask for help.
const HELP_WORDS: [&str; 11] = [
    "?",
    "help",
    "help me",
    "idk",
    "i don't know",
    "i dont know",
    "dont know",
    "don't know",
    "not sure",
    "i'm not sure",
    "no idea",
];
/// Typed instead of an answer, these skip the question.
const SKIP_WORDS: [&str; 4] = ["skip", "/skip", "later", "pass"];

pub const INTRO: [&str; 12] = [
    "Every agent that writes a proposal, spec or design for this project reads",
    "these first — so it builds on your decisions instead of inventing its own.",
    "",
    "  Stack          what it is built with",
    "  Domain         what it is about: its purpose, vocabulary and rules",
    "  Architecture   how the code is shaped and which way dependencies point",
    "  Conventions    how the team works on it",
    "",
    "Answer what you know. Not sure? Press ? (or type \"help\") and you get an",
    "explanation, examples for your project, and simpler questions first.",
    "Not decided yet? Press tab or type \"skip\" — it stays open, and no change",
    "can start until it is answered. Answers are saved as you go.",
];

const LOOKING: &str =
    "Looking at your answer — does it leave anything open? It may also answer later questions.";
const HELPING: &str = "Working out how to help — an explanation, examples, and simpler questions…";

/// The advisor's side of the ground rules, kept by the app across visits.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroundRules {
    /// The questions as last read, in the order they are asked.
    pub questions: Vec<GuidedQuestion>,
    /// What the advisor remembers, by question id.
    pub meta: Meta,
    /// Why there are no AI suggestions; `None` when there is an advisor.
    pub note: Option<String>,
    /// Advisor requests in flight, by the question they are about.
    pub thinking: Vec<String>,
    /// A transient line: what the advisor just did, or that it failed.
    pub notice: Option<String>,
    /// Questions whose suggestions failed this session — not asked again: a
    /// failure that repeats (no network, no credit) would otherwise re-ask
    /// for as long as the question is shown.
    pub failed: BTreeSet<String>,
    /// The question on screen, by id — the one options are fetched for.
    pub shown: Option<String>,
    /// The screen opens when the next read lands.
    pub opening: Option<Opening>,
}

impl GroundRules {
    pub fn has_advisor(&self) -> bool {
        self.note.is_none()
    }
}

/// Why the ground rules are about to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opening {
    /// Asked for: `f`, a button. With no questions yet, set them up first.
    Asked,
    /// Setup just wrote the questions.
    AfterSetup,
}

/// An answer was saved and the advisor is looking at it before moving on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub token: u64,
    pub answer: String,
    /// The advice came back, adding these questions; acted on when the
    /// questions that include them have been read.
    pub settled: Option<Vec<String>>,
}

/// Help was asked for the current question and is on its way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Helping {
    pub token: u64,
    /// The simpler questions it added, once it came back.
    pub settled: Option<Vec<String>>,
}

/// The screen's own state; dropped when it is left.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FoundationScreen {
    /// Nothing answered yet: what this is, before the first question.
    pub intro: bool,
    /// The question on screen, by id — so a re-read after a save, a
    /// follow-up arriving or an edit in the file cannot silently move you to
    /// another question.
    pub cursor: Option<String>,
    pub draft: String,
    pub error: Option<String>,
    /// Every question is answered.
    pub done: bool,
    /// Skipped this visit, so "next" does not come straight back to them.
    pub skipped: BTreeSet<String>,
    /// Index into [`App::ground_rows`].
    pub sel: usize,
    /// The question and row count the selection was last chosen for.
    sel_for: Option<(Option<String>, usize)>,
    pub waiting: Option<Waiting>,
    pub helping: Option<Helping>,
}

impl FoundationScreen {
    fn new(questions: &[GuidedQuestion]) -> Self {
        Self {
            intro: questions.iter().all(|q| !q.answered),
            cursor: questions
                .iter()
                .find(|q| !q.answered)
                .or_else(|| questions.first())
                .map(|q| q.item.id.clone()),
            ..Self::default()
        }
    }
}

/// A row in the choice list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    /// A proposed answer; `derived` carries why, when it follows from
    /// earlier answers.
    Choice {
        option: AdviceOption,
        derived: Option<String>,
    },
    /// Ask for help.
    Help,
    /// Write your own answer.
    Own,
}

/// `thinking` without every copy of `label` — the TypeScript's filter.
fn without(thinking: &mut Vec<String>, label: &str) {
    thinking.retain(|l| l != label);
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

impl App {
    // --- derived --------------------------------------------------------

    /// Where the cursor is, falling back to the first question.
    pub fn ground_index(&self) -> usize {
        let cursor = self.foundation.as_ref().and_then(|f| f.cursor.as_deref());
        self.ground
            .questions
            .iter()
            .position(|q| Some(q.item.id.as_str()) == cursor)
            .unwrap_or(0)
    }

    pub fn ground_current(&self) -> Option<&GuidedQuestion> {
        self.ground.questions.get(self.ground_index())
    }

    /// What the advisor remembers about the current question.
    pub fn ground_meta(&self) -> QuestionMeta {
        self.ground_current()
            .and_then(|q| self.ground.meta.get(&q.item.id))
            .cloned()
            .unwrap_or_default()
    }

    /// The choice list: an answer derived from earlier ones first, then the
    /// proposals, then asking for help, then writing your own.
    pub fn ground_rows(&self) -> Vec<Row> {
        let meta = self.ground_meta();
        let answered = self.ground_current().is_some_and(|q| q.answered);
        let derived = meta.derived.filter(|_| !answered);
        let mut rows = Vec::new();
        if let Some(d) = &derived {
            rows.push(Row::Choice {
                option: AdviceOption {
                    label: d.answer.clone(),
                    detail: d.reason.clone(),
                    recommended: false,
                },
                derived: Some(d.reason.clone()),
            });
        }
        for option in meta.options.unwrap_or_default() {
            if derived
                .as_ref()
                .is_some_and(|d| option.label.to_lowercase() == d.answer.to_lowercase())
            {
                continue;
            }
            rows.push(Row::Choice {
                option,
                derived: None,
            });
        }
        if self.ground.has_advisor() {
            rows.push(Row::Help);
        }
        rows.push(Row::Own);
        rows
    }

    /// Options for this question are on their way: asked for directly, or as
    /// part of advising on the answer just given, which proposes them for the
    /// next question too.
    pub fn ground_thinking_here(&self) -> bool {
        let Some(q) = self.ground_current() else {
            return false;
        };
        let thinking = &self.ground.thinking;
        thinking.contains(&q.item.name)
            || (!thinking.is_empty() && !q.answered && !self.ground_meta().is_suggested())
    }

    /// The key bar under the question.
    pub fn ground_keys(&self) -> Vec<(&'static str, &'static str)> {
        let Some(screen) = self.foundation.as_ref() else {
            return Vec::new();
        };
        if screen.intro {
            return vec![("enter", "begin"), ("ctrl+c", "back")];
        }
        if screen.done {
            return vec![("enter", "continue"), ("←", "revisit an answer")];
        }
        if screen.waiting.is_some() {
            return vec![("enter", "continue without waiting"), ("ctrl+c", "back")];
        }
        let rows = self.ground_rows();
        let enter = if !screen.draft.is_empty() {
            "save"
        } else if matches!(rows.get(screen.sel), Some(Row::Choice { .. })) {
            "pick"
        } else if self.ground_current().is_some_and(|q| q.answered) {
            "keep"
        } else {
            "save"
        };
        let mut keys = vec![("↑↓", "choose"), ("enter", enter)];
        if self.ground.has_advisor() {
            keys.push(("?", "not sure"));
        }
        keys.extend([("tab", "skip"), ("←→", "questions"), ("ctrl+e", "editor")]);
        if self.ground_meta().is_added() {
            keys.push(("ctrl+d", "not relevant"));
        }
        keys.push(("ctrl+c", "back"));
        keys
    }

    /// Something on the ground-rules screen moves.
    pub fn ground_animating(&self) -> bool {
        self.screen == Screen::Foundation
            && (!self.ground.thinking.is_empty()
                || self
                    .foundation
                    .as_ref()
                    .is_some_and(|f| f.waiting.is_some() || f.helping.is_some()))
    }

    // --- opening and leaving ----------------------------------------------

    /// `f`, "Ground rules", "Continue ground rules": re-read the questions,
    /// then open on the first open one. A project that adopted OpenSpec
    /// before spec-tacular has no Foundation yet; asking for it is the moment
    /// to write the questions.
    pub(super) fn open_foundation(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        self.ground.opening = Some(Opening::Asked);
        vec![self.read_foundation(ports)]
    }

    /// Setup finished: the questions exist now.
    pub(super) fn open_after_setup(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        self.ground.opening = Some(Opening::AfterSetup);
        vec![self.read_foundation(ports)]
    }

    fn enter_foundation(&mut self) {
        self.notice = None;
        self.foundation = Some(FoundationScreen::new(&self.ground.questions));
        self.screen = Screen::Foundation;
    }

    /// Leaves, finished or not. A project whose next step is its vision goes
    /// where the vision interview will be — the overview, until stage 8.
    fn leave_foundation(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        self.ground.shown = None;
        self.foundation = None;
        self.refresh_project(ports);
        // Stage 8 sends `ProjectStage::Vision` to the interview instead.
        self.screen = Screen::Overview;
        Vec::new()
    }

    /// The questions and the advisor's memory, read off the loop's thread.
    pub(super) fn read_foundation(&mut self, ports: &dyn Ports) -> Effect {
        let generation = self.latest.issue();
        self.latest.foundation = generation;
        let questions = ports.questions();
        let meta = ports.advisor_meta();
        Effect::Spawn(Box::pin(async move {
            Msg::FoundationRead {
                generation,
                questions: questions.await,
                meta: meta.await,
            }
        }))
    }

    /// A read came back.
    pub(super) fn foundation_read(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        questions: Vec<GuidedQuestion>,
        meta: Meta,
    ) -> Vec<Effect> {
        // A newer read is on its way; whatever this one would have settled
        // is still pending in the state, for that one.
        if generation < self.latest.foundation {
            return Vec::new();
        }
        self.ground.questions = questions;
        self.ground.meta = meta;
        let mut effects = Vec::new();
        if let Some(opening) = self.ground.opening.take() {
            let here = matches!(self.screen, Screen::Home | Screen::Overview);
            if self.ground.questions.is_empty() {
                match opening {
                    Opening::Asked => {
                        return vec![spawn(ports.setup(), |result| Msg::SetUp {
                            result,
                            then: AfterSetup::Overview,
                        })];
                    }
                    Opening::AfterSetup => {
                        self.notice =
                            Some("Setup wrote no ground-rule questions to answer".to_owned());
                    }
                }
            } else if here {
                self.enter_foundation();
            }
        }
        if self.screen == Screen::Foundation {
            self.settle_pending();
            effects.extend(self.ground_sync(ports));
            if let Some(id) = self.ground.shown.clone() {
                effects.extend(self.maybe_suggest(ports, &id));
            }
        }
        effects
    }

    /// Acts on advice or help that came back, now that the questions it added
    /// have been read.
    fn settle_pending(&mut self) {
        let Some(screen) = self.foundation.as_mut() else {
            return;
        };
        if let Some(added) = screen.waiting.as_mut().and_then(|w| w.settled.take()) {
            screen.waiting = None;
            // What the answer left open is asked now, not after unrelated
            // questions.
            if !added.first().is_some_and(|name| self.go_to(name)) {
                self.advance();
            }
            return;
        }
        if let Some(probes) = screen.helping.as_mut().and_then(|h| h.settled.take()) {
            screen.helping = None;
            // Simpler questions first: they come before this one, so
            // answering them walks straight back here — often with an answer
            // derived.
            if let Some(first) = probes.first() {
                self.go_to(first);
            }
        }
    }

    /// What a Solid effect did in the TypeScript: when the question or its
    /// rows change, start on a derived answer, else the recommendation —
    /// unless typing already started; and when a new question comes on
    /// screen, ask for its options.
    fn ground_sync(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let rows = self.ground_rows();
        let current = self.ground_current().map(|q| q.item.id.clone());
        let Some(screen) = self.foundation.as_mut() else {
            return Vec::new();
        };
        let key = (current.clone(), rows.len());
        if screen.sel_for.as_ref() != Some(&key) {
            screen.sel_for = Some(key);
            if screen.draft.is_empty() {
                let derived = rows.iter().position(|r| {
                    matches!(
                        r,
                        Row::Choice {
                            derived: Some(_),
                            ..
                        }
                    )
                });
                let recommended = rows
                    .iter()
                    .position(|r| matches!(r, Row::Choice { option, .. } if option.recommended));
                screen.sel = derived.or(recommended).unwrap_or(rows.len() - 1);
            }
        }
        if screen.intro {
            return Vec::new();
        }
        match current {
            Some(id) if self.ground.shown.as_ref() != Some(&id) => {
                self.ground.shown = Some(id.clone());
                self.maybe_suggest(ports, &id)
            }
            _ => Vec::new(),
        }
    }

    // --- the advisor, in the background -----------------------------------

    /// Starts one advisor request, labelled by the question it is about.
    fn track(&mut self, label: &str) {
        self.ground.thinking.push(label.to_owned());
    }

    /// Options for a question, when it is shown and nobody has asked yet.
    ///
    /// Held back while any request is in flight: the answer just given is
    /// being advised on together with options for the question after it,
    /// and asking twice would pay twice for the same thing.
    fn maybe_suggest(&mut self, ports: &dyn Ports, id: &str) -> Vec<Effect> {
        if !self.ground.has_advisor()
            || !self.ground.thinking.is_empty()
            || self.ground.failed.contains(id)
        {
            return Vec::new();
        }
        let Some(question) = self.ground.questions.iter().find(|q| q.item.id == id) else {
            return Vec::new();
        };
        if question.answered
            || self
                .ground
                .meta
                .get(id)
                .is_some_and(QuestionMeta::is_suggested)
        {
            return Vec::new();
        }
        let question = question.clone();
        let label = question.item.name.clone();
        self.track(&label);
        let id = id.to_owned();
        vec![spawn(ports.suggest(&question), move |result| {
            Msg::Suggested { label, id, result }
        })]
    }

    pub(super) fn suggested(
        &mut self,
        ports: &dyn Ports,
        label: &str,
        id: String,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        without(&mut self.ground.thinking, label);
        if let Err(reason) = result {
            self.ground.failed.insert(id);
            self.ground.notice = Some(format!("AI suggestions failed: {reason}"));
        }
        vec![self.read_foundation(ports)]
    }

    pub(super) fn advised(
        &mut self,
        ports: &dyn Ports,
        token: u64,
        label: &str,
        result: Result<AfterAnswer, String>,
    ) -> Vec<Effect> {
        without(&mut self.ground.thinking, label);
        let added = match result {
            Ok(done) => {
                let mut parts = Vec::new();
                if !done.added.is_empty() {
                    parts.push(format!(
                        "{} follow-up{} on “{label}”",
                        done.added.len(),
                        plural(done.added.len())
                    ));
                }
                if !done.derived.is_empty() {
                    parts.push(format!(
                        "{} later answer{} derived — confirm when you get there",
                        done.derived.len(),
                        plural(done.derived.len())
                    ));
                }
                if !parts.is_empty() {
                    self.ground.notice = Some(format!("✦ {}", parts.join(" · ")));
                }
                done.added.into_iter().map(|f| f.ask).collect()
            }
            Err(reason) => {
                self.ground.notice = Some(format!("AI suggestions failed: {reason}"));
                Vec::new()
            }
        };
        // Only if still waiting on this very answer: enter may have moved on
        // without it, or the screen been left.
        if let Some(waiting) = self
            .foundation
            .as_mut()
            .and_then(|f| f.waiting.as_mut())
            .filter(|w| w.token == token)
        {
            waiting.settled = Some(added);
        }
        vec![self.read_foundation(ports)]
    }

    pub(super) fn coached(
        &mut self,
        ports: &dyn Ports,
        token: u64,
        label: &str,
        result: Result<Coached, String>,
    ) -> Vec<Effect> {
        without(&mut self.ground.thinking, label);
        let probes: Vec<String> = match result {
            Ok(coached) => {
                let n = coached.probes.len();
                self.ground.notice = Some(if n > 0 {
                    format!(
                        "✦ {n} simpler question{} first, to help decide “{label}”",
                        plural(n)
                    )
                } else {
                    format!("✦ Examples for “{label}” are listed — pick one or adapt it")
                });
                coached.probes.into_iter().map(|f| f.ask).collect()
            }
            Err(reason) => {
                self.ground.notice = Some(format!("AI suggestions failed: {reason}"));
                Vec::new()
            }
        };
        if let Some(helping) = self
            .foundation
            .as_mut()
            .and_then(|f| f.helping.as_mut())
            .filter(|h| h.token == token)
        {
            helping.settled = Some(probes);
        }
        vec![self.read_foundation(ports)]
    }

    pub(super) fn dismissed(
        &mut self,
        ports: &dyn Ports,
        name: &str,
        removed: bool,
    ) -> Vec<Effect> {
        if removed {
            self.ground.notice = Some(format!("Removed “{name}”"));
        }
        vec![self.read_foundation(ports)]
    }

    pub(super) fn foundation_edited(
        &mut self,
        ports: &dyn Ports,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        if let Err(reason) = result {
            self.ground.notice = Some(reason);
        }
        vec![self.read_foundation(ports)]
    }

    // --- moving -----------------------------------------------------------

    fn go(&mut self, i: isize) {
        let n = self.ground.questions.len();
        if n == 0 {
            return;
        }
        let at = usize::try_from(i.max(0)).unwrap_or(0).min(n - 1);
        let id = self.ground.questions[at].item.id.clone();
        if let Some(screen) = self.foundation.as_mut() {
            screen.cursor = Some(id);
            screen.draft.clear();
            screen.error = None;
            screen.waiting = None;
        }
    }

    fn go_to(&mut self, name: &str) -> bool {
        match self
            .ground
            .questions
            .iter()
            .position(|q| q.item.name == name)
        {
            Some(i) => {
                self.go(isize::try_from(i).unwrap_or(isize::MAX));
                true
            }
            None => false,
        }
    }

    /// The first open question, in order — not merely the one after this.
    ///
    /// Follow-ups are inserted straight after the answer that raised them,
    /// which is behind the cursor by the time they arrive. Taking the first
    /// open one means they come next, which is what "dig deeper" should feel
    /// like.
    fn advance(&mut self) {
        let index = self.ground_index();
        let Some(screen) = self.foundation.as_ref() else {
            return;
        };
        let qs = &self.ground.questions;
        let cursor = screen.cursor.as_deref();
        let open = |q: &GuidedQuestion| !q.answered;
        let next = qs
            .iter()
            .position(|q| {
                open(q)
                    && !screen.skipped.contains(&q.item.id)
                    && Some(q.item.id.as_str()) != cursor
            })
            .or_else(|| {
                qs.iter()
                    .enumerate()
                    .position(|(i, q)| open(q) && i > index)
            })
            .or_else(|| {
                qs.iter()
                    .position(|q| open(q) && Some(q.item.id.as_str()) != cursor)
            });
        match next {
            Some(i) => self.go(isize::try_from(i).unwrap_or(isize::MAX)),
            None => {
                if qs.iter().all(|q| q.answered) {
                    if let Some(screen) = self.foundation.as_mut() {
                        screen.done = true;
                    }
                }
            }
        }
    }

    fn skip(&mut self) {
        let id = self.ground_current().map(|q| q.item.id.clone());
        if let (Some(screen), Some(id)) = (self.foundation.as_mut(), id) {
            screen.skipped.insert(id);
        }
        self.advance();
    }

    // --- answering ----------------------------------------------------------

    /// Saves, then — with an advisor — stays put while it looks at the
    /// answer, so what the answer leaves open is asked now, not after
    /// unrelated questions. Enter moves on without waiting; what arrives
    /// later still comes up next.
    fn save(&mut self, ports: &dyn Ports, text: &str) -> Vec<Effect> {
        let Some(question) = self.ground_current().cloned() else {
            return Vec::new();
        };
        if let Err(reason) = ports.answer(&question, text) {
            if let Some(screen) = self.foundation.as_mut() {
                screen.error = Some(reason);
            }
            return Vec::new();
        }
        // Written; the re-read below confirms it, but moving on cannot wait
        // for a read to know that this question is answered now.
        if let Some(q) = self
            .ground
            .questions
            .iter_mut()
            .find(|q| q.item.id == question.item.id)
        {
            q.answered = true;
            q.item.text = text.trim().to_owned();
        }
        if let Some(screen) = self.foundation.as_mut() {
            screen.draft.clear();
            screen.error = None;
        }
        let mut effects = vec![self.read_foundation(ports)];
        if !self.ground.has_advisor() {
            self.advance();
            return effects;
        }
        self.ground.notice = None;
        let token = self.latest.issue();
        if let Some(screen) = self.foundation.as_mut() {
            screen.waiting = Some(Waiting {
                token,
                answer: text.to_owned(),
                settled: None,
            });
        }
        let label = question.item.name.clone();
        self.track(&label);
        effects.push(spawn(ports.after_answer(&question, text), move |result| {
            Msg::Advised {
                token,
                label,
                result,
            }
        }));
        effects
    }

    fn help(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let Some(question) = self.ground_current().cloned() else {
            return Vec::new();
        };
        let note = self.ground.note.clone();
        let Some(screen) = self.foundation.as_mut() else {
            return Vec::new();
        };
        if let Some(note) = note {
            screen.error = Some(if note.is_empty() {
                "Type what you know, or tab to skip.".to_owned()
            } else {
                format!("AI help is off ({note}). Type what you know, or tab to skip.")
            });
            return Vec::new();
        }
        screen.draft.clear();
        screen.error = None;
        let token = self.latest.issue();
        screen.helping = Some(Helping {
            token,
            settled: None,
        });
        let label = question.item.name.clone();
        self.track(&label);
        vec![spawn(ports.coach(&question), move |result| Msg::Coached {
            token,
            label,
            result,
        })]
    }

    fn submit(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let rows = self.ground_rows();
        let answered = self.ground_current().is_some_and(|q| q.answered);
        let Some((text, sel)) = self
            .foundation
            .as_ref()
            .map(|s| (s.draft.trim().to_owned(), s.sel))
        else {
            return Vec::new();
        };
        let word = text.to_lowercase().trim_end_matches(['.', '!']).to_owned();
        if SKIP_WORDS.contains(&word.as_str()) {
            if let Some(screen) = self.foundation.as_mut() {
                screen.draft.clear();
            }
            self.skip();
            return Vec::new();
        }
        if HELP_WORDS.contains(&word.as_str()) {
            return self.help(ports);
        }
        if !text.is_empty() {
            return self.save(ports, &text);
        }
        match rows.get(sel) {
            Some(Row::Choice { option, .. }) => return self.save(ports, &option.label),
            Some(Row::Help) => return self.help(ports),
            _ => {}
        }
        if answered {
            self.advance();
            return Vec::new();
        }
        // Enter on nothing, with nothing chosen, most often means "I don't
        // know".
        if self.ground.has_advisor() {
            return self.help(ports);
        }
        if let Some(screen) = self.foundation.as_mut() {
            screen.error = Some(
                "Type an answer, or press tab (or type \"skip\") to leave it for now".to_owned(),
            );
        }
        Vec::new()
    }

    fn dismiss(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        if !self.ground_meta().is_added() {
            return Vec::new();
        }
        let Some(question) = self.ground_current().cloned() else {
            return Vec::new();
        };
        let name = question.item.name.clone();
        vec![spawn(ports.dismiss(&question), move |removed| {
            Msg::Dismissed { name, removed }
        })]
    }

    // --- keys and clicks ----------------------------------------------------

    pub(super) fn foundation_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        let mut effects = self.foundation_key_inner(ports, key);
        if self.screen == Screen::Foundation {
            effects.extend(self.ground_sync(ports));
        }
        effects
    }

    fn foundation_key_inner(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        let Some(screen) = self.foundation.as_mut() else {
            return self.leave_foundation(ports);
        };
        if screen.intro {
            if is_enter(key) {
                screen.intro = false;
            } else if is_cancel(key) {
                return self.leave_foundation(ports);
            }
            return Vec::new();
        }
        if screen.done {
            if is_enter(key) || is_cancel(key) {
                return self.leave_foundation(ports);
            }
            if matches!(key.code, KeyCode::Left | KeyCode::Up) {
                screen.done = false;
                let last = self.ground.questions.len();
                self.go(isize::try_from(last).unwrap_or(isize::MAX) - 1);
            }
            return Vec::new();
        }
        if screen.waiting.is_some() {
            if is_enter(key) || key.code == KeyCode::Tab {
                screen.waiting = None;
                self.advance();
            } else if is_cancel(key) {
                return self.leave_foundation(ports);
            }
            return Vec::new();
        }
        if is_cancel(key) {
            return self.leave_foundation(ports);
        }
        if screen.helping.is_some() {
            return Vec::new();
        }
        if is_enter(key) {
            return self.submit(ports);
        }
        let plain = !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        match key.code {
            KeyCode::Tab => {
                self.skip();
                return Vec::new();
            }
            KeyCode::Char('?') if plain && screen.draft.is_empty() => return self.help(ports),
            KeyCode::Left => {
                let i = isize::try_from(self.ground_index()).unwrap_or(0);
                self.go(i - 1);
                return Vec::new();
            }
            KeyCode::Right => {
                let i = isize::try_from(self.ground_index()).unwrap_or(0);
                self.go(i + 1);
                return Vec::new();
            }
            KeyCode::Up | KeyCode::Down => {
                let n = self.ground_rows().len();
                if let Some(screen) = self.foundation.as_mut() {
                    screen.sel = if key.code == KeyCode::Up {
                        (screen.sel + n - 1) % n
                    } else {
                        (screen.sel + 1) % n
                    };
                }
                return Vec::new();
            }
            _ => {}
        }
        if is_ctrl(key, 'e') {
            let Some(q) = self.ground_current() else {
                return Vec::new();
            };
            return vec![Effect::Editor {
                file: q.item.file.clone().into(),
                line: q.item.line,
                then: AfterEditor::Foundation,
            }];
        }
        if is_ctrl(key, 'd') {
            return self.dismiss(ports);
        }
        let own = self.ground_rows().len() - 1;
        if let Some(screen) = self.foundation.as_mut() {
            if let Some(next) = edit_line(&screen.draft, key) {
                screen.draft = next;
                screen.error = None;
                // Typing is choosing to write your own.
                screen.sel = own;
            }
        }
        Vec::new()
    }

    /// A click on the ground-rules screen.
    pub(super) fn foundation_click(&mut self, ports: &dyn Ports, target: Target) -> Vec<Effect> {
        let Some(screen) = self.foundation.as_mut() else {
            return Vec::new();
        };
        let mut effects = match target {
            Target::GroundButton if screen.intro => {
                screen.intro = false;
                Vec::new()
            }
            Target::GroundButton if screen.done => return self.leave_foundation(ports),
            Target::GroundRow(i) if screen.waiting.is_none() && screen.helping.is_none() => {
                match self.ground_rows().get(i).cloned() {
                    Some(Row::Choice { option, .. }) => self.save(ports, &option.label),
                    Some(Row::Help) => self.help(ports),
                    Some(Row::Own) => {
                        if let Some(screen) = self.foundation.as_mut() {
                            screen.sel = i;
                        }
                        Vec::new()
                    }
                    None => Vec::new(),
                }
            }
            _ => Vec::new(),
        };
        if self.screen == Screen::Foundation {
            effects.extend(self.ground_sync(ports));
        }
        effects
    }
}

// --- drawing -----------------------------------------------------------------

fn styled(text: impl Into<String>, color: Color) -> Line<'static> {
    Line::from(Span::styled(text.into(), Style::default().fg(color)))
}

/// One piece of the question panel, top to bottom.
enum Piece {
    Line(Line<'static>),
    /// A line of choice row `i`, clickable.
    Row(usize, Line<'static>),
    /// The bordered answer box.
    Input {
        lines: Vec<Line<'static>>,
        focused: bool,
    },
    /// A spinner and its label.
    Spinner(String),
}

impl Piece {
    fn height(&self) -> u16 {
        match self {
            Piece::Input { lines, .. } => u16::try_from(lines.len()).unwrap_or(1) + 2,
            _ => 1,
        }
    }
}

/// A choice row's line, padded to `width` on its background.
fn row_line(spans: Vec<Span<'static>>, width: usize, selected: bool) -> Line<'static> {
    let bg = if selected {
        theme::HIGHLIGHT
    } else {
        theme::PANEL
    };
    let used: usize = spans.iter().map(Span::width).sum();
    let mut spans: Vec<Span<'static>> = spans
        .into_iter()
        .map(|s| {
            let style = s.style.bg(bg);
            s.style(style)
        })
        .collect();
    spans.push(Span::styled(
        " ".repeat(width.saturating_sub(used)),
        Style::default().bg(bg),
    ));
    Line::from(spans)
}

/// The question panel's contents.
fn question_pieces(app: &App, width: usize, term_width: usize) -> Vec<Piece> {
    let (Some(screen), Some(q)) = (app.foundation.as_ref(), app.ground_current()) else {
        return Vec::new();
    };
    let meta = app.ground_meta();
    let mut out = vec![Piece::Line(Line::default())];
    out.push(Piece::Line(Line::from(Span::styled(
        q.item.name.clone(),
        Style::default()
            .fg(theme::ACCENT)
            .add_modifier(Modifier::BOLD),
    ))));
    if let Some(parent) = &meta.parent {
        let why = meta
            .why
            .as_deref()
            .filter(|w| !w.is_empty())
            .map(|w| format!(" — {w}"))
            .unwrap_or_default();
        out.push(Piece::Line(styled(
            format!("✦ follow-up to “{parent}”{why}"),
            theme::ACCENT2,
        )));
    }
    if let Some(helps) = &meta.helps {
        out.push(Piece::Line(styled(
            format!("✦ a simpler question, to help decide “{helps}”"),
            theme::ACCENT2,
        )));
    }
    if meta.parent.is_none() && meta.helps.is_none() && !q.hint.is_empty() {
        for line in wrap(&q.hint, width.min(90)) {
            out.push(Piece::Line(styled(line, theme::DIM)));
        }
    }
    if let Some(explain) = meta.explain.as_deref().filter(|e| !e.is_empty()) {
        out.push(Piece::Line(Line::default()));
        for line in wrap(&format!("💡 {explain}"), width.min(100)) {
            out.push(Piece::Line(styled(line, theme::TEXT)));
        }
    }
    out.push(Piece::Line(Line::default()));

    if q.answered {
        let first = wrap(&q.item.text, 70)
            .into_iter()
            .next()
            .unwrap_or_default();
        out.push(Piece::Line(Line::from(vec![
            Span::styled("✓ Current answer: ", Style::default().fg(theme::OK)),
            Span::styled(first, Style::default().fg(theme::TEXT)),
        ])));
        out.push(Piece::Line(Line::default()));
    }

    // After an answer: looking at it before moving on.
    if let Some(waiting) = &screen.waiting {
        out.push(Piece::Line(Line::from(vec![
            Span::styled("✓ Saved: ", Style::default().fg(theme::OK)),
            Span::styled(clip(&waiting.answer, 80), Style::default().fg(theme::TEXT)),
        ])));
        out.push(Piece::Line(Line::default()));
        out.push(Piece::Spinner(LOOKING.to_owned()));
        out.push(Piece::Line(styled(
            "  enter continues without waiting",
            theme::DIM,
        )));
        return out;
    }
    if screen.helping.is_some() {
        out.push(Piece::Spinner(HELPING.to_owned()));
        out.push(Piece::Line(Line::default()));
    }

    // The choices — one line each, so the list reads as a menu.
    let rows = app.ground_rows();
    let options = meta.options.unwrap_or_default();
    let longest = options
        .iter()
        .map(|o| o.label.chars().count())
        .max()
        .unwrap_or(0);
    let label_width = (longest.max(12) + 2).min(term_width / 2).max(2);
    let has_choices = rows.iter().any(|r| matches!(r, Row::Choice { .. }));
    let clip_to = term_width.saturating_sub(12).max(20);
    for (i, row) in rows.iter().enumerate() {
        let selected = screen.sel == i;
        let arrow = Span::styled(
            if selected { " ▸ " } else { "   " },
            Style::default().fg(theme::ACCENT),
        );
        let fg = |otherwise: Color| if selected { theme::ACCENT } else { otherwise };
        match row {
            Row::Choice {
                option,
                derived: Some(reason),
            } => {
                // A derived answer is usually a sentence: its own full line,
                // the reason below.
                out.push(Piece::Row(
                    i,
                    row_line(
                        vec![
                            arrow,
                            Span::styled(
                                format!("⇐ {}", clip(&option.label, clip_to)),
                                Style::default().fg(fg(theme::TEXT)),
                            ),
                        ],
                        width,
                        selected,
                    ),
                ));
                out.push(Piece::Row(
                    i,
                    row_line(
                        vec![
                            Span::raw("   "),
                            Span::styled(
                                format!(
                                    "  {}",
                                    clip(&format!("from your earlier answers: {reason}"), clip_to)
                                ),
                                Style::default().fg(theme::ACCENT2),
                            ),
                        ],
                        width,
                        selected,
                    ),
                ));
            }
            Row::Choice {
                option,
                derived: None,
            } => {
                let label = clip(&option.label, label_width - 1);
                let pad = label_width.saturating_sub(label.chars().count());
                out.push(Piece::Row(
                    i,
                    row_line(
                        vec![
                            arrow,
                            Span::styled(
                                format!("{label}{}", " ".repeat(pad)),
                                Style::default().fg(fg(theme::TEXT)),
                            ),
                            Span::styled(
                                if option.recommended { "★  " } else { "   " },
                                Style::default().fg(theme::WARN),
                            ),
                            Span::styled(
                                clip(
                                    &option.detail,
                                    term_width.saturating_sub(label_width + 14).max(20),
                                ),
                                Style::default().fg(theme::DIM),
                            ),
                        ],
                        width,
                        selected,
                    ),
                ));
            }
            Row::Help => out.push(Piece::Row(
                i,
                row_line(
                    vec![
                        arrow,
                        Span::styled(
                            "? I'm not sure — explain it, show examples, ask me simpler questions",
                            Style::default().fg(fg(theme::ACCENT2)),
                        ),
                    ],
                    width,
                    selected,
                ),
            )),
            Row::Own => out.push(Piece::Row(
                i,
                row_line(
                    vec![
                        arrow,
                        Span::styled(
                            if has_choices {
                                "✎ Write my own answer"
                            } else {
                                "✎ Write my answer"
                            },
                            Style::default().fg(fg(theme::TEXT)),
                        ),
                    ],
                    width,
                    selected,
                ),
            )),
        }
    }
    if app.ground_thinking_here() && !has_choices {
        out.push(Piece::Spinner("looking for options…".to_owned()));
    }
    if has_choices {
        let legend = if rows.iter().any(|r| {
            matches!(
                r,
                Row::Choice {
                    derived: Some(_),
                    ..
                }
            )
        }) {
            "   ⇐ derived from earlier answers · ★ recommended · ↑↓ or click to choose"
        } else {
            "   ★ recommended · ↑↓ or click to choose"
        };
        out.push(Piece::Line(styled(legend, theme::DIM)));
    }
    out.push(Piece::Line(Line::default()));

    // Your own answer.
    let own = rows.len() - 1;
    let lines = if screen.draft.is_empty() {
        vec![styled(
            if screen.sel == own {
                "› ▏type your answer — or \"skip\", or \"?\" if you are not sure"
            } else {
                "› or type your own answer…"
            },
            theme::DIM,
        )]
    } else {
        wrap(
            &format!("{}▏", screen.draft),
            width.saturating_sub(4).clamp(1, 88),
        )
        .into_iter()
        .enumerate()
        .map(|(i, line)| {
            styled(
                format!("{}{line}", if i == 0 { "› " } else { "  " }),
                theme::TEXT,
            )
        })
        .collect()
    };
    out.push(Piece::Input {
        lines,
        focused: screen.sel == own,
    });
    if let Some(error) = &screen.error {
        for line in wrap(error, width.max(1)) {
            out.push(Piece::Line(styled(line, theme::WARN)));
        }
    }
    out
}

/// A panel of `lines` and one focused button, centred in `area` — the intro
/// and the done panel.
fn render_centred(
    frame: &mut Frame<'_>,
    area: Rect,
    width: u16,
    lines: &[(String, Color)],
    button: &str,
    hits: &mut Hits,
) {
    let width = width.min(area.width);
    let inner_width = usize::from(width.saturating_sub(4)).max(1);
    let wrapped: Vec<Line<'static>> = lines
        .iter()
        .flat_map(|(text, color)| {
            // Wrapped only when too wide: wrapping collapses the spaces that
            // line the intro's table up.
            let lines = if text.chars().count() <= inner_width {
                vec![text.clone()]
            } else {
                wrap(text, inner_width)
            };
            lines
                .into_iter()
                .map(|l| styled(l, *color))
                .collect::<Vec<_>>()
        })
        .collect();
    let content = u16::try_from(wrapped.len()).unwrap_or(u16::MAX);
    let height = (content + BUTTON_HEIGHT + 2).min(area.height);
    let rect = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(panel(Some("Ground rules"), false), rect);
    let inner = panel_inner(rect);
    // In a terminal too short for all of it, the text gives way: the button
    // is the one thing on this panel you need.
    let text_rows = inner.height.saturating_sub(BUTTON_HEIGHT);
    let mut flow = Flow::new(Rect {
        height: text_rows,
        ..inner
    });
    for line in wrapped {
        flow.line(frame, line);
    }
    let mut flow = Flow::new(Rect {
        y: inner.y + text_rows.min(content),
        height: inner.height - text_rows.min(content),
        ..inner
    });
    let rects = flow.buttons(frame, &[Button::new(button, true)], Some(0));
    if let Some(Some(at)) = rects.first() {
        hits.push((*at, Target::GroundButton));
    }
}

fn intro_lines(app: &App) -> Vec<(String, Color)> {
    let mut lines = vec![
        (String::new(), theme::TEXT),
        (
            "Before the first change, settle the ground rules.".to_owned(),
            theme::ACCENT,
        ),
        (String::new(), theme::TEXT),
    ];
    lines.extend(INTRO.iter().map(|l| ((*l).to_owned(), theme::TEXT)));
    lines.push((String::new(), theme::TEXT));
    match &app.ground.note {
        Some(note) => lines.push((format!("AI suggestions are off: {note}."), theme::DIM)),
        None => {
            lines.push((
                "✦ An AI assistant digs deeper where an answer leaves something open,".to_owned(),
                theme::ACCENT2,
            ));
            lines.push((
                "  and proposes options with a recommendation. You always choose.".to_owned(),
                theme::ACCENT2,
            ));
        }
    }
    lines.push((String::new(), theme::TEXT));
    lines
}

fn done_lines(total: usize) -> Vec<(String, Color)> {
    vec![
        (String::new(), theme::TEXT),
        (
            format!("✓ All {total} ground rules are answered."),
            theme::OK,
        ),
        (String::new(), theme::TEXT),
        (
            "They live in spec-tacular/foundation/ and go into every agent's context.".to_owned(),
            theme::TEXT,
        ),
        (
            "Change one any time with f from the overview, or by editing the file.".to_owned(),
            theme::TEXT,
        ),
        (String::new(), theme::TEXT),
    ]
}

/// Per section: one dot per question, so progress reads at a glance.
fn progress_line(app: &App) -> Line<'static> {
    let current = app.ground_current().map(|q| q.item.id.clone());
    let mut sections: Vec<(String, Vec<(bool, bool)>)> = Vec::new();
    for q in &app.ground.questions {
        let dot = (q.answered, Some(&q.item.id) == current.as_ref());
        match sections.iter_mut().find(|(title, _)| *title == q.title) {
            Some((_, dots)) => dots.push(dot),
            None => sections.push((q.title.clone(), vec![dot])),
        }
    }
    let mut spans = Vec::new();
    for (title, dots) in sections {
        let here = dots.iter().any(|(_, current)| *current);
        spans.push(Span::styled(
            format!("{title} "),
            Style::default().fg(if here { theme::ACCENT } else { theme::TEXT }),
        ));
        for (answered, current) in dots {
            let (mark, color) = if current {
                ("◆", theme::ACCENT)
            } else if answered {
                ("●", theme::OK)
            } else {
                ("○", theme::DIM)
            };
            spans.push(Span::styled(mark, Style::default().fg(color)));
        }
        spans.push(Span::raw("   "));
    }
    Line::from(spans)
}

/// The line above the key bar: what the advisor is doing.
fn status_line(app: &App) -> Line<'static> {
    if let Some(last) = app.ground.thinking.last() {
        return spinner_line(
            app.tick,
            &format!("AI is thinking about “{last}”…"),
            theme::ACCENT2,
        );
    }
    match (&app.ground.notice, &app.ground.note) {
        (Some(notice), _) => styled(notice.clone(), theme::ACCENT2),
        (None, Some(note)) => styled(format!("AI suggestions off: {note}"), theme::DIM),
        (None, None) => Line::default(),
    }
}

/// Draws the ground rules into `area`, below the header.
pub fn render_foundation(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    let Some(screen) = app.foundation.as_ref() else {
        return;
    };
    let keys = app.ground_keys();
    let bar = Rect::new(
        area.x + 1,
        area.y + area.height.saturating_sub(1),
        area.width.saturating_sub(2),
        area.height.min(1),
    );
    render_key_bar(frame, bar, &keys, None);
    let rest = Rect {
        height: area.height.saturating_sub(1),
        ..area
    };

    if screen.intro {
        let label = format!("▶ Begin — {} questions", app.ground.questions.len());
        render_centred(frame, rest, 82, &intro_lines(app), &label, hits);
        return;
    }
    if screen.done {
        let lines = done_lines(app.ground.questions.len());
        render_centred(
            frame,
            rest,
            72,
            &lines,
            "▶ Continue to your first change",
            hits,
        );
        return;
    }
    let Some(q) = app.ground_current() else {
        return;
    };

    // What the advisor is doing, just above the keys.
    let status = Rect::new(
        rest.x + 1,
        rest.y + rest.height.saturating_sub(1),
        rest.width.saturating_sub(2),
        rest.height.min(1),
    );
    frame.render_widget(Paragraph::new(status_line(app)), status);
    let mut room = Rect {
        height: rest.height.saturating_sub(1),
        ..rest
    };

    // Progress, per section.
    let progress = Rect {
        height: 3.min(room.height),
        ..room
    };
    frame.render_widget(panel(Some("Ground rules"), false), progress);
    let inner = panel_inner(progress);
    frame.render_widget(Paragraph::new(progress_line(app)), inner);
    let answered = app.ground.questions.iter().filter(|q| q.answered).count();
    frame.render_widget(
        Paragraph::new(styled(
            format!("{answered}/{}", app.ground.questions.len()),
            theme::DIM,
        ))
        .alignment(Alignment::Right),
        inner,
    );
    room.y += progress.height;
    room.height -= progress.height;

    // The question.
    let width = usize::from(room.width.saturating_sub(4)).max(1);
    let pieces = question_pieces(app, width, usize::from(frame.area().width));
    let content: u16 = pieces.iter().map(Piece::height).sum();
    let title = if q.purpose.is_empty() {
        q.title.clone()
    } else {
        format!("{} · {}", q.title, q.purpose)
    };
    let rect = Rect {
        height: (content + 2).min(room.height),
        ..room
    };
    frame.render_widget(panel(Some(&title), true), rect);
    let mut flow = Flow::new(panel_inner(rect));
    for piece in pieces {
        match piece {
            Piece::Line(line) => flow.line(frame, line),
            Piece::Row(i, line) => {
                let y = flow.y;
                flow.line(frame, line);
                if y < flow.area.y + flow.area.height {
                    hits.push((
                        Rect::new(flow.area.x, y, flow.area.width, 1),
                        Target::GroundRow(i),
                    ));
                }
            }
            Piece::Spinner(label) => {
                flow.line(frame, spinner_line(app.tick, &label, theme::ACCENT2));
            }
            Piece::Input { lines, focused } => {
                let height = u16::try_from(lines.len()).unwrap_or(1) + 2;
                let at = flow.take(height);
                frame.render_widget(
                    Paragraph::new(lines).block(
                        Block::bordered()
                            .border_type(BorderType::Rounded)
                            .border_style(Style::default().fg(if focused {
                                theme::ACCENT
                            } else {
                                theme::BORDER
                            }))
                            .padding(Padding::horizontal(1)),
                    ),
                    at,
                );
            }
        }
    }
}
