//! The application state, and everything that changes it.
//!
//! The Ratatui shape of the TypeScript `App` component: one [`App`] struct
//! holding what the Solid signals held, and handlers that take an event and
//! return the [`Effect`]s it asks for. Nothing here draws (that is
//! [`super::view`]) and nothing here waits: work that needs a subprocess
//! comes back as an [`Effect::Spawn`] whose result arrives later as a
//! [`Msg`]. That split is what lets a test drive the whole interface by
//! keystroke against a fake, with no terminal and no event loop.
//!
//! **ctrl+c never quits.** It is "back, or cancel, one level" everywhere: it
//! cancels the new-change prompt, closes help and the jobs pane, and on the
//! start screen and the overview — where there is no level left to go back
//! to — it says that `q` quits. `q` quits from those two, without asking:
//! jobs run detached and survive the TUI, so there is nothing to lose.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};

use super::acp::AcpState;
use super::document::Document;
use super::foundation::{FoundationScreen, GroundRules};
use super::input::{edit_line, is_cancel, is_ctrl, is_enter};
use super::ports::{DraftMode, JobsView, PortFuture, Ports, Snapshot, VisionAnswer};
use super::review::Review;
use super::vision::{StepKind, VisionButton, VisionScreen, VisionState};
use crate::agent::acp::events::AcpEvent;
use crate::agent::acp::run::{RunStart, ACP_DRIVER};
use crate::core::advisor::{AfterAnswer, Coached, Meta};
use crate::core::concreteness::LintConfig;
use crate::core::foundation::GuidedQuestion;
use crate::core::gate::stale_artifacts;
use crate::core::guide::{
    next_step, setup_step, validate_change_name, NextAction, NextStep, ProjectStage,
};
use crate::core::jobs::{Job, JobStatus};
use crate::core::naming::name_from_description;
use crate::core::pipeline::{ChangePipeline, StageState};
use crate::core::requirements::ReviewItem;
use crate::core::roadmap::{Roadmap, Slice};
use crate::core::session::ReviewSession;
use crate::core::vision::ProposedSlice;

/// Which screen is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// The logo, where the project stands, and one obvious next step.
    Home,
    /// The changes, and the selected one's pipeline and next step.
    Overview,
    /// One change's requirements and decisions, one at a time
    /// ([`super::review`]).
    Review,
    /// A drafted artifact, read in full ([`super::document`]).
    Document,
    /// The ground rules, one question at a time ([`super::foundation`]).
    Foundation,
    /// A new project's vision: described, interviewed, sliced
    /// ([`super::vision`]).
    Vision,
}

/// Which half of the new-change prompt is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptStep {
    /// What the change should do — asked first.
    Describe,
    /// Its name, proposed from the description — asked last, because it is
    /// the least important question.
    Name,
}

/// The new-change prompt: describe it, then name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub step: PromptStep,
    pub draft: String,
    pub description: String,
    /// Proposed names, best first; tab cycles them.
    pub names: Vec<String>,
    /// The name taken from the description's own words.
    pub quick: String,
    /// The developer typed into the name, so a late proposal must not
    /// overwrite it.
    pub name_edited: bool,
    /// A better name is being asked for.
    pub naming: bool,
}

impl Prompt {
    fn describe() -> Self {
        Self {
            step: PromptStep::Describe,
            draft: String::new(),
            description: String::new(),
            names: Vec::new(),
            quick: String::new(),
            name_edited: false,
            naming: false,
        }
    }
}

/// The start screen's own state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Home {
    /// The focused button; the first is the next step.
    pub focus: usize,
    /// Shown instead of the buttons while an action runs.
    pub busy: Option<String>,
    pub error: Option<String>,
}

/// One of the start screen's buttons, before Quit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeAction {
    Start,
    ContinueGroundRules,
    OpenProject,
    NewChange,
    FirstChange,
    GroundRules,
    DescribeVision,
    ContinueVision,
}

impl HomeAction {
    pub fn label(self) -> &'static str {
        match self {
            HomeAction::Start => "Start",
            HomeAction::ContinueGroundRules => "Continue ground rules",
            HomeAction::OpenProject => "Open project",
            HomeAction::NewChange => "New change",
            HomeAction::FirstChange => "Start your first change",
            HomeAction::GroundRules => "Ground rules",
            HomeAction::DescribeVision => "Describe your vision",
            HomeAction::ContinueVision => "Continue your vision",
        }
    }
}

/// What a next-step button on the selected change does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// The next step's own action.
    Next(NextAction),
    /// Open this artifact in the document viewer.
    Read(String),
}

/// A next-step button on the selected change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionButton {
    pub label: String,
    /// The key that does the same, shown on the button.
    pub key: &'static str,
    pub action: Action,
}

/// Something on screen a click lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    HomeButton(usize),
    ChangeRow(usize),
    Action(usize),
    NewChange,
    WatchLog,
    JobRow(usize),
    /// A button under an open document.
    DocButton(usize),
    /// Where the document's text is drawn — how its keys know what a page is.
    DocText,
    /// A row of the ground rules' choice list.
    GroundRow(usize),
    /// The ground rules' one button: Begin, or Continue.
    GroundButton,
    /// One of the vision screen's buttons.
    VisionButton(VisionButton),
    /// A row of the interview's choice list.
    VisionRow(usize),
    /// A proposed slice.
    SliceRow(usize),
    /// Option `i` of the permission overlay.
    Permission(usize),
    /// "Cancel  x" under an ACP session's running block.
    CancelAcp,
}

/// Where each clickable thing was drawn last frame.
pub type Hits = Vec<(Rect, Target)>;

/// Work the app asks for and does not do itself.
pub enum Effect {
    /// Run this and hand its result back through [`App::on_msg`].
    Spawn(PortFuture<Msg>),
    /// Hand the terminal to `$EDITOR` on `file`, then report back with
    /// [`Msg::EditorClosed`], which does `then`.
    Editor {
        file: PathBuf,
        line: usize,
        then: AfterEditor,
    },
}

/// What happens once the editor closes: whatever was on screen is re-read
/// from the file just edited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AfterEditor {
    /// Reload the overview, selecting this change.
    Reload { select: Option<String> },
    /// Re-parse the review queue of this change — the edit may be drift.
    Reparse { change: String },
    /// Read this document again.
    Document { change: String, artifact: String },
    /// Re-read the ground rules.
    Foundation,
}

pub(super) fn spawn<T: Send + 'static>(
    work: PortFuture<T>,
    to_msg: impl FnOnce(T) -> Msg + Send + 'static,
) -> Effect {
    Effect::Spawn(Box::pin(async move { to_msg(work.await) }))
}

/// Where setup was asked for. Either way it goes on to the ground rules;
/// this is where a failure is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterSetup {
    /// The start screen's Start.
    Home,
    /// Opening the ground rules of a project that had none.
    Overview,
}

/// A result coming back from an [`Effect`].
#[derive(Debug)]
pub enum Msg {
    Reloaded {
        /// Which request this answers — see [`Latest`].
        generation: u64,
        result: Result<Snapshot, String>,
        select: Option<String>,
        notice: Option<String>,
        /// A job that just finished, whose artifact should now exist.
        /// Boxed: a job record is most of this message's size, and it is
        /// rarely there.
        finished: Option<Box<Job>>,
    },
    SetUp {
        result: Result<(), String>,
        then: AfterSetup,
    },
    Created {
        name: String,
        result: Result<(), String>,
    },
    Dispatched(Result<String, String>),
    /// A change's review queue, or `None` when it has no specs.
    ReviewOpened {
        change: String,
        session: Option<Box<ReviewSession>>,
    },
    /// The review queue of `change`, re-parsed from disk.
    Reparsed {
        generation: u64,
        change: String,
        items: Vec<ReviewItem>,
    },
    /// A value of the current requirement was marked as an example.
    Marked {
        change: String,
        result: Result<(), String>,
    },
    /// A decision was promoted to an ADR; `Ok` carries its name.
    Promoted {
        change: String,
        result: Result<String, String>,
    },
    /// An artifact read for the document viewer.
    DocRead {
        generation: u64,
        change: String,
        artifact: String,
        result: Result<(PathBuf, String), String>,
        /// The job poll opened it, not the developer.
        just_drafted: bool,
    },
    ArtifactFile {
        change: String,
        result: Result<PathBuf, String>,
    },
    /// Better names for the change being described.
    Names {
        /// Which proposal this answers: one for an earlier description is
        /// dropped.
        generation: u64,
        names: Vec<String>,
    },
    /// The jobs as [`App::read_jobs`] asked for them, for the selection that
    /// was current then.
    JobsRead {
        view: JobsView,
        job_index: usize,
        change: Option<String>,
        /// From the poll: note jobs that stopped since the last read.
        poll: bool,
    },
    EditorClosed {
        result: Result<(), String>,
        then: AfterEditor,
    },
    /// The ground-rule questions and the advisor's memory, re-read.
    FoundationRead {
        generation: u64,
        questions: Vec<GuidedQuestion>,
        meta: Meta,
        /// Where the project stands, re-derived with them: the last answer
        /// moves it past the ground rules.
        stage: ProjectStage,
    },
    /// The advisor looked at the answer to the question `label` names.
    Advised {
        token: u64,
        label: String,
        result: Result<AfterAnswer, String>,
    },
    /// Options for a question were asked for.
    Suggested {
        label: String,
        id: String,
        result: Result<(), String>,
    },
    /// Help with a question came back.
    Coached {
        token: u64,
        label: String,
        result: Result<Coached, String>,
    },
    /// A follow-up was dismissed as not relevant.
    Dismissed {
        name: String,
        removed: bool,
    },
    /// A step of the vision interview came back.
    Vision {
        generation: u64,
        kind: StepKind,
        answer: VisionAnswer,
    },
    /// The vision and the roadmap were written; the first slice to start.
    VisionConfirmed {
        generation: u64,
        kept: Vec<ProposedSlice>,
        result: Result<Option<Slice>, String>,
    },
    /// The first slice's change was created.
    VisionCreated {
        generation: u64,
        name: String,
        notice: String,
        result: Result<(), String>,
    },
    /// An ACP session started drafting — or could not.
    AcpStarted {
        /// Which session this is: see [`AcpState::generation`].
        generation: u64,
        result: RunStart,
    },
    /// A follow-up prompt went to a live session — or could not.
    AcpPrompted {
        generation: u64,
        result: Result<(), String>,
    },
    /// The next thing an ACP session said; `None` once it is gone.
    AcpEvent {
        generation: u64,
        event: Option<AcpEvent>,
    },
}

/// The newest request of each kind whose answer replaces state wholesale.
///
/// Answers come back in whatever order the work finishes, so an older one
/// can land after a newer one — a reload started while a review was still
/// open, say, arriving after the one its closing asked for, and putting the
/// specs back as unreviewed. Each request takes the next number; an answer
/// older than the newest request of its kind is stale and is dropped.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Latest {
    next: u64,
    pub reload: u64,
    /// The reload whose snapshot is on screen.
    pub applied: u64,
    pub reparse: u64,
    pub doc: u64,
    /// The newest read of the ground rules.
    pub foundation: u64,
    /// The newest request for better names.
    pub names: u64,
    /// The newest request of the vision interview.
    pub vision: u64,
    /// The newest ACP session.
    pub acp: u64,
}

impl Latest {
    /// A fresh number, for a request about to be made.
    pub fn issue(&mut self) -> u64 {
        self.next += 1;
        self.next
    }
}

/// What a stale reload was carrying besides its snapshot, handed on to the
/// reload that supersedes it — a notice, a selection or a finished job must
/// not be lost just because fresher data overtook them.
#[derive(Debug, Default)]
pub struct Carried {
    pub select: Option<String>,
    pub notice: Option<String>,
    pub finished: Option<Box<Job>>,
}

/// The hint ctrl+c gives where there is nothing left to cancel.
pub const QUIT_HINT: &str = "ctrl+c goes back a level and never quits — q quits";

/// Everything the screens draw from.
pub struct App {
    pub root: String,
    pub screen: Screen,
    pub pipelines: Vec<ChangePipeline>,
    pub failed: Vec<String>,
    /// The selected change.
    pub index: usize,
    /// The line above the key bar.
    pub notice: Option<String>,
    pub jobs: Vec<Job>,
    pub job_index: usize,
    pub jobs_open: bool,
    /// The jobs pane is asking whether to cancel the selected job.
    pub confirm_cancel: bool,
    /// The selected job's log, rendered.
    pub job_lines: Vec<String>,
    /// The last lines of the agent working on the selected change.
    pub running_lines: Vec<String>,
    pub stage: ProjectStage,
    pub greenfield: bool,
    pub roadmap: Option<Roadmap>,
    pub help: bool,
    pub prompt: Option<Prompt>,
    pub home: Home,
    /// The focused next-step button on the selected change.
    pub action_focus: usize,
    /// The review in progress, on [`Screen::Review`].
    pub review: Option<Review>,
    /// The document being read, on [`Screen::Document`].
    pub doc: Option<Document>,
    /// Per-project linter tuning, read once at start.
    pub lint: LintConfig,
    /// Animation ticks since the screen was entered.
    pub tick: usize,
    pub now: DateTime<Utc>,
    /// The first reload has come back.
    pub loaded: bool,
    pub quit: bool,
    /// Where the clickable things were drawn, from the last frame.
    pub hits: Hits,
    /// The newest request of each kind, so stale answers can be dropped.
    pub latest: Latest,
    /// What stale reloads carried, for the reload that overtook them.
    pub carried: Carried,
    /// The ground rules and the advisor's work on them, across visits.
    pub ground: GroundRules,
    /// The ground-rules screen, on [`Screen::Foundation`].
    pub foundation: Option<FoundationScreen>,
    /// The vision and the model's work on it, across visits.
    pub vision: VisionState,
    /// The vision screen, on [`Screen::Vision`].
    pub vision_screen: Option<VisionScreen>,
    /// How `w` and a redraft reach an agent: an ACP session, or a job.
    pub draft_mode: DraftMode,
    /// The ACP session drafting, while there is one ([`super::acp`]).
    pub acp: Option<AcpState>,
    /// ACP turns that have ended, with how, until their records on disk say
    /// so too: a job list read in between must not bring them back as
    /// running.
    pub settled: Vec<(String, JobStatus)>,
    /// `q` was pressed once while an ACP turn was running: a second quits,
    /// and cancels it.
    pub confirm_quit: bool,
}

impl App {
    /// The app as it opens — on the start screen, reading the project.
    pub fn new(ports: &dyn Ports) -> (Self, Vec<Effect>) {
        let mut app = Self {
            root: ports.root().display().to_string(),
            screen: Screen::Home,
            pipelines: Vec::new(),
            failed: Vec::new(),
            index: 0,
            notice: None,
            jobs: Vec::new(),
            job_index: 0,
            jobs_open: false,
            confirm_cancel: false,
            job_lines: Vec::new(),
            running_lines: Vec::new(),
            stage: ports.stage(),
            greenfield: ports.greenfield(),
            roadmap: ports.roadmap(),
            help: false,
            prompt: None,
            home: Home {
                busy: Some("Reading the project…".to_owned()),
                ..Home::default()
            },
            action_focus: 0,
            review: None,
            doc: None,
            lint: ports.lint_config(),
            tick: 0,
            now: Utc::now(),
            loaded: false,
            quit: false,
            hits: Vec::new(),
            latest: Latest::default(),
            carried: Carried::default(),
            ground: GroundRules {
                note: ports.advisor_note(),
                ..GroundRules::default()
            },
            foundation: None,
            vision: VisionState {
                session: ports.vision_session(),
                note: ports.vision_note(),
                ..VisionState::default()
            },
            vision_screen: None,
            draft_mode: ports.draft_mode(),
            acp: None,
            settled: Vec::new(),
            confirm_quit: false,
        };
        let jobs = app.read_jobs(ports, false);
        let first = app.reload(ports, None, None, None);
        (app, vec![jobs, first])
    }

    // --- derived --------------------------------------------------------

    pub fn selected(&self) -> Option<&ChangePipeline> {
        self.pipelines.get(self.index)
    }

    /// Ground rules count as settled unless some question is still open.
    pub fn foundation_settled(&self) -> bool {
        !matches!(self.stage, ProjectStage::Foundation { .. })
    }

    /// The setup stepper's position, until there is a change.
    pub fn step(&self) -> Option<usize> {
        setup_step(&self.stage, self.greenfield)
    }

    pub fn next(&self) -> Option<NextStep> {
        self.selected()
            .map(|p| next_step(p, self.foundation_settled()))
    }

    /// The agent working on the selected change right now, if any.
    pub fn running(&self) -> Option<&Job> {
        let name = &self.selected()?.name;
        self.jobs
            .iter()
            .find(|j| j.status == JobStatus::Running && &j.change == name)
    }

    /// How long the running agent has been at it: `42s`, `3m07s`.
    pub fn elapsed(&self) -> String {
        let Some(job) = self.running() else {
            return String::new();
        };
        let secs = DateTime::parse_from_rfc3339(&job.started_at)
            .map(|started| {
                (self.now - started.with_timezone(&Utc))
                    .num_seconds()
                    .max(0)
            })
            .unwrap_or(0);
        if secs < 60 {
            format!("{secs}s")
        } else {
            format!("{}m{:02}s", secs / 60, secs % 60)
        }
    }

    /// The selected change's next step, as buttons.
    pub fn action_buttons(&self) -> Vec<ActionButton> {
        let Some(next) = self.next() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for action in &next.actions {
            let (label, key) = match action {
                NextAction::Review => ("▶ Review".to_owned(), "enter"),
                NextAction::Draft => (
                    if next.artifact.as_deref() == Some("apply") {
                        "▶ Start implementing".to_owned()
                    } else {
                        "✦ Let an agent draft it".to_owned()
                    },
                    "w",
                ),
                NextAction::Write => ("✎ Write it myself".to_owned(), "e"),
                NextAction::Foundation => ("▶ Ground rules".to_owned(), "f"),
            };
            out.push(ActionButton {
                label,
                key,
                action: Action::Next(*action),
            });
        }
        if let Some(latest) = self.readable().pop() {
            out.push(ActionButton {
                label: format!("📄 Read the {latest}"),
                key: "v",
                action: Action::Read(latest),
            });
        }
        out
    }

    /// The focused next-step button, clamped to the ones there are.
    pub fn focused_action(&self) -> usize {
        self.action_focus
            .min(self.action_buttons().len().saturating_sub(1))
    }

    /// The start screen's line on where the project stands.
    pub fn home_status(&self) -> String {
        match &self.stage {
            ProjectStage::NoOpenspec => {
                "This folder is not set up yet — Start sets it up here.".to_owned()
            }
            ProjectStage::NoFoundation => {
                "OpenSpec is here; spec-tacular is not set up yet.".to_owned()
            }
            ProjectStage::Foundation { answered, total } => {
                format!("Ground rules: {answered} of {total} answered.")
            }
            ProjectStage::Vision => "Ground rules are set. Now: what are you building?".to_owned(),
            ProjectStage::NoChanges => {
                "Ground rules are set — time for your first change.".to_owned()
            }
            ProjectStage::Working => {
                let n = self.pipelines.len();
                let waiting = self
                    .pipelines
                    .iter()
                    .filter(|p| {
                        p.current_stage()
                            .is_some_and(|s| s.state == StageState::Written)
                    })
                    .count();
                let mut line = format!("{n} change{}", if n == 1 { "" } else { "s" });
                if waiting > 0 {
                    line.push_str(&format!(" · {waiting} waiting for your review"));
                }
                line
            }
        }
    }

    /// The start screen's buttons, before Quit. The first is the next step.
    pub fn home_actions(&self) -> Vec<HomeAction> {
        match self.stage {
            ProjectStage::NoOpenspec | ProjectStage::NoFoundation => vec![HomeAction::Start],
            ProjectStage::Foundation { .. } => {
                vec![HomeAction::ContinueGroundRules, HomeAction::OpenProject]
            }
            ProjectStage::Vision => {
                let started = self
                    .vision
                    .session
                    .as_ref()
                    .is_some_and(|s| !s.vision.is_empty());
                vec![
                    if started {
                        HomeAction::ContinueVision
                    } else {
                        HomeAction::DescribeVision
                    },
                    HomeAction::GroundRules,
                ]
            }
            ProjectStage::NoChanges => vec![HomeAction::FirstChange, HomeAction::GroundRules],
            ProjectStage::Working => vec![
                HomeAction::OpenProject,
                HomeAction::NewChange,
                HomeAction::GroundRules,
            ],
        }
    }

    /// The key bar under the overview.
    pub fn overview_keys(&self) -> Vec<(&'static str, &'static str)> {
        if let Some(prompt) = &self.prompt {
            return match prompt.step {
                PromptStep::Describe => vec![("enter", "next: name it"), ("ctrl+c", "cancel")],
                PromptStep::Name => {
                    let mut keys = vec![("enter", "create")];
                    if prompt.names.len() > 1 {
                        keys.push(("tab", "next suggestion"));
                    }
                    keys.extend([("ctrl+u", "clear"), ("ctrl+c", "cancel")]);
                    keys
                }
            };
        }
        let buttons = self.action_buttons().len();
        let mut keys = Vec::new();
        if self.pipelines.len() > 1 {
            keys.push(("↑↓", "change"));
        }
        if buttons > 1 {
            keys.push(("←→", "action"));
        }
        if buttons > 0 {
            keys.push(("enter", "go"));
        }
        if self.acp_working().is_some() {
            keys.push(("x", "cancel"));
        }
        keys.extend([
            ("n", "new change"),
            ("f", "ground rules"),
            ("ctrl+j", "jobs"),
            ("?", "help"),
            ("q", "quit"),
        ]);
        keys
    }

    /// Whether anything on screen moves, so a tick is worth a redraw.
    pub fn animating(&self) -> bool {
        (self.screen == Screen::Home && !self.jobs_open)
            || self.home.busy.is_some()
            || self.prompt.as_ref().is_some_and(|p| p.naming)
            || (self.screen == Screen::Overview && self.running().is_some())
            || (self.screen == Screen::Overview && self.acp_working().is_some())
            || self.ground_animating()
            || self.vision_animating()
    }

    pub(super) fn taken(&self) -> Vec<String> {
        self.pipelines.iter().map(|p| p.name.clone()).collect()
    }

    // --- events ---------------------------------------------------------

    /// A terminal event: a key, a click, a resize.
    pub fn on_event(&mut self, ports: &dyn Ports, event: &Event) -> Vec<Effect> {
        match event {
            Event::Key(key) => self.on_key(ports, key),
            Event::Mouse(mouse) => self.on_mouse(ports, mouse),
            Event::Paste(text) => {
                if self.screen == Screen::Vision && !self.jobs_open {
                    self.vision_paste(text);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// One animation tick.
    pub fn on_tick(&mut self, now: DateTime<Utc>) {
        self.tick = self.tick.wrapping_add(1);
        self.now = now;
    }

    /// The job poll: while an agent runs, watch for it finishing — its
    /// artifact changes what the next step is, and making you restart to find
    /// out defeats the point of running it in the background.
    pub fn on_poll(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        if !self.jobs.iter().any(|j| j.status == JobStatus::Running) {
            return Vec::new();
        }
        // Read off the loop's thread: a directory listing and a log tail
        // every two seconds are file reads the frame must never wait on.
        vec![self.read_jobs(ports, true)]
    }

    /// A job poll came back: note any job that has stopped since the last
    /// one — the TypeScript's poll, run on its result rather than inline.
    fn notice_finished(&mut self, ports: &dyn Ports, before: &[Job]) -> Vec<Effect> {
        let finished: Vec<Job> = self
            .jobs
            .iter()
            .filter(|j| {
                j.status != JobStatus::Running
                    // A session reports its own turns as they end.
                    && j.driver != ACP_DRIVER
                    && before
                        .iter()
                        .any(|b| b.id == j.id && b.status == JobStatus::Running)
            })
            .cloned()
            .collect();
        let Some(last) = finished.last().cloned() else {
            return Vec::new();
        };
        self.notice = Some(if last.status == JobStatus::Succeeded {
            format!("✦ The {} of {} is drafted", last.artifact, last.change)
        } else {
            format!(
                "{}/{} {} — ctrl+j shows its log",
                last.change, last.artifact, last.status
            )
        });
        vec![self.reload(ports, None, None, Some(Box::new(last)))]
    }

    pub fn on_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        // Only presses: a terminal speaking the kitty protocol also reports
        // releases, and acting on both would do everything twice.
        if key.kind != KeyEventKind::Press {
            return Vec::new();
        }
        // A second `q` quits; anything else keeps the session.
        let confirming = std::mem::take(&mut self.confirm_quit);
        // The permission overlay's numbers, wherever a number is not text.
        if let Some(effects) = self.permission_key(key) {
            return effects;
        }
        if confirming && plain(key, 'q') && self.may_quit_here() {
            self.quit = true;
            return Vec::new();
        }
        // The job pane owns the keyboard while it is up — that is what makes
        // it a glance rather than a context switch.
        if self.jobs_open {
            return self.jobs_key(ports, key);
        }
        if is_ctrl(key, 'j') {
            return self.open_jobs(ports);
        }
        match self.screen {
            Screen::Home => self.home_key(ports, key),
            Screen::Overview => self.overview_key(ports, key),
            Screen::Review => self.review_key(ports, key),
            Screen::Document => self.document_key(ports, key),
            Screen::Foundation => self.foundation_key(ports, key),
            Screen::Vision => self.vision_key(ports, key),
        }
    }

    pub fn on_mouse(&mut self, ports: &dyn Ports, mouse: &MouseEvent) -> Vec<Effect> {
        if self.screen == Screen::Document && !self.jobs_open {
            match mouse.kind {
                MouseEventKind::ScrollDown => self.doc_wheel(true),
                MouseEventKind::ScrollUp => self.doc_wheel(false),
                _ => {}
            }
        }
        if mouse.kind != MouseEventKind::Down(MouseButton::Left) {
            return Vec::new();
        }
        let at = Position::new(mouse.column, mouse.row);
        let Some(target) = self
            .hits
            .iter()
            .find(|(rect, _)| rect.contains(at))
            .map(|(_, target)| *target)
        else {
            return Vec::new();
        };
        match target {
            Target::HomeButton(i) => {
                if self.home.busy.is_some() {
                    return Vec::new();
                }
                self.home.focus = i;
                self.home_press(ports, i)
            }
            Target::ChangeRow(i) => {
                self.index = i.min(self.pipelines.len().saturating_sub(1));
                self.action_focus = 0;
                self.running_lines.clear();
                vec![self.read_jobs(ports, false)]
            }
            Target::Action(i) => {
                self.action_focus = i;
                self.press_action(ports, i)
            }
            Target::NewChange => {
                self.start_new_change();
                Vec::new()
            }
            Target::WatchLog => self.open_jobs(ports),
            Target::JobRow(i) => self.select_job(ports, i),
            Target::DocButton(i) => self.press_doc(ports, i),
            Target::DocText => Vec::new(),
            Target::GroundRow(_) | Target::GroundButton => self.foundation_click(ports, target),
            Target::VisionButton(_) | Target::VisionRow(_) | Target::SliceRow(_) => {
                self.vision_click(ports, target)
            }
            Target::Permission(i) => self.answer_permission(i),
            Target::CancelAcp => {
                self.cancel_acp();
                Vec::new()
            }
        }
    }

    /// A result from spawned work, or from the editor.
    pub fn on_msg(&mut self, ports: &dyn Ports, msg: Msg) -> Vec<Effect> {
        match msg {
            Msg::Reloaded {
                generation,
                result,
                select,
                notice,
                finished,
            } => {
                if generation < self.latest.reload {
                    // Overtaken: its snapshot is older than one already
                    // asked for, and must not replace it.
                    if self.latest.applied < self.latest.reload {
                        // The newer one is still on its way: it takes what
                        // this one carried.
                        let carried = &mut self.carried;
                        carried.select = select.or(carried.select.take());
                        carried.notice = notice.or(carried.notice.take());
                        carried.finished = finished.or(carried.finished.take());
                        return Vec::new();
                    }
                    // The newer one is already here: what this one carried
                    // applies to the fresher state now on screen.
                    if let Some(i) = select
                        .as_deref()
                        .and_then(|name| self.pipelines.iter().position(|p| p.name == name))
                    {
                        self.index = i;
                        self.action_focus = 0;
                    }
                    if notice.is_some() {
                        self.notice = notice;
                    }
                    return match finished {
                        Some(job) => self.after_finished(ports, &job),
                        None => Vec::new(),
                    };
                }
                self.latest.applied = generation;
                let carried = std::mem::take(&mut self.carried);
                let select = select.or(carried.select);
                let notice = notice.or(carried.notice);
                let finished = finished.or(carried.finished);
                self.loaded = true;
                if self.home.busy.as_deref() == Some("Reading the project…") {
                    self.home.busy = None;
                }
                match result {
                    Ok(snapshot) => {
                        self.pipelines = snapshot.pipelines;
                        self.failed = snapshot.failed;
                        let found = select
                            .as_deref()
                            .and_then(|name| self.pipelines.iter().position(|p| p.name == name));
                        if let Some(i) = found {
                            self.index = i;
                            self.action_focus = 0;
                        } else {
                            self.index = self.index.min(self.pipelines.len().saturating_sub(1));
                        }
                        if notice.is_some() {
                            self.notice = notice;
                        }
                    }
                    Err(reason) => self.notice = Some(reason),
                }
                self.refresh_project(ports);
                // The selection may have moved to another change.
                let mut effects = vec![self.read_jobs(ports, false)];
                if let Some(job) = finished {
                    effects.extend(self.after_finished(ports, &job));
                }
                effects
            }
            Msg::SetUp { result, then } => {
                self.home.busy = None;
                if let Err(reason) = result {
                    match then {
                        AfterSetup::Home => {
                            self.home.error = Some(format!("Setup failed: {reason}"));
                        }
                        AfterSetup::Overview => self.notice = Some(reason),
                    }
                    return Vec::new();
                }
                self.refresh_project(ports);
                let mut effects = vec![self.reload(ports, None, None, None)];
                effects.extend(self.open_after_setup(ports));
                effects
            }
            Msg::Created { name, result } => match result {
                Ok(()) => {
                    let notice = format!("Created {name}.");
                    vec![self.reload(ports, Some(name), Some(notice), None)]
                }
                Err(reason) => {
                    self.notice = Some(reason);
                    Vec::new()
                }
            },
            Msg::Dispatched(result) => {
                self.notice = Some(match result {
                    Ok(message) | Err(message) => message,
                });
                vec![self.read_jobs(ports, false)]
            }
            Msg::JobsRead {
                view,
                job_index,
                change,
                poll,
            } => {
                let before = std::mem::replace(&mut self.jobs, view.jobs);
                self.overlay_settled();
                // Lines are only taken if nothing moved while they were being
                // read; if it did, the read that move asked for is on its way.
                if job_index == self.job_index {
                    self.job_lines = view.job_lines;
                }
                if change.as_deref() == self.selected().map(|p| p.name.as_str()) {
                    self.running_lines = view.running_lines;
                }
                self.job_index = self.job_index.min(self.jobs.len().saturating_sub(1));
                if poll {
                    return self.notice_finished(ports, &before);
                }
                Vec::new()
            }
            Msg::ReviewOpened { change, session } => {
                self.review_opened(&change, session);
                Vec::new()
            }
            Msg::Reparsed {
                generation,
                change,
                items,
            } => {
                if generation >= self.latest.reparse {
                    self.reparsed(&change, &items);
                }
                Vec::new()
            }
            Msg::Marked { change, result } => self.marked(ports, &change, result),
            Msg::Promoted { change, result } => self.promoted(ports, &change, result),
            Msg::DocRead {
                generation,
                change,
                artifact,
                result,
                just_drafted,
            } => {
                if generation >= self.latest.doc {
                    self.doc_read(change, artifact, result, just_drafted);
                }
                Vec::new()
            }
            Msg::ArtifactFile { change, result } => match result {
                Ok(file) => vec![Effect::Editor {
                    file,
                    line: 1,
                    then: AfterEditor::Reload {
                        select: Some(change),
                    },
                }],
                Err(reason) => {
                    self.notice = Some(reason);
                    Vec::new()
                }
            },
            Msg::Names {
                generation,
                names: proposed,
            } => {
                // A proposal for an earlier description — the prompt was
                // cancelled and started again — is not about this change.
                if generation < self.latest.names {
                    return Vec::new();
                }
                let Some(prompt) = self.prompt.as_mut() else {
                    return Vec::new();
                };
                prompt.naming = false;
                if prompt.step != PromptStep::Name || proposed.is_empty() {
                    return Vec::new();
                }
                let mut names: Vec<String> = Vec::new();
                for name in proposed.iter().chain(std::iter::once(&prompt.quick)) {
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
                prompt.names = names;
                // Never overwrite a name the developer already started
                // adjusting.
                if !prompt.name_edited {
                    prompt.draft = proposed[0].clone();
                }
                Vec::new()
            }
            Msg::EditorClosed { result, then } => match then {
                AfterEditor::Reload { select } => {
                    match result {
                        Ok(()) => self.notice = None,
                        Err(reason) => self.notice = Some(reason),
                    }
                    vec![self.reload(ports, select, None, None)]
                }
                AfterEditor::Reparse { change } => match result {
                    Ok(()) => vec![self.reparse(ports, &change)],
                    Err(reason) => {
                        self.notice = Some(reason);
                        Vec::new()
                    }
                },
                AfterEditor::Document { change, artifact } => {
                    self.doc_edited(ports, result, change, artifact)
                }
                AfterEditor::Foundation => self.foundation_edited(ports, result),
            },
            Msg::FoundationRead {
                generation,
                questions,
                meta,
                stage,
            } => self.foundation_read(ports, generation, questions, meta, stage),
            Msg::Advised {
                token,
                label,
                result,
            } => self.advised(ports, token, &label, result),
            Msg::Suggested { label, id, result } => self.suggested(ports, &label, id, result),
            Msg::Coached {
                token,
                label,
                result,
            } => self.coached(ports, token, &label, result),
            Msg::Dismissed { name, removed } => self.dismissed(ports, &name, removed),
            Msg::Vision {
                generation,
                kind,
                answer,
            } => self.vision_answered(ports, generation, kind, answer),
            Msg::VisionConfirmed {
                generation,
                kept,
                result,
            } => self.vision_confirmed(ports, generation, kept, result),
            Msg::VisionCreated {
                generation,
                name,
                notice,
                result,
            } => self.vision_created(ports, generation, name, notice, result),
            Msg::AcpStarted { generation, result } => self.acp_started(ports, generation, result),
            Msg::AcpPrompted { generation, result } => self.acp_prompted(ports, generation, result),
            Msg::AcpEvent { generation, event } => self.acp_event(ports, generation, event),
        }
    }

    // --- the start screen -----------------------------------------------

    fn home_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        if is_cancel(key) {
            self.notice = Some(QUIT_HINT.to_owned());
            return Vec::new();
        }
        if plain(key, 'q') {
            self.request_quit();
            return Vec::new();
        }
        if self.home.busy.is_some() {
            return Vec::new();
        }
        let total = self.home_actions().len() + 1; // + Quit
        match key.code {
            KeyCode::Enter | KeyCode::Char(' ') => {
                let focus = self.home.focus.min(total - 1);
                return self.home_press(ports, focus);
            }
            KeyCode::Right | KeyCode::Down | KeyCode::Tab => {
                self.home.focus = (self.home.focus + 1) % total;
            }
            KeyCode::Left | KeyCode::Up | KeyCode::BackTab => {
                self.home.focus = (self.home.focus + total - 1) % total;
            }
            _ => {}
        }
        Vec::new()
    }

    fn home_press(&mut self, ports: &dyn Ports, i: usize) -> Vec<Effect> {
        let actions = self.home_actions();
        let Some(action) = actions.get(i).copied() else {
            self.quit = true;
            return Vec::new();
        };
        self.notice = None;
        match action {
            HomeAction::Start => {
                self.home.busy = Some("Setting up the project…".to_owned());
                self.home.error = None;
                vec![spawn(ports.setup(), |result| Msg::SetUp {
                    result,
                    then: AfterSetup::Home,
                })]
            }
            HomeAction::ContinueGroundRules | HomeAction::GroundRules => {
                self.open_foundation(ports)
            }
            HomeAction::OpenProject => {
                self.enter_overview();
                Vec::new()
            }
            HomeAction::NewChange | HomeAction::FirstChange => {
                self.enter_overview();
                self.start_new_change();
                Vec::new()
            }
            HomeAction::DescribeVision | HomeAction::ContinueVision => {
                self.open_vision();
                Vec::new()
            }
        }
    }

    fn enter_overview(&mut self) {
        self.screen = Screen::Overview;
    }

    pub(super) fn enter_home(&mut self) {
        // Remounted, as the TypeScript's was: focus on the next step, and the
        // logo types itself in again.
        self.screen = Screen::Home;
        self.home.focus = 0;
        self.home.error = None;
        self.tick = 0;
        self.notice = None;
    }

    // --- the overview ---------------------------------------------------

    fn overview_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        if self.prompt.is_some() {
            return self.prompt_key(ports, key);
        }
        // Help is a transient overlay: any key closes it rather than acting.
        if self.help {
            self.help = false;
            return Vec::new();
        }
        if is_cancel(key) {
            self.notice = Some(QUIT_HINT.to_owned());
            return Vec::new();
        }
        let buttons = self.action_buttons().len();
        match key.code {
            KeyCode::Enter => {
                // Enter presses the focused button — the next step, unless
                // you moved.
                if buttons > 0 {
                    return self.press_action(ports, self.focused_action());
                }
                if self.pipelines.is_empty() && self.foundation_settled() {
                    self.start_new_change();
                }
                return Vec::new();
            }
            KeyCode::Down => return self.move_selection(ports, 1),
            KeyCode::Up => return self.move_selection(ports, -1),
            KeyCode::Tab | KeyCode::Right => {
                if buttons > 0 {
                    self.action_focus = (self.focused_action() + 1) % buttons;
                }
            }
            KeyCode::Left | KeyCode::BackTab => {
                if buttons > 0 {
                    self.action_focus = (self.focused_action() + buttons - 1) % buttons;
                }
            }
            KeyCode::Char(c) if !has_modifier(key) => match c {
                'q' => self.request_quit(),
                'x' => {
                    if !self.cancel_acp() {
                        self.notice = Some("Nothing to cancel here — ctrl+j lists the jobs".into());
                    }
                }
                'j' => return self.move_selection(ports, 1),
                'k' => return self.move_selection(ports, -1),
                'r' => return self.enter_review(ports),
                'v' => return self.read_latest(ports),
                'n' => self.start_new_change(),
                'w' => return self.draft_next(ports),
                'e' => return self.write_next(ports),
                'f' => return self.open_foundation(ports),
                'h' => self.enter_home(),
                '?' => self.help = true,
                _ => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn prompt_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        if is_cancel(key) {
            self.prompt = None;
            self.notice = None;
            return Vec::new();
        }
        if is_enter(key) {
            return self.submit_prompt(ports);
        }
        let Some(prompt) = self.prompt.as_mut() else {
            return Vec::new();
        };
        if key.code == KeyCode::Tab && prompt.step == PromptStep::Name && prompt.names.len() > 1 {
            // Cycles the proposals; a name you typed yourself is not lost to
            // it — it is simply not among them.
            let i = prompt.names.iter().position(|n| *n == prompt.draft);
            let next = i.map_or(0, |i| (i + 1) % prompt.names.len());
            prompt.draft = prompt.names[next].clone();
            prompt.name_edited = false;
        } else if let Some(edited) = edit_line(&prompt.draft, key) {
            prompt.draft = edited;
            if prompt.step == PromptStep::Name {
                prompt.name_edited = true;
            }
        }
        Vec::new()
    }

    fn submit_prompt(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let taken = self.taken();
        let Some(prompt) = self.prompt.as_mut() else {
            return Vec::new();
        };
        let text = prompt.draft.trim().to_owned();
        match prompt.step {
            PromptStep::Describe => {
                if text.is_empty() {
                    self.notice = Some("Describe the change first — a sentence is enough".into());
                    return Vec::new();
                }
                self.notice = None;
                let quick = name_from_description(&text, &taken);
                prompt.step = PromptStep::Name;
                prompt.description = text.clone();
                prompt.names = vec![quick.clone()];
                prompt.draft = quick.clone();
                prompt.quick = quick;
                prompt.name_edited = false;
                // Taken whether or not there is a model to ask: a proposal
                // still on its way for an earlier description is older than
                // this one either way.
                let generation = self.latest.issue();
                self.latest.names = generation;
                match ports.propose_names(&text, &taken) {
                    Some(work) => {
                        prompt.naming = true;
                        vec![spawn(work, move |names| Msg::Names { generation, names })]
                    }
                    None => Vec::new(),
                }
            }
            PromptStep::Name => {
                if let Some(problem) = validate_change_name(&text) {
                    self.notice = Some(problem);
                    return Vec::new();
                }
                if taken.contains(&text) {
                    self.notice = Some(format!("There is already a change called {text}"));
                    return Vec::new();
                }
                let description = prompt.description.clone();
                self.prompt = None;
                self.notice = None;
                let name = text.clone();
                vec![spawn(
                    ports.create_change(&text, &description),
                    move |result| Msg::Created { name, result },
                )]
            }
        }
    }

    fn move_selection(&mut self, ports: &dyn Ports, delta: isize) -> Vec<Effect> {
        let n = self.pipelines.len();
        if n == 0 {
            return Vec::new();
        }
        // Clamped, not wrapping: jumping to the far end at a list boundary
        // loses your place in a way that is disorienting in a review tool.
        let index = self.index.saturating_add_signed(delta).min(n - 1);
        if index == self.index {
            return Vec::new();
        }
        self.index = index;
        self.action_focus = 0;
        // Another change's agent output must not show under this one while
        // this one's is read.
        self.running_lines.clear();
        vec![self.read_jobs(ports, false)]
    }

    fn press_action(&mut self, ports: &dyn Ports, i: usize) -> Vec<Effect> {
        let Some(button) = self.action_buttons().into_iter().nth(i) else {
            return Vec::new();
        };
        match button.action {
            Action::Next(NextAction::Review) => self.enter_review(ports),
            Action::Next(NextAction::Draft) => self.draft_next(ports),
            Action::Next(NextAction::Write) => self.write_next(ports),
            Action::Next(NextAction::Foundation) => self.open_foundation(ports),
            Action::Read(artifact) => match self.selected().map(|p| p.name.clone()) {
                Some(change) => vec![self.open_doc(ports, &change, &artifact, false)],
                None => Vec::new(),
            },
        }
    }

    pub(super) fn start_new_change(&mut self) {
        if !self.foundation_settled() {
            self.notice = Some("Settle the ground rules first — f continues them".to_owned());
            return;
        }
        self.notice = None;
        self.prompt = Some(Prompt::describe());
    }

    pub(super) fn draft_next(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let name = self.selected().map(|p| p.name.clone());
        if self.running().is_some() {
            self.notice = Some(format!(
                "An agent is already working on {} — ctrl+j to watch it",
                name.unwrap_or_default()
            ));
            return Vec::new();
        }
        let next = self.next();
        let target = next.as_ref().and_then(|step| {
            step.actions
                .contains(&NextAction::Draft)
                .then(|| step.artifact.clone())
                .flatten()
        });
        let (Some(change), Some(artifact)) = (name, target) else {
            self.notice = Some(match next {
                Some(step) => format!("Nothing to draft — {}", step.text),
                None => "No change selected — n starts one".to_owned(),
            });
            return Vec::new();
        };
        self.start_draft(ports, change, artifact, None)
    }

    fn write_next(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let name = self.selected().map(|p| p.name.clone());
        let next = self.next();
        let target = next.as_ref().and_then(|step| {
            step.actions
                .contains(&NextAction::Write)
                .then(|| step.artifact.clone())
                .flatten()
        });
        let (Some(change), Some(artifact)) = (name, target) else {
            self.notice = Some(match next {
                Some(step) => format!("Nothing to write by hand — {}", step.text),
                None => "No change selected — n starts one".to_owned(),
            });
            return Vec::new();
        };
        let for_msg = change.clone();
        vec![spawn(
            ports.artifact_file(&change, &artifact),
            move |result| Msg::ArtifactFile {
                change: for_msg,
                result,
            },
        )]
    }

    // --- jobs -----------------------------------------------------------

    fn jobs_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        if self.confirm_cancel {
            // Cancelling throws away an agent's work in progress, so it asks
            // first, and anything but `y` is a no.
            self.confirm_cancel = false;
            if plain(key, 'y') {
                if let Some(job) = self.jobs.get(self.job_index).cloned() {
                    // A turn of the live session is stopped through it: its
                    // pid is the agent's, which the session still needs.
                    if !(self.is_acp_job(&job.id) && self.cancel_acp()) {
                        ports.cancel_job(&job);
                    }
                    return vec![self.read_jobs(ports, false)];
                }
            }
            return Vec::new();
        }
        if is_cancel(key) || is_ctrl(key, 'j') || plain(key, 'q') {
            self.jobs_open = false;
            return vec![self.reload(ports, None, None, None)];
        }
        match key.code {
            KeyCode::Down => return self.select_job(ports, self.job_index.saturating_add(1)),
            KeyCode::Up => return self.select_job(ports, self.job_index.saturating_sub(1)),
            KeyCode::Char('j') if !has_modifier(key) => {
                return self.select_job(ports, self.job_index.saturating_add(1));
            }
            KeyCode::Char('k') if !has_modifier(key) => {
                return self.select_job(ports, self.job_index.saturating_sub(1));
            }
            KeyCode::Char('x') if !has_modifier(key) => {
                if self
                    .jobs
                    .get(self.job_index)
                    .is_some_and(|j| j.status == JobStatus::Running)
                {
                    self.confirm_cancel = true;
                }
            }
            KeyCode::Char('p') if !has_modifier(key) => {
                let removed = ports.prune_jobs();
                self.notice = Some(format!(
                    "Cleared {removed} finished job{}",
                    if removed == 1 { "" } else { "s" }
                ));
                return vec![self.read_jobs(ports, false)];
            }
            _ => {}
        }
        Vec::new()
    }

    /// Re-reads from disk every time the pane opens: jobs record their own
    /// outcome, and a pane showing a job as running long after it stopped is
    /// worse than no pane.
    fn open_jobs(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        self.confirm_cancel = false;
        self.jobs_open = true;
        vec![self.read_jobs(ports, false)]
    }

    fn select_job(&mut self, ports: &dyn Ports, i: usize) -> Vec<Effect> {
        let index = i.min(self.jobs.len().saturating_sub(1));
        if index == self.job_index {
            return Vec::new();
        }
        self.job_index = index;
        vec![self.read_jobs(ports, false)]
    }

    /// The job list, the selected job's log and the running agent's latest
    /// lines, read off the loop's thread and delivered as
    /// [`Msg::JobsRead`]. Every path that shows jobs goes through here, so
    /// the pane, the header and the block under a change always agree.
    pub(super) fn read_jobs(&self, ports: &dyn Ports, poll: bool) -> Effect {
        let change = self.selected().map(|p| p.name.clone());
        let job_index = self.job_index;
        spawn(ports.read_jobs(job_index, change.as_deref()), move |view| {
            Msg::JobsRead {
                view,
                job_index,
                change,
                poll,
            }
        })
    }

    /// A job finished and the overview has been re-read.
    ///
    /// Exit 0 is not proof of work: an agent can finish without writing the
    /// file (denied, confused, out of turns). Say so rather than showing the
    /// same next step again as if nothing had happened. Otherwise what was
    /// drafted is what you want to see next — unless you are busy with
    /// something else, in which case it waits behind its button.
    fn after_finished(&mut self, ports: &dyn Ports, job: &Job) -> Vec<Effect> {
        if job.status != JobStatus::Succeeded {
            return Vec::new();
        }
        let stage = self
            .pipelines
            .iter()
            .find(|p| p.name == job.change)
            .and_then(|p| p.all_stages().find(|s| s.id == job.artifact));
        if stage.is_some_and(|s| matches!(s.state, StageState::Ready | StageState::Blocked)) {
            self.notice = Some(format!(
                "The agent finished but did not write the {} — ctrl+j shows what it did",
                job.artifact
            ));
            return Vec::new();
        }
        if self.idle() && self.selected().is_some_and(|p| p.name == job.change) {
            return vec![self.open_doc(ports, &job.change, &job.artifact, true)];
        }
        Vec::new()
    }

    // --- reloading ------------------------------------------------------

    /// Re-reads what a first run moves through, from disk, after any step.
    pub(super) fn refresh_project(&mut self, ports: &dyn Ports) {
        self.stage = ports.stage();
        self.greenfield = ports.greenfield();
        self.roadmap = ports.roadmap();
    }

    pub(super) fn reload(
        &mut self,
        ports: &dyn Ports,
        select: Option<String>,
        notice: Option<String>,
        finished: Option<Box<Job>>,
    ) -> Effect {
        let generation = self.latest.issue();
        self.latest.reload = generation;
        spawn(ports.reload(), move |result| Msg::Reloaded {
            generation,
            result,
            select,
            notice,
            finished,
        })
    }
}

/// What is worth flagging about a change, beyond its next step.
pub fn change_warnings(pipeline: &ChangePipeline) -> Vec<String> {
    let mut out = Vec::new();
    let specs = pipeline.stages.iter().find_map(|s| s.review);
    if let Some(drifted) = specs.map(|r| r.drifted).filter(|d| *d > 0) {
        out.push(format!(
            "{drifted} requirement(s) changed since you accepted them"
        ));
    }
    let stale = stale_artifacts(pipeline);
    if !stale.is_empty() {
        let names: Vec<&str> = stale.iter().map(|s| s.artifact.as_str()).collect();
        out.push(format!("{} may be stale", names.join(", ")));
    }
    if !pipeline.gaps.is_empty() {
        out.push(format!(
            "{} artifact(s) written before their prerequisite",
            pipeline.gaps.len()
        ));
    }
    out
}

/// A plain letter: no ctrl, no alt. Shift is allowed — it is how `?` and
/// capitals arrive.
fn plain(key: &KeyEvent, c: char) -> bool {
    key.code == KeyCode::Char(c) && !has_modifier(key)
}

fn has_modifier(key: &KeyEvent) -> bool {
    key.modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
}
