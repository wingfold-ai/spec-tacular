//! The vision screen: a new project's way in.
//!
//! The TypeScript `vision.tsx`, and the vision half of its `app.tsx`.
//! "What do you want to change?" is the wrong first question when nothing
//! exists yet ([`crate::core::vision`]). Here the developer describes what
//! they want to build, in their own words and at any length — pasting is the
//! natural way to hand over a longer text; an interview sharpens it one
//! question at a time until they stop it or the model has enough; then it is
//! split into slices they review before anything is written.
//!
//! Two kinds of state, as with the ground rules. [`VisionState`] is the
//! app's — the saved session, what the model is doing, the last failure — and
//! outlives the screen, because an answer keeps arriving after you leave.
//! [`VisionScreen`] is the screen's own — the draft, the selection, the
//! slices dropped — and goes when you leave it.
//!
//! Every model request runs off the loop's thread and comes back as
//! [`Msg::Vision`]; each carries a request number, and an answer older than
//! the newest request is dropped.

use std::collections::BTreeSet;

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Paragraph};
use ratatui::Frame;

use super::app::{spawn, App, Effect, Hits, Msg, Screen, Target};
use super::input::{edit_line, is_cancel, is_ctrl, is_enter};
use super::ports::{Ports, VisionAnswer, VisionStep};
use super::theme;
use super::widgets::{buttons_height, clip, panel, render_key_bar, spinner_line, Button, Flow};
use crate::core::advisor::AdviceOption;
use crate::core::roadmap::Slice;
use crate::core::vision::{slice_description, InterviewQuestion, ProposedSlice, VisionSession};
use crate::render::requirement::wrap;

/// Typed instead of an answer, these end the interview.
const DONE_WORDS: [&str; 6] = [
    "done",
    "enough",
    "that's it",
    "thats it",
    "finish",
    "no more",
];
/// Typed instead of an answer, these skip the question.
const SKIP_WORDS: [&str; 7] = [
    "skip",
    "pass",
    "later",
    "don't know",
    "dont know",
    "idk",
    "not sure",
];

const DESCRIBE_PLACEHOLDER: &str =
    "e.g. A booking tool for small clinics: receptionists see free rooms and book them for patients…";
const ANSWER_PLACEHOLDER: &str =
    "type your answer — \"skip\" if you do not know, \"done\" when that is enough";
const TOO_SHORT: &str = "Say a little more — a few sentences about what you want to build";
const PICK_OR_TYPE: &str =
    "Pick an option or type an answer — tab skips it, \"done\" ends the questions";
const KEEP_ONE: &str = "Keep at least one slice";
const NO_FIRST: &str = "No slice can start first — one must not depend on another";
const SLICING: &str =
    "Splitting your vision into slices — the first is the smallest thing a user can do end to end…";

/// The app's side of the vision, kept across visits.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VisionState {
    /// The interview as last saved.
    pub session: Option<VisionSession>,
    /// What the model is doing, while it is doing it.
    pub busy: Option<String>,
    /// Why the last request failed.
    pub error: Option<String>,
    /// Why there is no interview; `None` when there is a model to run one.
    pub note: Option<String>,
}

/// Where the interview is, from the saved session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Nothing described yet.
    Describe,
    /// A question is waiting for an answer.
    Interview,
    /// The slices are waiting to be reviewed.
    Review,
    /// Waiting on nothing: the last request failed, or was cut off.
    Working,
}

/// The screen's own state; dropped when it is left.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VisionScreen {
    pub draft: String,
    /// Index into [`App::vision_rows`].
    pub sel: usize,
    /// The question the selection was last chosen for.
    sel_for: Option<String>,
    /// Slices the developer dropped from the proposal, by id.
    pub dropped: BTreeSet<String>,
    pub slice_sel: usize,
    /// A transient line under the input: why enter did nothing.
    pub hint: Option<String>,
}

/// A row in the interview's choice list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Option(AdviceOption),
    /// Write your own answer.
    Own,
}

/// The screen's buttons, for a click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisionButton {
    Continue,
    NotNew,
    Enough,
    Create,
}

/// Which request a [`Msg::Vision`] answers: what happens next depends on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    /// A step of the interview, or the slicing.
    Interview,
    /// Not a new project.
    Skip,
    /// No model: the description kept as the vision.
    Keep,
}

impl VisionStep {
    fn kind(&self) -> StepKind {
        match self {
            VisionStep::Skip => StepKind::Skip,
            VisionStep::Keep(_) => StepKind::Keep,
            _ => StepKind::Interview,
        }
    }

    fn busy(&self) -> Option<&'static str> {
        Some(match self {
            VisionStep::Start(_) => "Reading your vision — working out what to ask…",
            VisionStep::Answer(None) => "Skipped — finding the next question…",
            VisionStep::Answer(Some(_)) => "Thinking about your answer…",
            VisionStep::Finish => "Wrapping up…",
            VisionStep::Resume => "Trying again…",
            VisionStep::Extract(_) => SLICING,
            VisionStep::Skip | VisionStep::Keep(_) => return None,
        })
    }
}

/// `text` as a word the screen reacts to: lowercased, trailing `.`/`!` gone.
fn as_word(text: &str) -> String {
    text.to_lowercase().trim_end_matches(['.', '!']).to_owned()
}

impl App {
    // --- derived --------------------------------------------------------

    pub fn vision_phase(&self) -> Phase {
        match &self.vision.session {
            None => Phase::Describe,
            Some(s) if s.vision.is_empty() => Phase::Describe,
            Some(s) if !s.slices.is_empty() => Phase::Review,
            Some(s) if s.pending.is_some() => Phase::Interview,
            Some(_) => Phase::Working,
        }
    }

    fn vision_question(&self) -> Option<&InterviewQuestion> {
        self.vision.session.as_ref()?.pending.as_ref()
    }

    /// The options, then writing your own.
    pub fn vision_rows(&self) -> Vec<Row> {
        let mut rows: Vec<Row> = self
            .vision_question()
            .map(|q| q.options.iter().cloned().map(Row::Option).collect())
            .unwrap_or_default();
        rows.push(Row::Own);
        rows
    }

    /// The slices the developer is keeping.
    pub fn vision_kept(&self) -> Vec<ProposedSlice> {
        let dropped = self
            .vision_screen
            .as_ref()
            .map(|s| s.dropped.clone())
            .unwrap_or_default();
        self.vision
            .session
            .as_ref()
            .map(|s| {
                s.slices
                    .iter()
                    .filter(|x| !dropped.contains(&x.id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The key bar under the vision.
    pub fn vision_keys(&self) -> Vec<(&'static str, &'static str)> {
        if self.vision.busy.is_some() {
            return vec![("ctrl+c", "back")];
        }
        match self.vision_phase() {
            Phase::Describe => vec![
                ("enter", "continue"),
                ("ctrl+n", "not a new project"),
                ("ctrl+c", "back"),
            ],
            Phase::Interview => vec![
                ("↑↓", "choose"),
                ("enter", "answer"),
                ("tab", "skip question"),
                ("ctrl+d", "that's enough — make slices"),
                ("ctrl+c", "back"),
            ],
            Phase::Review => vec![
                ("↑↓", "move"),
                ("space", "keep / drop"),
                ("enter", "create the roadmap"),
                ("ctrl+c", "back"),
            ],
            Phase::Working => vec![("enter", "ask again"), ("ctrl+c", "back")],
        }
    }

    /// The vision screen's spinner moves.
    pub fn vision_animating(&self) -> bool {
        self.screen == Screen::Vision && self.vision.busy.is_some()
    }

    // --- opening and leaving --------------------------------------------

    /// "Describe your vision", "Continue your vision", or leaving the ground
    /// rules of a new project.
    pub(super) fn open_vision(&mut self) {
        self.notice = None;
        self.vision_screen = Some(VisionScreen::default());
        self.screen = Screen::Vision;
        self.vision_sync();
    }

    /// Back to the start screen. A request still running keeps running; its
    /// answer is saved when it lands, and shown when the screen is opened
    /// again.
    fn leave_vision(&mut self) {
        self.vision_screen = None;
        self.enter_home();
    }

    /// When a new question comes on screen: an empty answer box, and the
    /// selection on its recommendation — the TypeScript's effect on the
    /// question's text.
    fn vision_sync(&mut self) {
        let ask = self.vision_question().map(|q| q.ask.clone());
        let rows = self.vision_rows();
        let Some(screen) = self.vision_screen.as_mut() else {
            return;
        };
        if screen.sel_for == ask {
            return;
        }
        screen.sel_for = ask;
        screen.draft.clear();
        screen.sel = rows
            .iter()
            .position(|r| matches!(r, Row::Option(o) if o.recommended))
            .unwrap_or(rows.len() - 1);
    }

    // --- requests ---------------------------------------------------------

    /// Starts one step of the interview; its answer comes back as
    /// [`Msg::Vision`].
    fn vision_request(&mut self, ports: &dyn Ports, step: VisionStep) -> Vec<Effect> {
        let generation = self.latest.issue();
        self.latest.vision = generation;
        self.vision.busy = step.busy().map(str::to_owned);
        self.vision.error = None;
        let kind = step.kind();
        vec![spawn(ports.vision(step), move |answer| Msg::Vision {
            generation,
            kind,
            answer,
        })]
    }

    /// A step came back. Once the interview has enough — the model says so,
    /// or the developer does — the vision is split into slices straight away.
    pub(super) fn vision_answered(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        kind: StepKind,
        answer: VisionAnswer,
    ) -> Vec<Effect> {
        if generation < self.latest.vision {
            return Vec::new();
        }
        self.vision.busy = None;
        // What is saved is what is on screen, whether the step worked or not.
        if answer.session.is_some() {
            self.vision.session = answer.session;
        }
        let ok = answer.error.is_none();
        if let Some(reason) = answer.error {
            self.vision.error = Some(match kind {
                StepKind::Interview => format!("The AI could not continue: {reason}"),
                StepKind::Skip | StepKind::Keep => reason,
            });
        }
        let here = self.screen == Screen::Vision;
        match kind {
            StepKind::Skip | StepKind::Keep => {
                self.refresh_project(ports);
                if ok && here {
                    self.vision_screen = None;
                    self.screen = Screen::Overview;
                    self.start_new_change();
                    if kind == StepKind::Keep {
                        self.notice =
                            Some("Your vision is saved to spec-tacular/vision.md".to_owned());
                    }
                }
                Vec::new()
            }
            StepKind::Interview => {
                self.vision_sync();
                let ready = self
                    .vision
                    .session
                    .as_ref()
                    .is_some_and(|s| s.finished && s.slices.is_empty());
                if ready && ok && here && self.vision.note.is_none() {
                    let taken = self.taken();
                    return self.vision_request(ports, VisionStep::Extract(taken));
                }
                Vec::new()
            }
        }
    }

    /// Enter on the description.
    fn vision_describe(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let Some(screen) = self.vision_screen.as_mut() else {
            return Vec::new();
        };
        let text = screen.draft.trim().to_owned();
        if text.chars().count() < 10 {
            screen.hint = Some(TOO_SHORT.to_owned());
            return Vec::new();
        }
        screen.hint = None;
        // No interview without a model: keep the vision, start a change.
        if self.vision.note.is_some() {
            return self.vision_request(ports, VisionStep::Keep(text));
        }
        self.vision_request(ports, VisionStep::Start(text))
    }

    fn vision_answer(&mut self, ports: &dyn Ports, answer: Option<String>) -> Vec<Effect> {
        if let Some(screen) = self.vision_screen.as_mut() {
            screen.hint = None;
        }
        self.vision_request(ports, VisionStep::Answer(answer))
    }

    fn vision_finish(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        self.vision_request(ports, VisionStep::Finish)
    }

    /// Enter on an answer: a done or skip word, what was typed, or the
    /// selected option.
    fn vision_submit(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let rows = self.vision_rows();
        let Some(screen) = self.vision_screen.as_mut() else {
            return Vec::new();
        };
        let text = screen.draft.trim().to_owned();
        let word = as_word(&text);
        if DONE_WORDS.contains(&word.as_str()) {
            return self.vision_finish(ports);
        }
        if SKIP_WORDS.contains(&word.as_str()) {
            return self.vision_answer(ports, None);
        }
        if !text.is_empty() {
            return self.vision_answer(ports, Some(text));
        }
        if let Some(Row::Option(option)) = rows.get(screen.sel) {
            let label = option.label.clone();
            return self.vision_answer(ports, Some(label));
        }
        screen.hint = Some(PICK_OR_TYPE.to_owned());
        Vec::new()
    }

    /// Not a new project: go straight to a single change.
    fn vision_not_new(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        self.vision_request(ports, VisionStep::Skip)
    }

    /// Enter on the slices: write the vision and the roadmap.
    fn vision_confirm(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let kept = self.vision_kept();
        if kept.is_empty() {
            if let Some(screen) = self.vision_screen.as_mut() {
                screen.hint = Some(KEEP_ONE.to_owned());
            }
            return Vec::new();
        }
        let vision = self
            .vision
            .session
            .as_ref()
            .map(|s| {
                [s.refined.as_deref().unwrap_or(""), &s.understood, &s.vision]
                    .into_iter()
                    .find(|t| !t.is_empty())
                    .unwrap_or("")
                    .to_owned()
            })
            .unwrap_or_default();
        let generation = self.latest.issue();
        self.latest.vision = generation;
        self.vision.busy = Some("Writing the roadmap…".to_owned());
        self.vision.error = None;
        vec![spawn(ports.confirm_vision(&vision, &kept), move |result| {
            Msg::VisionConfirmed {
                generation,
                kept,
                result,
            }
        })]
    }

    /// The roadmap is written; now the first slice's change.
    pub(super) fn vision_confirmed(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        kept: Vec<ProposedSlice>,
        result: Result<Option<Slice>, String>,
    ) -> Vec<Effect> {
        if generation < self.latest.vision {
            return Vec::new();
        }
        let first = match result {
            Ok(first) => first,
            Err(reason) => {
                self.vision.busy = None;
                self.vision.error = Some(reason);
                return Vec::new();
            }
        };
        let proposed = first
            .as_ref()
            .and_then(|f| kept.iter().find(|k| k.id == f.id))
            .cloned();
        let Some(proposed) = proposed else {
            self.vision.busy = None;
            self.vision.error = Some(NO_FIRST.to_owned());
            return Vec::new();
        };
        self.vision.busy = Some(format!("Creating {}…", proposed.id));
        let name = proposed.id.clone();
        let notice = format!(
            "Roadmap saved: {} slices. First up: {}.",
            kept.len(),
            proposed.title
        );
        vec![spawn(
            ports.create_change(&proposed.id, &slice_description(&proposed)),
            move |result| Msg::VisionCreated {
                generation,
                name,
                notice,
                result,
            },
        )]
    }

    /// The first slice's change exists: on to the overview, with it selected.
    pub(super) fn vision_created(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        name: String,
        notice: String,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        if generation < self.latest.vision {
            return Vec::new();
        }
        self.vision.busy = None;
        if let Err(reason) = result {
            self.vision.error = Some(reason);
            return Vec::new();
        }
        self.refresh_project(ports);
        if self.screen == Screen::Vision {
            self.vision_screen = None;
            self.screen = Screen::Overview;
        }
        vec![self.reload(ports, Some(name), Some(notice), None)]
    }

    // --- keys, clicks and pastes ------------------------------------------

    pub(super) fn vision_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        if self.vision_screen.is_none() {
            self.vision_screen = Some(VisionScreen::default());
        }
        if is_cancel(key) {
            self.leave_vision();
            return Vec::new();
        }
        if self.vision.busy.is_some() {
            return Vec::new();
        }
        let phase = self.vision_phase();
        match phase {
            Phase::Review => return self.review_slices_key(ports, key),
            Phase::Working => {
                if is_enter(key) {
                    return self.vision_request(ports, VisionStep::Resume);
                }
                return Vec::new();
            }
            Phase::Describe => {
                if is_ctrl(key, 'n') {
                    return self.vision_not_new(ports);
                }
                if is_enter(key) {
                    return self.vision_describe(ports);
                }
            }
            Phase::Interview => {
                if is_ctrl(key, 'd') {
                    return self.vision_finish(ports);
                }
                if key.code == KeyCode::Tab {
                    return self.vision_answer(ports, None);
                }
                if is_enter(key) {
                    return self.vision_submit(ports);
                }
                if matches!(key.code, KeyCode::Up | KeyCode::Down) {
                    let n = self.vision_rows().len();
                    if let Some(screen) = self.vision_screen.as_mut() {
                        screen.sel = if key.code == KeyCode::Up {
                            (screen.sel + n - 1) % n
                        } else {
                            (screen.sel + 1) % n
                        };
                    }
                    return Vec::new();
                }
            }
        }
        let own = self.vision_rows().len() - 1;
        if let Some(screen) = self.vision_screen.as_mut() {
            if let Some(next) = edit_line(&screen.draft, key) {
                screen.draft = next;
                screen.hint = None;
                // Typing is choosing to write your own.
                if phase == Phase::Interview {
                    screen.sel = own;
                }
            }
        }
        Vec::new()
    }

    fn review_slices_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        let slices: Vec<String> = self
            .vision
            .session
            .as_ref()
            .map(|s| s.slices.iter().map(|x| x.id.clone()).collect())
            .unwrap_or_default();
        let n = slices.len().max(1);
        let Some(screen) = self.vision_screen.as_mut() else {
            return Vec::new();
        };
        let plain = |c: char| key.code == KeyCode::Char(c) && !is_ctrl(key, c);
        if key.code == KeyCode::Up || plain('k') {
            screen.slice_sel = (screen.slice_sel + n - 1) % n;
        } else if key.code == KeyCode::Down || plain('j') {
            screen.slice_sel = (screen.slice_sel + 1) % n;
        } else if plain(' ') || plain('x') {
            if let Some(id) = slices.get(screen.slice_sel) {
                if !screen.dropped.remove(id) {
                    screen.dropped.insert(id.clone());
                }
                screen.hint = None;
            }
        } else if is_enter(key) {
            return self.vision_confirm(ports);
        }
        Vec::new()
    }

    /// Pasted text: appended to the draft, line breaks normalised — the
    /// natural way to hand over a vision someone already wrote down.
    pub(super) fn vision_paste(&mut self, text: &str) {
        if self.vision.busy.is_some()
            || !matches!(self.vision_phase(), Phase::Describe | Phase::Interview)
        {
            return;
        }
        let phase = self.vision_phase();
        let own = self.vision_rows().len() - 1;
        if let Some(screen) = self.vision_screen.as_mut() {
            screen
                .draft
                .push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
            screen.hint = None;
            if phase == Phase::Interview {
                screen.sel = own;
            }
        }
    }

    pub(super) fn vision_click(&mut self, ports: &dyn Ports, target: Target) -> Vec<Effect> {
        if self.vision.busy.is_some() {
            return Vec::new();
        }
        match target {
            Target::VisionButton(VisionButton::Continue) => self.vision_describe(ports),
            Target::VisionButton(VisionButton::NotNew) => self.vision_not_new(ports),
            Target::VisionButton(VisionButton::Enough) => self.vision_finish(ports),
            Target::VisionButton(VisionButton::Create) => self.vision_confirm(ports),
            Target::VisionRow(i) => match self.vision_rows().get(i).cloned() {
                Some(Row::Option(option)) => self.vision_answer(ports, Some(option.label)),
                Some(Row::Own) => {
                    if let Some(screen) = self.vision_screen.as_mut() {
                        screen.sel = i;
                    }
                    Vec::new()
                }
                None => Vec::new(),
            },
            Target::SliceRow(i) => {
                if let Some(screen) = self.vision_screen.as_mut() {
                    screen.slice_sel = i;
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

// --- drawing -----------------------------------------------------------------

fn styled(text: impl Into<String>, color: Color) -> Line<'static> {
    Line::from(Span::styled(text.into(), Style::default().fg(color)))
}

fn bold(text: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(
        text.into(),
        Style::default()
            .fg(theme::ACCENT)
            .add_modifier(Modifier::BOLD),
    ))
}

/// One piece of a panel, top to bottom.
enum Piece {
    Line(Line<'static>),
    /// A line that clicks as `target`.
    Click(Target, Line<'static>),
    /// The bordered input box.
    Input {
        lines: Vec<Line<'static>>,
        focused: bool,
    },
    /// A row of buttons, each clicking as its target.
    Buttons(Vec<(Button, Target)>, Option<usize>),
}

impl Piece {
    fn height(&self, width: u16) -> u16 {
        match self {
            Piece::Input { lines, .. } => u16::try_from(lines.len()).unwrap_or(1) + 2,
            Piece::Buttons(buttons, _) => {
                let buttons: Vec<Button> = buttons.iter().map(|(b, _)| b.clone()).collect();
                buttons_height(width, &buttons)
            }
            _ => 1,
        }
    }
}

/// A line padded to `width` on the selection's background.
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

/// The input box, shared by describing and answering: the placeholder while
/// empty, else the draft's last eight wrapped lines.
fn input(draft: &str, placeholder: &str, width: usize, focused: bool) -> Piece {
    let lines = if draft.is_empty() {
        vec![styled(
            clip(&format!("› ▏{placeholder}"), width.saturating_sub(4)),
            theme::DIM,
        )]
    } else {
        let wrapped = wrap(&format!("{draft}▏"), width.saturating_sub(6).max(1));
        let from = wrapped.len().saturating_sub(8);
        wrapped[from..]
            .iter()
            .enumerate()
            .map(|(i, line)| {
                styled(
                    format!("{}{line}", if i == 0 { "› " } else { "  " }),
                    theme::TEXT,
                )
            })
            .collect()
    };
    Piece::Input { lines, focused }
}

fn describe_pieces(app: &App, screen: &VisionScreen, width: usize) -> Vec<Piece> {
    let mut out = vec![
        Piece::Line(Line::default()),
        Piece::Line(bold("What are you building?")),
        Piece::Line(Line::default()),
    ];
    let mut text = vec![
        "This is a new project, so there is nothing to change yet — start from what you",
        "want it to be. Describe it freely: who it is for, what they will do with it, what",
        "matters most. Rough is fine; paste a longer text if you have one.",
        "",
    ];
    for line in text.drain(..) {
        for part in wrap_or_blank(line, width) {
            out.push(Piece::Line(styled(part, theme::TEXT)));
        }
    }
    match &app.vision.note {
        Some(note) => {
            let line = format!("(AI is off: {note} — your description is saved as the vision.)");
            for part in wrap_or_blank(&line, width) {
                out.push(Piece::Line(styled(part, theme::TEXT)));
            }
        }
        None => {
            for line in [
                "✦ Then an AI asks a few questions to sharpen it — skip any, or stop whenever you",
                "  like — and splits it into small slices, each becoming one change.",
            ] {
                out.push(Piece::Line(styled(clip(line, width), theme::ACCENT2)));
            }
        }
    }
    out.push(Piece::Line(Line::default()));
    out.push(input(&screen.draft, DESCRIBE_PLACEHOLDER, width, true));
    if let Some(hint) = &screen.hint {
        out.push(Piece::Line(styled(hint.clone(), theme::WARN)));
    }
    out.push(Piece::Line(Line::default()));
    out.push(Piece::Buttons(
        vec![
            (
                Button::new("▶ Continue", true),
                Target::VisionButton(VisionButton::Continue),
            ),
            (
                Button::new("Not a new project — just start a change", false),
                Target::VisionButton(VisionButton::NotNew),
            ),
        ],
        None,
    ));
    out
}

/// A fixed line, wrapped only when the panel is too narrow for it.
fn wrap_or_blank(line: &str, width: usize) -> Vec<String> {
    if line.is_empty() {
        vec![String::new()]
    } else if line.chars().count() <= width {
        vec![line.to_owned()]
    } else {
        wrap(line, width.max(1))
    }
}

fn question_pieces(app: &App, screen: &VisionScreen, width: usize) -> Vec<Piece> {
    let Some(q) = app.vision_question() else {
        return Vec::new();
    };
    let mut out = vec![Piece::Line(Line::default())];
    for line in wrap(&q.ask, width.max(1)) {
        out.push(Piece::Line(bold(line)));
    }
    if !q.why.is_empty() {
        out.push(Piece::Line(styled(clip(&q.why, width), theme::DIM)));
    }
    out.push(Piece::Line(Line::default()));
    let rows = app.vision_rows();
    for (i, row) in rows.iter().enumerate() {
        let selected = screen.sel == i;
        let arrow = Span::styled(
            if selected { " ▸ " } else { "   " },
            Style::default().fg(theme::ACCENT),
        );
        let fg = if selected { theme::ACCENT } else { theme::TEXT };
        let spans = match row {
            Row::Option(option) => {
                let label = clip(&option.label, 29);
                let pad = 30usize.saturating_sub(label.chars().count());
                vec![
                    arrow,
                    Span::styled(
                        format!("{label}{}", " ".repeat(pad)),
                        Style::default().fg(fg),
                    ),
                    Span::styled(
                        if option.recommended { "★  " } else { "   " },
                        Style::default().fg(theme::WARN),
                    ),
                    Span::styled(
                        clip(&option.detail, width.saturating_sub(40).max(20)),
                        Style::default().fg(theme::DIM),
                    ),
                ]
            }
            Row::Own => vec![
                arrow,
                Span::styled(
                    if rows.len() > 1 {
                        "✎ Write my own answer"
                    } else {
                        "✎ Write my answer"
                    },
                    Style::default().fg(fg),
                ),
            ],
        };
        out.push(Piece::Click(
            Target::VisionRow(i),
            row_line(spans, width, selected),
        ));
    }
    out.push(Piece::Line(Line::default()));
    out.push(input(
        &screen.draft,
        ANSWER_PLACEHOLDER,
        width,
        screen.sel == rows.len() - 1,
    ));
    if let Some(hint) = &screen.hint {
        out.push(Piece::Line(styled(hint.clone(), theme::WARN)));
    }
    out.push(Piece::Line(Line::default()));
    out.push(Piece::Buttons(
        vec![(
            Button::new("That's enough — make the slices", false),
            Target::VisionButton(VisionButton::Enough),
        )],
        None,
    ));
    out
}

fn review_pieces(app: &App, screen: &VisionScreen, width: usize) -> Vec<Piece> {
    let Some(session) = app.vision.session.as_ref() else {
        return Vec::new();
    };
    let mut out = vec![Piece::Line(Line::default())];
    let vision = [
        session.refined.as_deref().unwrap_or(""),
        &session.understood,
    ]
    .into_iter()
    .find(|t| !t.is_empty())
    .unwrap_or("");
    for line in wrap(vision, width.max(1)) {
        out.push(Piece::Line(styled(line, theme::TEXT)));
    }
    out.push(Piece::Line(Line::default()));
    out.push(Piece::Line(styled(
        clip(
            "Built in this order, one at a time — each becomes a change you review before the next.",
            width,
        ),
        theme::DIM,
    )));
    out.push(Piece::Line(Line::default()));
    for (i, slice) in session.slices.iter().enumerate() {
        let selected = screen.slice_sel == i;
        let dropped = screen.dropped.contains(&slice.id);
        let target = Target::SliceRow(i);
        out.push(Piece::Click(
            target,
            row_line(
                vec![
                    Span::styled(
                        if selected { " ▸ " } else { "   " },
                        Style::default().fg(theme::ACCENT),
                    ),
                    Span::styled(
                        if dropped { "[ ] " } else { "[✓] " },
                        Style::default().fg(if dropped { theme::DIM } else { theme::OK }),
                    ),
                    Span::styled(
                        format!("{}. {}", i + 1, slice.title),
                        Style::default().fg(if dropped { theme::DIM } else { theme::ACCENT }),
                    ),
                    Span::styled(format!("   {}", slice.id), Style::default().fg(theme::DIM)),
                ],
                width,
                selected,
            ),
        ));
        out.push(Piece::Click(
            target,
            row_line(
                vec![Span::styled(
                    format!("       {}", clip(&slice.summary, width.saturating_sub(8))),
                    Style::default().fg(if dropped { theme::DIM } else { theme::TEXT }),
                )],
                width,
                selected,
            ),
        ));
        if !slice.why.is_empty() {
            out.push(Piece::Click(
                target,
                row_line(
                    vec![Span::styled(
                        format!("       {}", clip(&slice.why, width.saturating_sub(8))),
                        Style::default().fg(theme::DIM),
                    )],
                    width,
                    selected,
                ),
            ));
        }
    }
    if let Some(hint) = &screen.hint {
        out.push(Piece::Line(styled(hint.clone(), theme::WARN)));
    }
    out.push(Piece::Line(Line::default()));
    let first = app
        .vision_kept()
        .first()
        .map_or_else(|| "…".to_owned(), |s| s.title.clone());
    out.push(Piece::Buttons(
        vec![(
            Button::new(
                clip(
                    &format!("▶ Create the roadmap — start with “{first}”"),
                    width.saturating_sub(6),
                ),
                false,
            ),
            Target::VisionButton(VisionButton::Create),
        )],
        Some(0),
    ));
    out
}

/// Draws `pieces` in a panel titled `title` at the top of `room`, taking the
/// rows it used off `room`.
fn render_panel(
    frame: &mut Frame<'_>,
    room: &mut Rect,
    title: &str,
    focused: bool,
    pieces: Vec<Piece>,
    hits: &mut Hits,
) {
    let inner_width = room.width.saturating_sub(4);
    let content: u16 = pieces.iter().map(|p| p.height(inner_width)).sum();
    let rect = Rect {
        height: (content + 2).min(room.height),
        ..*room
    };
    frame.render_widget(panel(Some(title), focused), rect);
    let inner = super::widgets::panel_inner(rect);
    let mut flow = Flow::new(inner);
    let bottom = inner.y.saturating_add(inner.height);
    for piece in pieces {
        match piece {
            Piece::Line(line) => flow.line(frame, line),
            Piece::Click(target, line) => {
                let y = flow.y;
                flow.line(frame, line);
                if y < bottom {
                    hits.push((Rect::new(inner.x, y, inner.width, 1), target));
                }
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
            Piece::Buttons(buttons, focus) => {
                let (buttons, targets): (Vec<Button>, Vec<Target>) = buttons.into_iter().unzip();
                let rects = flow.buttons(frame, &buttons, focus);
                for (rect, target) in rects.into_iter().zip(targets) {
                    if let Some(rect) = rect {
                        hits.push((rect, target));
                    }
                }
            }
        }
    }
    room.y = room.y.saturating_add(rect.height);
    room.height = room.height.saturating_sub(rect.height);
}

/// Draws the vision into `area`, below the header.
pub fn render_vision(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    let default = VisionScreen::default();
    let screen = app.vision_screen.as_ref().unwrap_or(&default);
    let keys = app.vision_keys();
    let bar = Rect::new(
        area.x + 1,
        area.y + area.height.saturating_sub(1),
        area.width.saturating_sub(2),
        area.height.min(1),
    );
    render_key_bar(frame, bar, &keys, None);
    let mut room = Rect {
        height: area.height.saturating_sub(1),
        ..area
    };
    let width = usize::from(room.width.saturating_sub(4)).max(1);
    let phase = app.vision_phase();
    let busy = app.vision.busy.as_deref();

    match phase {
        Phase::Describe => {
            let pieces = describe_pieces(app, screen, width);
            render_panel(frame, &mut room, "Your vision", true, pieces, hits);
        }
        Phase::Interview | Phase::Working => {
            let understood = app
                .vision
                .session
                .as_ref()
                .map(|s| s.understood.clone())
                .unwrap_or_default();
            if !understood.is_empty() {
                let pieces = wrap(&understood, width)
                    .into_iter()
                    .map(|l| Piece::Line(styled(l, theme::TEXT)))
                    .collect();
                render_panel(
                    frame,
                    &mut room,
                    "What I understood so far",
                    false,
                    pieces,
                    hits,
                );
            }
            if phase == Phase::Interview && busy.is_none() {
                let turns = app.vision.session.as_ref().map_or(0, |s| s.turns.len());
                let pieces = question_pieces(app, screen, width);
                render_panel(
                    frame,
                    &mut room,
                    &format!("Question {}", turns + 1),
                    true,
                    pieces,
                    hits,
                );
            }
        }
        Phase::Review => {
            if busy.is_none() {
                let pieces = review_pieces(app, screen, width);
                render_panel(
                    frame,
                    &mut room,
                    "Your roadmap — review the slices",
                    true,
                    pieces,
                    hits,
                );
            }
        }
    }

    let mut flow = Flow::new(Rect {
        x: room.x + 1,
        width: room.width.saturating_sub(2),
        ..room
    });
    if let Some(label) = busy {
        flow.blank();
        flow.line(frame, spinner_line(app.tick, label, theme::ACCENT2));
    }
    if let Some(error) = &app.vision.error {
        flow.wrapped(frame, error, Style::default().fg(theme::ERR));
    }
    if phase == Phase::Working && busy.is_none() {
        flow.line(frame, styled("Press enter to ask again.", theme::TEXT));
    }
}
