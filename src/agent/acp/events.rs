//! What an ACP agent says, in the few shapes spec-tacular shows.
//!
//! The protocol's `session/update` carries a dozen kinds of update; the TUI
//! wants five — the reply as it streams, the agent's reasoning, its tool
//! calls (with any file diff), its plan, and the end of the turn — plus the
//! one request that needs a human: permission. [`map_update`] turns the
//! protocol's types into [`AcpEvent`]s, which are plain data: nothing here
//! holds a connection, so the mapping is tested by constructing updates.

use std::path::Path;

use agent_client_protocol::schema::v1::{
    ContentBlock, PermissionOptionKind, PlanEntryStatus, RequestPermissionRequest, SessionUpdate,
    StopReason, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdateFields, ToolKind,
};

/// One thing the agent did or asked, as the TUI and the job log use it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpEvent {
    /// A chunk of the agent's reply. Chunks are pieces, not lines.
    Text(String),
    /// A chunk of the agent's reasoning.
    Thought(String),
    /// A tool call started, or what is known about one changed.
    Tool(ToolUpdate),
    /// The agent's plan, whole — each update replaces the last.
    Plan(Vec<PlanStep>),
    /// The agent needs a decision before it goes on.
    Permission(PermissionAsk),
    /// What the session has cost so far, as the agent reports it: `$0.09`.
    Cost(String),
    /// The turn is over.
    TurnEnded(Stop),
    /// The agent is gone. `None` when it was closed on purpose; otherwise
    /// what happened — its exit, or the last thing it said on stderr.
    Closed(Option<String>),
}

/// Where a tool call is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    Pending,
    Running,
    Done,
    Failed,
}

impl ToolState {
    /// The glyph the running block puts before a tool call.
    pub fn glyph(self) -> &'static str {
        match self {
            ToolState::Pending => "○",
            ToolState::Running => "◐",
            ToolState::Done => "✓",
            ToolState::Failed => "✗",
        }
    }

    fn from_status(status: ToolCallStatus) -> Self {
        match status {
            ToolCallStatus::Pending => ToolState::Pending,
            ToolCallStatus::InProgress => ToolState::Running,
            ToolCallStatus::Completed => ToolState::Done,
            ToolCallStatus::Failed => ToolState::Failed,
            // A status added after this build: say it is still going.
            _ => ToolState::Running,
        }
    }
}

/// A file change a tool call carries, counted in lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffStat {
    /// Relative to the project when it is inside it.
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

impl DiffStat {
    /// `± proposal.md +42 −0` — the file's name, not its whole path: the
    /// block it is drawn in is narrow, and the change is known.
    pub fn summary(&self) -> String {
        let name = Path::new(&self.path)
            .file_name()
            .map_or_else(|| self.path.clone(), |n| n.to_string_lossy().into_owned());
        format!("± {name} +{} −{}", self.added, self.removed)
    }
}

/// What is known about a tool call from one update. `None` is "unchanged";
/// a `ToolCall` (the first word on it) fills everything in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolUpdate {
    pub id: String,
    pub title: Option<String>,
    /// `read`, `edit`, `execute`, … — the protocol's `ToolKind`, as a word.
    pub kind: Option<String>,
    pub state: Option<ToolState>,
    pub diffs: Option<Vec<DiffStat>>,
    pub locations: Option<Vec<String>>,
}

/// A tool call as the TUI keeps it: every update so far, merged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallView {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub state: ToolState,
    pub diffs: Vec<DiffStat>,
    pub locations: Vec<String>,
}

impl ToolCallView {
    /// A call first heard of through `update`.
    pub fn new(update: &ToolUpdate) -> Self {
        let mut view = Self {
            id: update.id.clone(),
            title: String::new(),
            kind: "other".to_owned(),
            state: ToolState::Pending,
            diffs: Vec::new(),
            locations: Vec::new(),
        };
        view.apply(update);
        view
    }

    /// Takes what `update` says, keeps what it does not.
    pub fn apply(&mut self, update: &ToolUpdate) {
        if let Some(title) = &update.title {
            self.title.clone_from(title);
        }
        if let Some(kind) = &update.kind {
            self.kind.clone_from(kind);
        }
        if let Some(state) = update.state {
            self.state = state;
        }
        if let Some(diffs) = &update.diffs {
            self.diffs.clone_from(diffs);
        }
        if let Some(locations) = &update.locations {
            self.locations.clone_from(locations);
        }
    }

    /// What the agent wants to do, for a permission prompt: "write
    /// openspec/changes/x/proposal.md" when it names a file, else its title.
    pub fn intent(&self) -> String {
        let verb = match self.kind.as_str() {
            "edit" => Some("write"),
            "delete" => Some("delete"),
            "move" => Some("move"),
            "read" => Some("read"),
            _ => None,
        };
        let path = self
            .diffs
            .first()
            .map(|d| d.path.clone())
            .or_else(|| self.locations.first().cloned());
        match (verb, path) {
            (Some(verb), Some(path)) => format!("{verb} {path}"),
            _ if !self.title.is_empty() => format!("run: {}", self.title),
            _ => "use a tool".to_owned(),
        }
    }
}

/// One step of the agent's plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub text: String,
    pub done: bool,
    pub active: bool,
}

/// What a permission option does, whatever the agent calls it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChoiceKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

impl ChoiceKind {
    /// The label the overlay shows: the same four words for every agent, so
    /// `1` is always "allow once".
    pub fn label(self) -> &'static str {
        match self {
            ChoiceKind::AllowOnce => "allow once",
            ChoiceKind::AllowAlways => "allow always",
            ChoiceKind::RejectOnce => "deny",
            ChoiceKind::RejectAlways => "deny always",
        }
    }

    pub fn allows(self) -> bool {
        matches!(self, ChoiceKind::AllowOnce | ChoiceKind::AllowAlways)
    }
}

/// One of the options a permission request offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionChoice {
    /// The agent's id for it — what the answer carries back.
    pub id: String,
    /// The agent's own name for it.
    pub name: String,
    pub kind: ChoiceKind,
}

/// A permission request waiting for an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionAsk {
    /// This client's number for the request, to answer it by.
    pub id: u64,
    /// The tool call it is about, as the request describes it.
    pub tool: ToolUpdate,
    /// Allow first, deny last, in [`ChoiceKind`] order — the agent's order
    /// within a kind.
    pub choices: Vec<PermissionChoice>,
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// The agent finished.
    EndTurn,
    /// Cancelled, from here.
    Cancelled,
    /// It ran out of tokens or turns, or refused.
    Limit(String),
    /// The prompt failed: the agent answered it with an error.
    Failed(String),
}

impl Stop {
    fn from_reason(reason: StopReason) -> Self {
        match reason {
            StopReason::EndTurn => Stop::EndTurn,
            StopReason::Cancelled => Stop::Cancelled,
            StopReason::MaxTokens => Stop::Limit("it ran out of tokens".to_owned()),
            StopReason::MaxTurnRequests => Stop::Limit("it ran out of turns".to_owned()),
            StopReason::Refusal => Stop::Limit("it refused".to_owned()),
            other => Stop::Limit(format!("{other:?}")),
        }
    }

    /// A stop reason off the wire.
    pub fn from_wire(reason: StopReason) -> Self {
        Self::from_reason(reason)
    }
}

/// `path` relative to `cwd` when it is inside it.
fn relative(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd).unwrap_or(path).display().to_string()
}

/// Added and removed lines between two texts: a longest-common-subsequence
/// count, so an edit in the middle of a file is not counted as the whole
/// file removed and written again. Large files fall back to comparing line
/// counts — a summary, not a diff tool.
pub fn line_changes(old: Option<&str>, new: &str) -> (usize, usize) {
    let old: Vec<&str> = old.map(|o| o.lines().collect()).unwrap_or_default();
    let new: Vec<&str> = new.lines().collect();
    if old.len().saturating_mul(new.len()) > 4_000_000 {
        return (
            new.len().saturating_sub(old.len()),
            old.len().saturating_sub(new.len()),
        );
    }
    let mut row = vec![0usize; new.len() + 1];
    for a in &old {
        let mut diagonal = 0;
        for (j, b) in new.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if a == b {
                diagonal + 1
            } else {
                above.max(row[j])
            };
            diagonal = above;
        }
    }
    let common = row[new.len()];
    (new.len() - common, old.len() - common)
}

fn kind_word(kind: ToolKind) -> String {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switch mode",
        _ => "other",
    }
    .to_owned()
}

fn diffs_of(content: &[ToolCallContent], cwd: &Path) -> Vec<DiffStat> {
    content
        .iter()
        .filter_map(|c| match c {
            ToolCallContent::Diff(diff) => {
                let (added, removed) = line_changes(diff.old_text.as_deref(), &diff.new_text);
                Some(DiffStat {
                    path: relative(&diff.path, cwd),
                    added,
                    removed,
                })
            }
            _ => None,
        })
        .collect()
}

fn from_call(call: &ToolCall, cwd: &Path) -> ToolUpdate {
    ToolUpdate {
        id: call.tool_call_id.0.to_string(),
        title: Some(call.title.clone()),
        kind: Some(kind_word(call.kind)),
        state: Some(ToolState::from_status(call.status)),
        diffs: Some(diffs_of(&call.content, cwd)),
        locations: Some(
            call.locations
                .iter()
                .map(|l| relative(&l.path, cwd))
                .collect(),
        ),
    }
}

fn from_fields(id: String, fields: &ToolCallUpdateFields, cwd: &Path) -> ToolUpdate {
    ToolUpdate {
        id,
        title: fields.title.clone(),
        kind: fields.kind.map(kind_word),
        state: fields.status.map(ToolState::from_status),
        diffs: fields.content.as_ref().map(|c| diffs_of(c, cwd)),
        locations: fields
            .locations
            .as_ref()
            .map(|ls| ls.iter().map(|l| relative(&l.path, cwd)).collect()),
    }
}

fn text_of(content: &ContentBlock) -> Option<String> {
    match content {
        ContentBlock::Text(text) => Some(text.text.clone()),
        _ => None,
    }
}

/// A `session/update` as events — none for the kinds nobody shows
/// (available commands, modes, usage, the user's own message echoed back).
/// Paths inside `cwd` come out relative to it.
pub fn map_update(update: &SessionUpdate, cwd: &Path) -> Vec<AcpEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => text_of(&chunk.content)
            .map(AcpEvent::Text)
            .into_iter()
            .collect(),
        SessionUpdate::AgentThoughtChunk(chunk) => text_of(&chunk.content)
            .map(AcpEvent::Thought)
            .into_iter()
            .collect(),
        SessionUpdate::ToolCall(call) => vec![AcpEvent::Tool(from_call(call, cwd))],
        SessionUpdate::ToolCallUpdate(update) => vec![AcpEvent::Tool(from_fields(
            update.tool_call_id.0.to_string(),
            &update.fields,
            cwd,
        ))],
        SessionUpdate::UsageUpdate(usage) => usage
            .cost
            .as_ref()
            .map(|cost| AcpEvent::Cost(format_cost(cost.amount, &cost.currency)))
            .into_iter()
            .collect(),
        SessionUpdate::Plan(plan) => vec![AcpEvent::Plan(
            plan.entries
                .iter()
                .map(|entry| PlanStep {
                    text: entry.content.clone(),
                    done: matches!(entry.status, PlanEntryStatus::Completed),
                    active: matches!(entry.status, PlanEntryStatus::InProgress),
                })
                .collect(),
        )],
        _ => Vec::new(),
    }
}

/// `$0.09` in dollars, `0.09 EUR` otherwise.
pub fn format_cost(amount: f64, currency: &str) -> String {
    if currency.eq_ignore_ascii_case("USD") {
        format!("${amount:.2}")
    } else {
        format!("{amount:.2} {currency}")
    }
}

/// A `session/request_permission` as the TUI asks it, numbered `id`.
pub fn permission_ask(id: u64, request: &RequestPermissionRequest, cwd: &Path) -> PermissionAsk {
    let mut choices: Vec<PermissionChoice> = request
        .options
        .iter()
        .map(|option| PermissionChoice {
            id: option.option_id.0.to_string(),
            name: option.name.clone(),
            kind: match option.kind {
                PermissionOptionKind::AllowOnce => ChoiceKind::AllowOnce,
                PermissionOptionKind::AllowAlways => ChoiceKind::AllowAlways,
                PermissionOptionKind::RejectAlways => ChoiceKind::RejectAlways,
                _ => ChoiceKind::RejectOnce,
            },
        })
        .collect();
    // Stable: two options of one kind keep the agent's order.
    choices.sort_by_key(|c| c.kind);
    PermissionAsk {
        id,
        tool: from_fields(
            request.tool_call.tool_call_id.0.to_string(),
            &request.tool_call.fields,
            cwd,
        ),
        choices,
    }
}

/// A turn's tool calls as its log tells them: one line when a call is first
/// heard of, and another only when its title, its state or its diff
/// changes — agents send many updates that change nothing worth a line, and
/// most of them name the call only by its id.
#[derive(Debug, Default)]
pub struct ToolLog {
    calls: Vec<ToolCallView>,
}

impl ToolLog {
    /// The line `update` is worth, if any: `✓ Write proposal.md  ± proposal.md +3 −1`.
    pub fn line(&mut self, update: &ToolUpdate) -> Option<String> {
        let (before, now) = match self.calls.iter_mut().find(|c| c.id == update.id) {
            Some(call) => {
                let before = call.clone();
                call.apply(update);
                (Some(before), call.clone())
            }
            None => {
                let call = ToolCallView::new(update);
                self.calls.push(call.clone());
                (None, call)
            }
        };
        let changed = before
            .is_none_or(|b| b.title != now.title || b.state != now.state || b.diffs != now.diffs);
        if !changed {
            return None;
        }
        let title = if now.title.is_empty() {
            now.id.as_str()
        } else {
            now.title.as_str()
        };
        let mut line = format!("{} {title}", now.state.glyph());
        for diff in &now.diffs {
            line.push_str(&format!("  {}", diff.summary()));
        }
        Some(line)
    }

    /// The title a call is known by, if it has one.
    pub fn title(&self, id: &str) -> Option<&str> {
        self.calls
            .iter()
            .find(|c| c.id == id && !c.title.is_empty())
            .map(|c| c.title.as_str())
    }
}

/// How an event reads in the job's log, one line or none. Reply text is
/// not here: it arrives in pieces, and [`super::run`] joins it into lines;
/// nor are tool calls, which a [`ToolLog`] follows.
pub fn log_line(event: &AcpEvent) -> Option<String> {
    match event {
        // Cumulative, and sent often: the turn's last is logged at its end.
        AcpEvent::Text(_) | AcpEvent::Thought(_) | AcpEvent::Cost(_) | AcpEvent::Tool(_) => None,
        AcpEvent::Plan(steps) => Some(format!(
            "plan: {}",
            steps
                .iter()
                .map(|s| format!("{} {}", if s.done { "☑" } else { "☐" }, s.text))
                .collect::<Vec<_>>()
                .join(" · ")
        )),
        // Logged by [`super::run`], which knows the call's title.
        AcpEvent::Permission(_) => None,
        AcpEvent::TurnEnded(stop) => Some(match stop {
            Stop::EndTurn => "done".to_owned(),
            Stop::Cancelled => "cancelled".to_owned(),
            Stop::Limit(why) => format!("stopped: {why}"),
            Stop::Failed(why) => format!("failed: {why}"),
        }),
        AcpEvent::Closed(None) => None,
        AcpEvent::Closed(Some(why)) => Some(format!("the agent stopped: {why}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        ContentChunk, Diff, PermissionOption, Plan, PlanEntry, PlanEntryPriority, TextContent,
        ToolCallLocation, ToolCallUpdate,
    };

    fn cwd() -> &'static Path {
        Path::new("/p")
    }

    fn text(t: &str) -> ContentBlock {
        ContentBlock::Text(TextContent::new(t))
    }

    #[test]
    fn reply_and_reasoning_chunks_become_text_and_thought() {
        assert_eq!(
            map_update(
                &SessionUpdate::AgentMessageChunk(ContentChunk::new(text("po"))),
                cwd()
            ),
            [AcpEvent::Text("po".to_owned())]
        );
        assert_eq!(
            map_update(
                &SessionUpdate::AgentThoughtChunk(ContentChunk::new(text("hmm"))),
                cwd()
            ),
            [AcpEvent::Thought("hmm".to_owned())]
        );
    }

    #[test]
    fn a_tool_call_carries_its_title_kind_state_and_diff_relative_to_the_project() {
        let call = ToolCall::new("t1", "Write proposal.md")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Pending)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/p/openspec/changes/x/proposal.md", "a\nb\nc\n").old_text("a\n"),
            )])
            .locations(vec![ToolCallLocation::new(
                "/p/openspec/changes/x/proposal.md",
            )]);
        let events = map_update(&SessionUpdate::ToolCall(call), cwd());
        let [AcpEvent::Tool(tool)] = events.as_slice() else {
            panic!("{events:?}");
        };
        assert_eq!(tool.id, "t1");
        assert_eq!(tool.title.as_deref(), Some("Write proposal.md"));
        assert_eq!(tool.kind.as_deref(), Some("edit"));
        assert_eq!(tool.state, Some(ToolState::Pending));
        let diffs = tool.diffs.clone().unwrap_or_default();
        assert_eq!(diffs[0].path, "openspec/changes/x/proposal.md");
        assert_eq!(diffs[0].summary(), "± proposal.md +2 −0");
        let view = ToolCallView::new(tool);
        assert_eq!(view.intent(), "write openspec/changes/x/proposal.md");
    }

    #[test]
    fn an_update_changes_only_what_it_names() {
        let mut view = ToolCallView::new(&ToolUpdate {
            id: "t1".to_owned(),
            title: Some("Write it".to_owned()),
            kind: Some("edit".to_owned()),
            state: Some(ToolState::Pending),
            diffs: Some(Vec::new()),
            locations: Some(vec!["a.md".to_owned()]),
        });
        let update = ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        );
        let events = map_update(&SessionUpdate::ToolCallUpdate(update), cwd());
        let [AcpEvent::Tool(tool)] = events.as_slice() else {
            panic!("{events:?}");
        };
        view.apply(tool);
        assert_eq!(view.state, ToolState::Done);
        assert_eq!(view.title, "Write it");
        assert_eq!(view.locations, ["a.md"]);
    }

    #[test]
    fn a_plan_is_its_steps() {
        let plan = Plan::new(vec![
            PlanEntry::new("Read", PlanEntryPriority::High, PlanEntryStatus::Completed),
            PlanEntry::new(
                "Write",
                PlanEntryPriority::High,
                PlanEntryStatus::InProgress,
            ),
        ]);
        assert_eq!(
            map_update(&SessionUpdate::Plan(plan), cwd()),
            [AcpEvent::Plan(vec![
                PlanStep {
                    text: "Read".to_owned(),
                    done: true,
                    active: false
                },
                PlanStep {
                    text: "Write".to_owned(),
                    done: false,
                    active: true
                },
            ])]
        );
    }

    #[test]
    fn a_permission_request_orders_allow_before_deny() {
        let request = RequestPermissionRequest::new(
            "s1",
            ToolCallUpdate::new(
                "t1",
                ToolCallUpdateFields::new()
                    .title("Write proposal.md")
                    .kind(ToolKind::Edit)
                    .locations(vec![ToolCallLocation::new("/p/proposal.md")]),
            ),
            vec![
                PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
                PermissionOption::new("always", "Always", PermissionOptionKind::AllowAlways),
                PermissionOption::new("once", "Allow", PermissionOptionKind::AllowOnce),
            ],
        );
        let ask = permission_ask(7, &request, cwd());
        assert_eq!(ask.id, 7);
        let ids: Vec<&str> = ask.choices.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["once", "always", "no"]);
        assert_eq!(ask.choices[2].kind.label(), "deny");
        assert_eq!(ToolCallView::new(&ask.tool).intent(), "write proposal.md");
    }

    #[test]
    fn usage_is_the_session_cost_when_the_agent_reports_one() {
        use agent_client_protocol::schema::v1::{Cost, UsageUpdate};
        let with = UsageUpdate::new(10, 100).cost(Cost::new(0.0891, "USD"));
        assert_eq!(
            map_update(&SessionUpdate::UsageUpdate(with), cwd()),
            [AcpEvent::Cost("$0.09".to_owned())]
        );
        assert!(map_update(
            &SessionUpdate::UsageUpdate(UsageUpdate::new(10, 100)),
            cwd()
        )
        .is_empty());
        assert_eq!(format_cost(1.5, "EUR"), "1.50 EUR");
    }

    #[test]
    fn line_changes_count_an_edit_not_a_rewrite() {
        assert_eq!(line_changes(None, "a\nb\n"), (2, 0));
        assert_eq!(line_changes(Some("a\nb\nc\n"), "a\nB\nc\n"), (1, 1));
        assert_eq!(line_changes(Some("a\nb\n"), "a\nb\nc\nd\n"), (2, 0));
        assert_eq!(line_changes(Some("a\nb\n"), ""), (0, 2));
    }

    #[test]
    fn the_tool_log_names_calls_by_title_and_skips_updates_that_change_nothing() {
        let mut log = ToolLog::default();
        let first = ToolUpdate {
            id: "toolu_1".to_owned(),
            title: Some("Terminal".to_owned()),
            state: Some(ToolState::Pending),
            ..ToolUpdate::default()
        };
        assert_eq!(log.line(&first).as_deref(), Some("○ Terminal"));
        let titled = ToolUpdate {
            id: "toolu_1".to_owned(),
            title: Some("ls -R".to_owned()),
            ..ToolUpdate::default()
        };
        assert_eq!(log.line(&titled).as_deref(), Some("○ ls -R"));
        assert_eq!(log.line(&titled), None, "nothing changed");
        let done = ToolUpdate {
            id: "toolu_1".to_owned(),
            state: Some(ToolState::Done),
            diffs: Some(vec![DiffStat {
                path: "x/proposal.md".to_owned(),
                added: 3,
                removed: 1,
            }]),
            ..ToolUpdate::default()
        };
        assert_eq!(
            log.line(&done).as_deref(),
            Some("✓ ls -R  ± proposal.md +3 −1")
        );
        assert_eq!(log.title("toolu_1"), Some("ls -R"));
        let bare = ToolUpdate {
            id: "toolu_2".to_owned(),
            ..ToolUpdate::default()
        };
        assert_eq!(log.line(&bare).as_deref(), Some("○ toolu_2"));
        assert_eq!(log.title("toolu_2"), None);
    }

    #[test]
    fn the_log_reads_plans_and_endings() {
        assert_eq!(
            log_line(&AcpEvent::TurnEnded(Stop::EndTurn)).as_deref(),
            Some("done")
        );
        assert_eq!(log_line(&AcpEvent::Text("x".to_owned())), None);
    }
}
