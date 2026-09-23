//! The TUI's side of an ACP session: drafting in the conversation rather
//! than in a detached job.
//!
//! `w` ("✦ Let an agent draft it") and "↻ Redraft with feedback" come here.
//! With an ACP agent they open a session ([`App::start_draft`]), and what the
//! agent says streams into the change panel's running block — its reply's
//! last lines, its tool calls with their state, the diffs they make — while
//! the rest of the UI carries on. When it asks permission, an overlay asks
//! you ([`render_permission`]); only that decision waits for you. When the
//! turn ends, the draft opens as a job's does. A redraft is the next prompt
//! on the same session while it lives. Without an ACP agent, both go to a
//! detached job, as before.
//!
//! Events arrive one at a time: each [`Msg::AcpEvent`] re-arms the next
//! read, so there is always exactly one outstanding while the session lives,
//! and a session's generation number drops whatever a replaced one still
//! had in flight.

use chrono::{DateTime, Utc};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph};
use ratatui::Frame;

use super::app::{spawn, App, Effect, Hits, Msg, Screen, Target};
use super::ports::{DraftMode, Ports};
use super::theme;
use super::widgets::{buttons_height, clip, render_buttons, spinner_line, Button, Flow};
use crate::agent::acp::events::{AcpEvent, PermissionAsk, PlanStep, Stop, ToolCallView};
use crate::agent::acp::run::{AcpRun, RunStart};
use crate::core::jobs::Job;

/// How many lines of the agent's reply the running block shows.
pub const TEXT_LINES: usize = 6;
/// How many of its tool calls, newest last.
pub const TOOL_LINES: usize = 5;

/// A session, and what it has said this turn.
#[derive(Debug)]
pub struct AcpState {
    /// Which session this is: events of a replaced one are dropped.
    pub generation: u64,
    pub change: String,
    pub artifact: String,
    /// The agent's name, for the running block and the overlay.
    pub label: String,
    /// `None` while the agent is starting.
    pub run: Option<AcpRun>,
    /// A turn is in progress (or the session is starting to run one).
    pub turn: bool,
    /// This turn is a redraft.
    pub redraft: bool,
    /// The feedback this session was started with, for falling back to a
    /// job should the agent not start.
    pub feedback: Option<String>,
    pub started: DateTime<Utc>,
    /// The turn's reply so far.
    pub text: String,
    /// The agent is reasoning, and has not replied since.
    pub thinking: bool,
    pub tools: Vec<ToolCallView>,
    pub plan: Vec<PlanStep>,
    /// Permission requests waiting for you, oldest first; the overlay asks
    /// the first.
    pub permissions: Vec<PermissionAsk>,
    /// What you denied this turn.
    pub denied: Option<String>,
    /// `x` was pressed and the agent has not stopped yet.
    pub cancelling: bool,
    /// What the session has cost so far, when the agent says.
    pub cost: Option<String>,
}

impl AcpState {
    fn new(
        generation: u64,
        change: String,
        artifact: String,
        label: String,
        feedback: Option<String>,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            generation,
            change,
            artifact,
            label,
            run: None,
            turn: true,
            redraft: feedback.is_some(),
            feedback,
            started: now,
            text: String::new(),
            thinking: false,
            tools: Vec::new(),
            plan: Vec::new(),
            permissions: Vec::new(),
            denied: None,
            cancelling: false,
            cost: None,
        }
    }

    /// A fresh turn on the same session.
    fn next_turn(&mut self, artifact: String, now: DateTime<Utc>) {
        self.artifact = artifact;
        self.turn = true;
        self.redraft = true;
        self.started = now;
        self.text.clear();
        self.thinking = false;
        self.tools.clear();
        self.plan.clear();
        self.permissions.clear();
        self.denied = None;
        self.cancelling = false;
    }

    /// The session can take another prompt.
    pub fn alive(&self) -> bool {
        self.run.as_ref().is_some_and(AcpRun::is_alive)
    }

    /// The last `n` non-blank lines of the reply, whitespace squeezed.
    pub fn last_lines(&self, n: usize) -> Vec<String> {
        let lines: Vec<String> = self
            .text
            .lines()
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|l| !l.is_empty())
            .collect();
        lines[lines.len().saturating_sub(n)..].to_vec()
    }

    /// What the first waiting request is about.
    pub fn asking(&self) -> Option<(&PermissionAsk, String)> {
        let ask = self.permissions.first()?;
        let known = self.tools.iter().find(|t| t.id == ask.tool.id);
        let view = match known {
            Some(known) => {
                let mut view = known.clone();
                view.apply(&ask.tool);
                view
            }
            None => ToolCallView::new(&ask.tool),
        };
        Some((ask, view.intent()))
    }
}

/// The next event of `run`, as the message that carries it back.
fn pump(run: &AcpRun, generation: u64) -> Effect {
    let run = run.clone();
    spawn(Box::pin(async move { run.next().await }), move |event| {
        Msg::AcpEvent { generation, event }
    })
}

impl App {
    /// The session working on the selected change, if one is mid-turn.
    pub fn acp_working(&self) -> Option<&AcpState> {
        let name = &self.selected()?.name;
        self.acp.as_ref().filter(|a| a.turn && &a.change == name)
    }

    /// How long the turn has been going: `42s`, `3m07s`.
    pub fn acp_elapsed(&self) -> String {
        let Some(acp) = &self.acp else {
            return String::new();
        };
        let secs = (self.now - acp.started).num_seconds().max(0);
        if secs < 60 {
            format!("{secs}s")
        } else {
            format!("{}m{:02}s", secs / 60, secs % 60)
        }
    }

    /// Whether a redraft of `change` would continue a live session.
    pub fn acp_continues(&self, change: &str) -> bool {
        self.acp
            .as_ref()
            .is_some_and(|a| a.change == change && !a.turn && a.alive())
    }

    /// Drafts `artifact` of `change` — over ACP when there is an agent to
    /// talk to, else as a detached job. With `feedback` it is a redraft,
    /// continuing a live session on the change when there is one.
    pub(super) fn start_draft(
        &mut self,
        ports: &dyn Ports,
        change: String,
        artifact: String,
        feedback: Option<String>,
    ) -> Vec<Effect> {
        let label = match self.draft_mode.clone() {
            DraftMode::Jobs { why } => {
                return self.dispatch_job(ports, &change, &artifact, feedback.as_deref(), why)
            }
            DraftMode::Acp { label } => label,
        };
        if let Some(acp) = self.acp.as_ref().filter(|a| a.turn) {
            self.notice = Some(format!(
                "{} is still working on {} — x cancels it",
                acp.label, acp.change
            ));
            return Vec::new();
        }
        if let Some(feedback) = feedback.as_deref() {
            if self.acp_continues(&change) {
                return self.follow_up(ports, artifact, feedback);
            }
        }
        // One session at a time: a new one ends the last.
        if let Some(old) = self.acp.take() {
            if let Some(run) = old.run {
                run.close();
            }
        }
        let generation = self.latest.issue();
        self.latest.acp = generation;
        self.notice = Some(format!("Starting {label}…"));
        let work = ports.start_acp(&change, &artifact, feedback.as_deref());
        self.acp = Some(AcpState::new(
            generation, change, artifact, label, feedback, self.now,
        ));
        vec![spawn(work, move |result| Msg::AcpStarted {
            generation,
            result,
        })]
    }

    /// The redraft as the session's next turn.
    fn follow_up(&mut self, ports: &dyn Ports, artifact: String, feedback: &str) -> Vec<Effect> {
        let now = self.now;
        let Some(acp) = self.acp.as_mut() else {
            return Vec::new();
        };
        let Some(run) = acp.run.clone() else {
            return Vec::new();
        };
        acp.next_turn(artifact.clone(), now);
        let generation = acp.generation;
        let session: String = run.session_id().chars().take(12).collect();
        self.notice = Some(format!(
            "{} is redrafting the {artifact} with your feedback — same session ({session})",
            acp.label
        ));
        vec![spawn(
            ports.follow_up(&run, &artifact, feedback),
            move |result| Msg::AcpPrompted { generation, result },
        )]
    }

    /// The detached path: a job, with why it is not ACP when that is news.
    fn dispatch_job(
        &mut self,
        ports: &dyn Ports,
        change: &str,
        artifact: &str,
        feedback: Option<&str>,
        why: Option<String>,
    ) -> Vec<Effect> {
        vec![spawn(
            ports.dispatch(change, artifact, feedback),
            move |result| {
                Msg::Dispatched(result.map(|line| match why {
                    Some(why) => format!("{line} (as a background job: {why})"),
                    None => line,
                }))
            },
        )]
    }

    /// The session started — or would not.
    pub(super) fn acp_started(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        result: RunStart,
    ) -> Vec<Effect> {
        let current = self
            .acp
            .as_ref()
            .is_some_and(|a| a.generation == generation);
        if !current || generation != self.latest.acp {
            // Replaced while it started: nobody will read it.
            if let RunStart::Started(run) = result {
                run.close();
            }
            return Vec::new();
        }
        match result {
            RunStart::Started(run) => {
                let Some(acp) = self.acp.as_mut() else {
                    return Vec::new();
                };
                self.notice = Some(if acp.redraft {
                    format!(
                        "{} is redrafting the {} with your feedback",
                        acp.label, acp.artifact
                    )
                } else {
                    format!(
                        "{} is drafting the {} — it opens for you when done",
                        acp.label, acp.artifact
                    )
                });
                let effect = pump(&run, generation);
                acp.run = Some(run);
                vec![effect, self.read_jobs(ports, false)]
            }
            RunStart::Refused(why) => {
                self.acp = None;
                self.notice = Some(why);
                Vec::new()
            }
            RunStart::Unavailable(why) => {
                let Some(acp) = self.acp.take() else {
                    return Vec::new();
                };
                self.dispatch_job(
                    ports,
                    &acp.change,
                    &acp.artifact,
                    acp.feedback.as_deref(),
                    Some(format!("the ACP agent did not start: {why}")),
                )
            }
        }
    }

    /// A follow-up prompt was sent — or could not be.
    pub(super) fn acp_prompted(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        let Some(acp) = self.acp.as_mut().filter(|a| a.generation == generation) else {
            return Vec::new();
        };
        match result {
            Ok(()) => vec![self.read_jobs(ports, false)],
            Err(why) => {
                acp.turn = false;
                self.notice = Some(format!("Could not redraft: {why}"));
                Vec::new()
            }
        }
    }

    /// One event from the session.
    pub(super) fn acp_event(
        &mut self,
        ports: &dyn Ports,
        generation: u64,
        event: Option<AcpEvent>,
    ) -> Vec<Effect> {
        let Some(acp) = self.acp.as_mut().filter(|a| a.generation == generation) else {
            return Vec::new();
        };
        let Some(run) = acp.run.clone() else {
            return Vec::new();
        };
        let Some(event) = event else {
            return self.acp_closed(ports, None);
        };
        let mut effects = Vec::new();
        match event {
            AcpEvent::Text(text) => {
                acp.text.push_str(&text);
                acp.thinking = false;
            }
            AcpEvent::Thought(_) => acp.thinking = true,
            AcpEvent::Tool(update) => match acp.tools.iter_mut().find(|t| t.id == update.id) {
                Some(tool) => tool.apply(&update),
                None => acp.tools.push(ToolCallView::new(&update)),
            },
            AcpEvent::Plan(plan) => acp.plan = plan,
            AcpEvent::Cost(cost) => acp.cost = Some(cost),
            AcpEvent::Permission(ask) => acp.permissions.push(ask),
            AcpEvent::TurnEnded(stop) => effects.extend(self.turn_ended(ports, &run, stop)),
            AcpEvent::Closed(why) => return self.acp_closed(ports, why),
        }
        effects.push(pump(&run, generation));
        effects
    }

    /// The turn's job as this session knows it, into the job list now —
    /// its record on disk is written a moment later, and until the list is
    /// read again it would still say the turn is running.
    fn settle_turn_job(&mut self, run: &AcpRun) {
        if let Some(job) = run.job() {
            for listed in self.jobs.iter_mut().filter(|j| j.id == job.id) {
                listed.status = job.status;
            }
        }
    }

    /// The turn is over: say how, and let the draft open as a job's does.
    fn turn_ended(&mut self, ports: &dyn Ports, run: &AcpRun, stop: Stop) -> Vec<Effect> {
        self.settle_turn_job(run);
        let Some(acp) = self.acp.as_mut() else {
            return Vec::new();
        };
        acp.turn = false;
        acp.cancelling = false;
        acp.permissions.clear();
        let (label, change, artifact) =
            (acp.label.clone(), acp.change.clone(), acp.artifact.clone());
        let mut finished: Option<Job> = None;
        let notice = match stop {
            Stop::EndTurn => match acp.denied.take() {
                Some(denied) => format!(
                    "You denied it ({denied}) — {label} stopped without writing the {artifact}"
                ),
                None => {
                    finished = run.job();
                    format!("✦ The {artifact} of {change} is drafted")
                }
            },
            Stop::Cancelled => format!("Cancelled — {label} stopped working on the {artifact}"),
            Stop::Limit(why) => format!("{label} stopped: {why}"),
            Stop::Failed(why) => format!("{label} failed: {why}"),
        };
        vec![self.reload(ports, Some(change), Some(notice), finished.map(Box::new))]
    }

    /// The agent is gone.
    fn acp_closed(&mut self, ports: &dyn Ports, why: Option<String>) -> Vec<Effect> {
        let Some(acp) = self.acp.take() else {
            return Vec::new();
        };
        if let Some(run) = &acp.run {
            self.settle_turn_job(run);
        }
        if let Some(why) = why {
            self.notice = Some(format!("{} stopped: {why}", acp.label));
        }
        if acp.turn {
            // Its job record just changed.
            return vec![self.reload(ports, Some(acp.change), None, None)];
        }
        Vec::new()
    }

    /// `x`: asks the agent working on the selected change to stop.
    pub(super) fn cancel_acp(&mut self) -> bool {
        let Some(acp) = self.acp.as_mut().filter(|a| a.turn) else {
            return false;
        };
        let Some(run) = &acp.run else {
            return false;
        };
        run.cancel();
        acp.cancelling = true;
        // The client answers them as cancelled, as the protocol asks.
        acp.permissions.clear();
        self.notice = Some(format!("Cancelling — {} is stopping…", acp.label));
        true
    }

    /// `q` on the start screen or the overview. Jobs outlive the TUI; an
    /// ACP session does not, so with a turn running the first `q` says so
    /// and only a second one quits.
    pub(super) fn request_quit(&mut self) {
        if let Some(acp) = self.acp.as_ref().filter(|a| a.turn) {
            self.notice = Some(format!(
                "{} is still drafting the {} — q again quits and cancels it \
                 (`spectacular run` keeps work going after you quit)",
                acp.label, acp.artifact
            ));
            self.confirm_quit = true;
            return;
        }
        self.quit = true;
    }

    /// Where a confirming second `q` quits: where the first one could.
    pub(super) fn may_quit_here(&self) -> bool {
        !self.jobs_open
            && match self.screen {
                Screen::Home => true,
                Screen::Overview => self.prompt.is_none() && !self.help,
                _ => false,
            }
    }

    /// The TUI is going away: the session goes with it. Its turn, if one
    /// was running, is recorded as cancelled.
    pub fn shutdown(&mut self) {
        if let Some(run) = self.acp.take().and_then(|a| a.run) {
            run.close();
        }
    }

    /// Whether the job `id` is the live session's current turn.
    pub(super) fn is_acp_job(&self, id: &str) -> bool {
        self.acp
            .as_ref()
            .and_then(|a| a.run.as_ref())
            .and_then(AcpRun::job)
            .is_some_and(|job| job.id == id)
    }

    /// Answers the waiting permission request with its option `i`.
    pub(super) fn answer_permission(&mut self, i: usize) -> Vec<Effect> {
        let Some(acp) = self.acp.as_mut() else {
            return Vec::new();
        };
        let Some((ask, intent)) = acp.asking().map(|(a, i)| (a.clone(), i)) else {
            return Vec::new();
        };
        let Some(choice) = ask.choices.get(i) else {
            return Vec::new();
        };
        if let Some(run) = &acp.run {
            run.answer(ask.id, Some(choice));
        }
        acp.permissions.remove(0);
        if !choice.kind.allows() {
            acp.denied = Some(intent.clone());
        }
        self.notice = Some(format!("{}: {intent}", capitalised(choice.kind.label())));
        Vec::new()
    }

    /// Whether the permission overlay's number keys work here: everywhere
    /// but where a number is text being typed.
    pub fn permission_keys_live(&self) -> bool {
        if self.jobs_open {
            return !self.confirm_cancel;
        }
        match self.screen {
            Screen::Home => true,
            Screen::Overview => self.prompt.is_none() && !self.help,
            Screen::Document => self.doc.as_ref().is_some_and(|d| d.feedback.is_none()),
            Screen::Review => self
                .review
                .as_ref()
                .is_some_and(|r| r.prompt.is_none() && !r.marking && !r.help),
            Screen::Foundation | Screen::Vision => false,
        }
    }

    /// A number answering the overlay, when one is up and numbers are not
    /// being typed. `None` leaves the key to the screen.
    pub(super) fn permission_key(&mut self, key: &KeyEvent) -> Option<Vec<Effect>> {
        let asking = self.acp.as_ref().is_some_and(|a| !a.permissions.is_empty());
        if !asking || !self.permission_keys_live() || !key.modifiers.is_empty() {
            return None;
        }
        let KeyCode::Char(c) = key.code else {
            return None;
        };
        let n = c.to_digit(10).filter(|n| *n >= 1)?;
        let i = usize::try_from(n - 1).ok()?;
        let count = self
            .acp
            .as_ref()
            .and_then(|a| a.permissions.first())
            .map_or(0, |a| a.choices.len());
        (i < count).then(|| self.answer_permission(i))
    }
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The running block, for a change a session is working on: what the agent
/// is saying, its plan's current step, its tool calls and their diffs, and
/// what can be done meanwhile.
pub fn render_acp_block(
    frame: &mut Frame<'_>,
    flow: &mut Flow,
    app: &App,
    acp: &AcpState,
    hits: &mut Hits,
) {
    let doing = if acp.redraft {
        "redrafting"
    } else {
        "drafting"
    };
    let cost = acp
        .cost
        .as_ref()
        .map(|c| format!(" · {c}"))
        .unwrap_or_default();
    let state = if acp.cancelling {
        " · cancelling…".to_owned()
    } else if !acp.permissions.is_empty() {
        " · waiting for you".to_owned()
    } else if acp.run.is_none() {
        " · starting".to_owned()
    } else {
        String::new()
    };
    flow.blank();
    flow.line(
        frame,
        spinner_line(
            app.tick,
            &format!(
                "{} is {doing} the {} · {}{cost}{state}",
                acp.label,
                acp.artifact,
                app.acp_elapsed()
            ),
            theme::ACCENT2,
        ),
    );
    flow.blank();

    let width = usize::from(flow.area.width.saturating_sub(3)).max(10);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let text = acp.last_lines(TEXT_LINES);
    if text.is_empty() {
        let waiting = if acp.thinking {
            "thinking…"
        } else if acp.run.is_none() {
            "starting…"
        } else {
            "…"
        };
        lines.push(Line::from(Span::styled(
            waiting,
            Style::default().fg(theme::DIM),
        )));
    }
    for line in text {
        lines.push(Line::from(Span::styled(
            clip(&line, width),
            Style::default().fg(theme::DIM),
        )));
    }
    if let Some(step) = acp.plan.iter().find(|s| s.active) {
        let done = acp.plan.iter().filter(|s| s.done).count();
        lines.push(Line::from(Span::styled(
            clip(
                &format!("plan {}/{} · {}", done + 1, acp.plan.len(), step.text),
                width,
            ),
            Style::default().fg(theme::ACCENT2),
        )));
    }
    for tool in acp
        .tools
        .iter()
        .skip(acp.tools.len().saturating_sub(TOOL_LINES))
    {
        let color = match tool.state {
            crate::agent::acp::events::ToolState::Done => theme::OK,
            crate::agent::acp::events::ToolState::Failed => theme::ERR,
            _ => theme::TEXT,
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("{} ", tool.state.glyph()),
                Style::default().fg(color),
            ),
            Span::styled(
                clip(&tool.title, width.saturating_sub(2)),
                Style::default().fg(theme::TEXT),
            ),
        ]));
        for diff in &tool.diffs {
            lines.push(Line::from(Span::styled(
                format!("  {}", diff.summary()),
                Style::default().fg(theme::ACCENT),
            )));
        }
    }
    let height = u16::try_from(lines.len()).unwrap_or(u16::MAX);
    let block = flow.take(height);
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::LEFT)
                .border_style(Style::default().fg(theme::BORDER))
                .padding(Padding::left(1)),
        ),
        block,
    );
    flow.blank();
    flow.wrapped(
        frame,
        "It opens here for you to read when it is done. Keep working meanwhile — \
         but this session lives in the TUI: quitting cancels it (`spectacular run` \
         runs work that outlives the TUI).",
        Style::default().fg(theme::TEXT),
    );
    flow.blank();
    let rects = flow.buttons(
        frame,
        &[
            Button::new("Watch the full log  ctrl+j", false),
            Button::new("Cancel  x", false),
        ],
        None,
    );
    if let Some(Some(rect)) = rects.first() {
        hits.push((*rect, Target::WatchLog));
    }
    if let Some(Some(rect)) = rects.get(1) {
        hits.push((*rect, Target::CancelAcp));
    }
}

/// The permission overlay: what the agent wants to do and the options it
/// gave, numbered. Drawn over whatever screen is up: near the bottom, over
/// the empty end of the panels and clear of the running block it is about —
/// or, while a prompt at the bottom is taking your typing, just under the
/// header, so what you are typing stays in view. `area` is the whole frame.
pub fn render_permission(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    let Some(acp) = &app.acp else {
        return;
    };
    let Some((ask, intent)) = acp.asking() else {
        return;
    };
    let buttons: Vec<Button> = ask
        .choices
        .iter()
        .enumerate()
        .map(|(i, c)| Button::new(format!("{} {}", i + 1, c.kind.label()), i == 0))
        .collect();
    let width = area.width.saturating_sub(4).max(20);
    let inner_width = width.saturating_sub(4);
    let hint = if app.permission_keys_live() {
        let keys: Vec<String> = ask
            .choices
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{} {}", i + 1, c.kind.label()))
            .collect();
        keys.join(" · ")
    } else {
        "you are typing — click an option, or answer from the overview".to_owned()
    };
    let buttons_h = buttons_height(inner_width, &buttons);
    let height = (4 + buttons_h).min(area.height);
    let y = if app.permission_keys_live() {
        area.y + area.height.saturating_sub(height + 2)
    } else {
        area.y + 1.min(area.height.saturating_sub(height))
    };
    let rect = Rect::new(area.x + 2, y, width.min(area.width), height);
    frame.render_widget(Clear, rect);
    let more = if acp.permissions.len() > 1 {
        format!(" (1 of {})", acp.permissions.len())
    } else {
        String::new()
    };
    frame.render_widget(
        Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(theme::WARN))
            .title(Span::styled(
                format!(" ✦ {} asks{more} ", acp.label),
                Style::default()
                    .fg(theme::WARN)
                    .add_modifier(Modifier::BOLD),
            ))
            .style(Style::default().bg(theme::PANEL)),
        rect,
    );
    let inner = Rect::new(
        rect.x + 2,
        rect.y + 1,
        rect.width.saturating_sub(4),
        rect.height.saturating_sub(2),
    );
    let mut flow = Flow::new(inner);
    flow.line(
        frame,
        Line::from(Span::styled(
            clip(
                &format!("{} wants to {intent}", acp.label),
                usize::from(inner.width),
            ),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        )),
    );
    flow.line(
        frame,
        Line::from(Span::styled(
            clip(&hint, usize::from(inner.width)),
            Style::default().fg(theme::DIM),
        )),
    );
    let row = Rect::new(inner.x, flow.y, inner.width, buttons_h);
    let rects = render_buttons(frame, row, &buttons, None);
    for (i, rect) in rects.into_iter().enumerate() {
        if let Some(rect) = rect {
            hits.push((rect, Target::Permission(i)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::acp::events::{ChoiceKind, PermissionChoice, ToolState, ToolUpdate};

    fn state() -> AcpState {
        AcpState::new(
            1,
            "x".to_owned(),
            "proposal".to_owned(),
            "Agent".to_owned(),
            None,
            Utc::now(),
        )
    }

    #[test]
    fn the_reply_shows_its_last_non_blank_lines_squeezed() {
        let mut acp = state();
        acp.text = "one\n\n  two   words \nthree\nfour".to_owned();
        assert_eq!(acp.last_lines(2), ["three", "four"]);
        assert_eq!(acp.last_lines(9), ["one", "two words", "three", "four"]);
    }

    #[test]
    fn a_permission_is_described_by_the_tool_call_it_is_about() {
        let mut acp = state();
        acp.tools.push(ToolCallView::new(&ToolUpdate {
            id: "t1".to_owned(),
            title: Some("Write proposal.md".to_owned()),
            kind: Some("edit".to_owned()),
            state: Some(ToolState::Pending),
            diffs: Some(Vec::new()),
            locations: Some(vec!["openspec/changes/x/proposal.md".to_owned()]),
        }));
        acp.permissions.push(PermissionAsk {
            id: 1,
            tool: ToolUpdate {
                id: "t1".to_owned(),
                ..ToolUpdate::default()
            },
            choices: vec![PermissionChoice {
                id: "a".to_owned(),
                name: "Allow".to_owned(),
                kind: ChoiceKind::AllowOnce,
            }],
        });
        let (_, intent) = acp.asking().expect("asking");
        assert_eq!(intent, "write openspec/changes/x/proposal.md");
    }

    #[test]
    fn capitalised_raises_the_first_letter() {
        assert_eq!(capitalised("allow once"), "Allow once");
        assert_eq!(capitalised(""), "");
    }
}
