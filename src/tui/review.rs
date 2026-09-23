//! The review screen — one requirement at a time.
//!
//! The TypeScript `review.tsx`, and the review half of its `app.tsx`. This is
//! the screen the product exists for; everything else is navigation to get
//! here. The design rules it follows (docs/tui-design.md):
//!
//! - one decision on screen at a time;
//! - queue progress never leaves the frame;
//! - anything that drifted since you accepted it says so, loudly.
//!
//! Every decision is written to the sidecar before the next key is read, so a
//! crash mid-review loses nothing. Anything that rewrites a spec file — `e`,
//! a marked example, a promotion — re-parses the queue from disk afterwards
//! rather than patching it in memory: the text changed, so the hash changed,
//! and an accepted item has to drop back to pending exactly as any other edit
//! would make it.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::Frame;

use super::app::{spawn, AfterEditor, App, Effect, Msg, Screen};
use super::input::{edit_line, is_cancel, is_enter};
use super::ports::Ports;
use super::theme;
use super::widgets::{panel, panel_inner, Flow};
use crate::core::concreteness::{lint_requirement, Finding};
use crate::core::decisions::{Decision, DecisionScope};
use crate::core::examples::{example_values, render_examples};
use crate::core::review::{DecisionNote, ReviewState, ReviewedItem};
use crate::core::session::{current_item, decide, move_by, position, refresh, skip, ReviewSession};
use crate::render::requirement::{
    noun, render_counts, render_progress_bar, wrap, PROGRESS_BAR_WIDTH,
};

/// A decision that needs a typed reason before it is recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    Reject,
    Defer,
}

/// The review screen's own state, beside the session it walks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub session: ReviewSession,
    /// The reason being typed for a rejection or a deferral.
    pub prompt: Option<(PromptKind, String)>,
    pub help: bool,
    /// `m` was pressed: the next digit picks the finding to mark.
    pub marking: bool,
}

impl Review {
    pub fn new(session: ReviewSession) -> Self {
        Self {
            session,
            prompt: None,
            help: false,
            marking: false,
        }
    }

    pub fn current(&self) -> Option<&ReviewedItem> {
        current_item(&self.session)
    }

    /// The current item as a design decision, when it is one.
    fn decision(&self) -> Option<Decision> {
        self.current().and_then(|i| Decision::from_item(&i.item))
    }

    /// A global-scope design decision is the only promotable item.
    pub fn promotable(&self) -> bool {
        self.decision()
            .is_some_and(|d| d.scope == DecisionScope::Global)
    }
}

fn state_color(state: ReviewState) -> Color {
    match state {
        ReviewState::Accepted => theme::OK,
        ReviewState::Rejected => theme::ERR,
        ReviewState::Deferred => theme::WARN,
        ReviewState::Pending => theme::DIM,
    }
}

impl App {
    /// Concreteness findings for the current item. Only a spec requirement is
    /// linted; a design decision is supposed to be concrete. Advisory, never
    /// blocking.
    pub fn findings(&self) -> Vec<Finding> {
        self.review
            .as_ref()
            .and_then(Review::current)
            .filter(|i| i.item.is_requirement())
            .map(|i| lint_requirement(&i.item, &self.lint))
            .unwrap_or_default()
    }

    /// `r`, `enter` on "▶ Review": the selected change's queue, read off the
    /// loop's thread.
    pub(super) fn enter_review(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let Some(change) = self.selected().map(|p| p.name.clone()) else {
            return Vec::new();
        };
        let for_msg = change.clone();
        vec![spawn(ports.open_review(&change), move |session| {
            Msg::ReviewOpened {
                change: for_msg,
                session: session.map(Box::new),
            }
        })]
    }

    pub(super) fn review_opened(&mut self, change: &str, session: Option<Box<ReviewSession>>) {
        // Only where it was asked for: a queue that arrives after you moved
        // on must not pull you back into it.
        if self.screen != Screen::Overview || self.jobs_open {
            return;
        }
        match session {
            None => self.notice = Some(format!("{change} has no specs to review yet")),
            Some(session) => {
                self.notice = None;
                self.review = Some(Review::new(*session));
                self.screen = Screen::Review;
            }
        }
    }

    /// Every decision is persisted immediately — a crash must not lose a
    /// review.
    fn commit(&mut self, ports: &dyn Ports, next: ReviewSession) {
        if let Err(reason) = ports.save_session(&next) {
            self.notice = Some(reason);
        }
        if let Some(review) = self.review.as_mut() {
            review.session = next;
        }
    }

    /// Applies `step` to the session and persists what it gives.
    fn review_step(
        &mut self,
        ports: &dyn Ports,
        step: impl FnOnce(ReviewSession) -> ReviewSession,
    ) {
        if let Some(review) = self.review.as_ref() {
            let next = step(review.session.clone());
            self.commit(ports, next);
        }
    }

    /// `q`, ctrl+c: saved, and the overview re-read — it must reflect what
    /// was just decided, or the pipeline bar would keep showing a stage as
    /// unreviewed after you finished reviewing it.
    fn leave_review(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        if let Some(review) = self.review.take() {
            if let Err(reason) = ports.save_session(&review.session) {
                self.notice = Some(reason);
            }
        }
        self.screen = Screen::Overview;
        vec![self.reload(ports, None, None, None)]
    }

    pub(super) fn review_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        let findings = self.findings();
        let Some(review) = self.review.as_mut() else {
            self.screen = Screen::Overview;
            return Vec::new();
        };

        if review.marking {
            // Numbered rather than cycling: with several findings on one
            // requirement, picking the wrong one rewrites the spec.
            review.marking = false;
            let pick = match key.code {
                KeyCode::Char(c) => c.to_digit(10).map(|d| d as usize),
                _ => None,
            };
            return match pick.filter(|p| (1..=findings.len()).contains(p)) {
                Some(pick) => self.mark_example(ports, &findings[pick - 1]),
                None => Vec::new(),
            };
        }

        if let Some((kind, draft)) = review.prompt.as_mut() {
            if is_cancel(key) {
                review.prompt = None;
            } else if is_enter(key) {
                let (kind, text) = (*kind, draft.trim().to_owned());
                // An empty reason is allowed for a rejection but not for a
                // deferral: a deferred requirement leaves the change without
                // ever being verified, so the register has to record what
                // would verify it (problem-analysis §8).
                if kind == PromptKind::Defer && text.is_empty() {
                    return Vec::new();
                }
                review.prompt = None;
                let (state, note) = match kind {
                    PromptKind::Reject => (ReviewState::Rejected, DecisionNote::note(text)),
                    PromptKind::Defer => (ReviewState::Deferred, DecisionNote::defer_reason(text)),
                };
                self.review_step(ports, |s| decide(s, state, &note));
            } else if let Some(edited) = edit_line(draft, key) {
                *draft = edited;
            }
            return Vec::new();
        }

        // Help is a transient overlay: any key dismisses it rather than
        // acting, so you cannot accept a requirement you are not looking at.
        if review.help {
            review.help = false;
            return Vec::new();
        }

        if is_cancel(key) {
            return self.leave_review(ports);
        }
        if has_modifier(key) {
            return Vec::new();
        }
        let promotable = review.promotable();
        match key.code {
            KeyCode::Char('a') => {
                self.review_step(ports, |s| {
                    decide(s, ReviewState::Accepted, &DecisionNote::default())
                });
            }
            KeyCode::Char('r') => review.prompt = Some((PromptKind::Reject, String::new())),
            KeyCode::Char('d') => review.prompt = Some((PromptKind::Defer, String::new())),
            KeyCode::Char('s') => self.review_step(ports, skip),
            KeyCode::Char('e') => return self.edit_item(),
            KeyCode::Char('m') => review.marking = !findings.is_empty(),
            // `p` only promotes on a global design decision; everywhere else
            // it is "previous", which is why the two can share a key.
            KeyCode::Char('p') if promotable => return self.promote(ports),
            KeyCode::Char('p' | 'k') | KeyCode::Up => self.review_step(ports, |s| move_by(s, -1)),
            KeyCode::Char('n' | 'j') | KeyCode::Down => self.review_step(ports, |s| move_by(s, 1)),
            KeyCode::Char('q') => return self.leave_review(ports),
            KeyCode::Char('?') => review.help = true,
            _ => {}
        }
        Vec::new()
    }

    /// `e`: the item's file in `$EDITOR`, at its line; re-parsed afterwards,
    /// because the point of opening an editor is that the file changed, and
    /// an edit after acceptance must surface as drift.
    fn edit_item(&mut self) -> Vec<Effect> {
        let Some(review) = self.review.as_ref() else {
            return Vec::new();
        };
        let Some(item) = review.current() else {
            return Vec::new();
        };
        vec![Effect::Editor {
            file: item.item.file.clone().into(),
            line: item.item.line,
            then: AfterEditor::Reparse {
                change: review.session.change.clone(),
            },
        }]
    }

    fn mark_example(&mut self, ports: &dyn Ports, finding: &Finding) -> Vec<Effect> {
        let Some(review) = self.review.as_ref() else {
            return Vec::new();
        };
        let Some(item) = review.current().filter(|i| i.item.is_requirement()) else {
            return Vec::new();
        };
        let change = review.session.change.clone();
        vec![spawn(
            ports.mark_example(&item.item, &finding.value),
            move |result| Msg::Marked { change, result },
        )]
    }

    fn promote(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let Some(review) = self.review.as_ref() else {
            return Vec::new();
        };
        let Some(decision) = review.decision() else {
            return Vec::new();
        };
        let change = review.session.change.clone();
        vec![spawn(ports.promote(&change, &decision), move |result| {
            Msg::Promoted { change, result }
        })]
    }

    /// Asks for the queue again, for the review of `change` if it is still
    /// open when the answer comes.
    pub(super) fn reparse(&self, ports: &dyn Ports, change: &str) -> Effect {
        let for_msg = change.to_owned();
        spawn(ports.reparse(change), move |items| Msg::Reparsed {
            change: for_msg,
            items,
        })
    }

    pub(super) fn reparsed(
        &mut self,
        change: &str,
        items: &[crate::core::requirements::ReviewItem],
    ) {
        if let Some(review) = self.review.as_mut().filter(|r| r.session.change == change) {
            review.session = refresh(review.session.clone(), items);
        }
    }

    pub(super) fn marked(
        &mut self,
        ports: &dyn Ports,
        change: &str,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        match result {
            Ok(()) => {
                self.notice = None;
                vec![self.reparse(ports, change)]
            }
            Err(reason) => {
                self.notice = Some(reason);
                Vec::new()
            }
        }
    }

    pub(super) fn promoted(
        &mut self,
        ports: &dyn Ports,
        change: &str,
        result: Result<String, String>,
    ) -> Vec<Effect> {
        match result {
            // Re-parsed: promotion rewrites design.md, so the decision's text
            // changed and its acceptance must reset like any other edit.
            Ok(adr) => {
                self.notice = Some(format!("promoted to {adr}"));
                vec![self.reparse(ports, change)]
            }
            Err(reason) => {
                self.notice = Some(reason);
                Vec::new()
            }
        }
    }
}

fn has_modifier(key: &KeyEvent) -> bool {
    key.modifiers
        .intersects(crossterm::event::KeyModifiers::CONTROL | crossterm::event::KeyModifiers::ALT)
}

fn styled(text: impl Into<String>, color: Color) -> Line<'static> {
    Line::from(Span::styled(text.into(), Style::default().fg(color)))
}

/// The key hints, the prompt, the marking question or the help — one at a
/// time, under the progress bar.
fn footer(review: &Review, findings: &[Finding]) -> Vec<Line<'static>> {
    if let Some((kind, draft)) = &review.prompt {
        let ask = match kind {
            PromptKind::Reject => "Why reject? ",
            PromptKind::Defer => "What would verify it? ",
        };
        let hint = if *kind == PromptKind::Defer && draft.trim().is_empty() {
            "   (a reason is required)   esc cancel"
        } else {
            "   enter confirm · esc cancel"
        };
        return vec![Line::from(vec![
            Span::styled(ask, Style::default().fg(theme::WARN)),
            Span::styled(format!("{draft}_"), Style::default().fg(theme::TEXT)),
            Span::styled(hint, Style::default().fg(theme::DIM)),
        ])];
    }
    if review.marking {
        return vec![styled(
            format!(
                "Mark which as an example? 1-{} · any other key cancels",
                findings.len()
            ),
            theme::WARN,
        )];
    }
    if review.help {
        return vec![
            styled(
                "a accept · r reject (asks why) · d defer (asks what would verify it)",
                theme::TEXT,
            ),
            styled(
                "e edit in $EDITOR · s skip · n/p move · q back · any key closes",
                theme::TEXT,
            ),
        ];
    }
    let keys = if review.promotable() {
        "a accept · r reject · e edit · p promote to ADR · s skip · ? help · q back"
    } else if !findings.is_empty() {
        "a accept · r reject · e edit · d defer · m mark example · s skip · ? help · q back"
    } else {
        "a accept · r reject · e edit · d defer · s skip · n/p move · ? help · q back"
    };
    vec![styled(keys, theme::DIM)]
}

/// The item itself: where it sits, what it says, and what state it is in.
fn item_lines(review: &Review, findings: &[Finding]) -> Vec<Line<'static>> {
    let Some(current) = review.current() else {
        return vec![styled(
            "No requirements in this change. Nothing to review.",
            theme::DIM,
        )];
    };
    let item = &current.item;
    let pos = position(&review.session);
    let noun = noun(current);
    let operation = item
        .operation()
        .map(|op| format!("   [{op}]"))
        .unwrap_or_default();
    let mut label = noun.to_owned();
    if let Some(first) = label.get_mut(0..1) {
        first.make_ascii_uppercase();
    }

    let mut out = vec![
        styled(
            format!(
                "{}   {noun} {} of {}{operation}",
                item.capability, pos.index, pos.total
            ),
            theme::DIM,
        ),
        Line::default(),
        styled(format!("{label}: {}", item.name), theme::ACCENT),
        Line::default(),
    ];
    // Examples are shown by value rather than inline braces: the braces are
    // noise on screen, but which values are illustrative is the point.
    for line in wrap(&render_examples(&item.text), 76) {
        out.push(styled(line, theme::TEXT));
    }
    out.push(Line::default());

    let examples = example_values(&item.text);
    if !examples.is_empty() {
        out.push(styled(
            format!("  examples, not contracts: {}", examples.join(", ")),
            theme::DIM,
        ));
        out.push(Line::default());
    }

    for scenario in item.scenarios() {
        out.push(styled(
            format!("  Scenario: {}", scenario.name),
            theme::ACCENT2,
        ));
        for line in &scenario.body {
            out.push(styled(format!("    {line}"), theme::TEXT));
        }
        out.push(Line::default());
    }

    if review.promotable() {
        out.push(styled(
            "  this decision is marked global — p promotes it to a project-wide ADR",
            theme::ACCENT2,
        ));
        out.push(Line::default());
    }

    // Advisory only — a finding can never block a stage.
    if !findings.is_empty() {
        for (i, finding) in findings.iter().enumerate() {
            out.push(styled(
                format!("  {}. {}: {}", i + 1, finding.question, finding.value),
                theme::WARN,
            ));
        }
        out.push(Line::default());
    }

    // Honest state: drift is never silent.
    if current.drifted {
        out.push(styled(
            format!(
                "  ! changed since you marked it {} — review it again",
                current.review.state
            ),
            theme::WARN,
        ));
    } else if current.state != ReviewState::Pending {
        let note = current
            .review
            .note
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| format!(" — {n}"))
            .unwrap_or_default();
        out.push(styled(
            format!("  {}{note}", current.state),
            state_color(current.state),
        ));
    }
    out
}

/// Draws the review panel into `area`: the item, then — pinned to the
/// bottom, never scrolled away — the notice, the progress and the keys.
pub fn render_review(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let Some(review) = app.review.as_ref() else {
        return;
    };
    let findings = app.findings();
    frame.render_widget(
        panel(Some(&format!("{} › review", review.session.change)), true),
        area,
    );
    let inner = panel_inner(area);

    let footer = footer(review, &findings);
    let mut bottom: Vec<Line<'static>> = Vec::new();
    if let Some(notice) = &app.notice {
        bottom.push(styled(notice.clone(), theme::WARN));
    }
    // Constant region: progress never leaves the frame.
    bottom.push(styled(
        format!(
            "{}  {}",
            render_progress_bar(&review.session.summary, PROGRESS_BAR_WIDTH),
            render_counts(&review.session.summary)
        ),
        theme::DIM,
    ));
    bottom.extend(footer);

    let height = u16::try_from(bottom.len())
        .unwrap_or(u16::MAX)
        .min(inner.height);
    let body = Rect {
        height: inner.height - height,
        ..inner
    };
    // `padding: 1` around the item, as the TypeScript's box had.
    let padded = Rect {
        x: body.x + 1,
        y: body.y + 1,
        width: body.width.saturating_sub(2),
        height: body.height.saturating_sub(2),
    };
    let mut flow = Flow::new(padded);
    for line in item_lines(review, &findings) {
        flow.line(frame, line);
    }

    // `paddingLeft: 1`, as the TypeScript's footer boxes had.
    let mut flow = Flow::new(Rect {
        x: inner.x + 1,
        y: inner.y + inner.height - height,
        width: inner.width.saturating_sub(2),
        height,
    });
    for line in bottom {
        flow.line(frame, line);
    }
}
