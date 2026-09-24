//! Drafting over ACP, end to end: the TUI against the scripted agent
//! (`tests/support/fake_acp_agent.rs`), a real child process speaking
//! JSON-RPC over its stdio — its reply and tool calls streaming into the
//! running block, its permission request answered from the overlay by key
//! and by click, `x` cancelling the turn, a redraft continuing the same
//! session, every turn recorded as a job, and the two ways back to detached
//! jobs.

use std::fs;

use crossterm::event::KeyCode;

use super::Ui;
use crate::core::jobs::{flush_recorders, list_jobs, JobStatus};
use crate::tui::app::Screen;
use crate::tui::fake::FakePorts;
use crate::tui::ports::DraftMode;

const PROPOSAL: &str = "openspec/changes/book-rooms/proposal.md";

/// A project ready for its first change, drafting over ACP with the
/// scripted agent playing `script`.
fn with_agent(script: &str) -> Ui {
    let ports = FakePorts::with_baseline();
    ports.use_acp(script);
    Ui::ready_for_first_change(ports)
}

/// …with `book-rooms` created and `w` pressed.
fn drafting(script: &str) -> Ui {
    let mut ui = with_agent(script);
    create_and_draft(&mut ui);
    ui
}

fn create_and_draft(ui: &mut Ui) {
    ui.char('n');
    ui.type_text("Let users book rooms");
    ui.press(KeyCode::Enter);
    ui.press(KeyCode::Enter); // accept the proposed name
    ui.expect("Created book-rooms.");
    ui.press(KeyCode::Enter); // ✦ Let an agent draft it
}

fn asking(ui: &Ui) -> bool {
    ui.app
        .acp
        .as_ref()
        .is_some_and(|a| !a.permissions.is_empty())
}

fn written(ui: &Ui) -> Option<String> {
    fs::read_to_string(ui.ports.path().join(PROPOSAL)).ok()
}

/// The session ids of the prompts the agent was sent, in order.
fn prompted_sessions(ui: &Ui) -> Vec<String> {
    ui.ports
        .agent_log()
        .lines()
        .filter_map(|l| l.strip_prefix("prompt "))
        .filter_map(|l| l.split_once(' ').map(|(_, s)| s.to_owned()))
        .collect()
}

#[test]
fn a_draft_streams_asks_permission_writes_when_allowed_and_opens() {
    let mut ui = drafting("draft");
    assert_eq!(ui.ports.dispatched(), ["acp book-rooms/proposal"]);
    ui.wait_until("the permission request", |app| {
        app.acp.as_ref().is_some_and(|a| !a.permissions.is_empty())
    });

    // The running block: the reply so far, the plan, the tool call and its
    // diff, what it has cost, and how to stop it.
    ui.expect("Fake agent is drafting the proposal");
    ui.expect("waiting for you");
    ui.expect("$0.01");
    ui.expect("Reading the ground rules.");
    ui.expect("Drafting the proposal.");
    ui.expect("plan 2/2 · Write openspec/changes/book-rooms/proposal.md");
    ui.expect("○ Write openspec/changes/book-rooms/proposal.md");
    ui.expect("± proposal.md +9 −0");
    ui.expect("quitting cancels it");
    ui.expect("Cancel  x");
    ui.expect("x  cancel");
    // The overlay.
    ui.expect("Fake agent asks");
    ui.expect("Fake agent wants to write openspec/changes/book-rooms/proposal.md");
    ui.expect("1 allow once · 2 allow always · 3 deny");
    assert!(written(&ui).is_none(), "written before it was allowed");

    ui.char('1');
    ui.expect_not("Fake agent asks");
    ui.wait_until("the draft to open", |app| app.screen == Screen::Document);
    ui.expect("book-rooms › proposal");
    ui.expect("Drafted over ACP.");
    ui.expect("✦ The proposal of book-rooms is drafted");
    assert!(written(&ui).is_some_and(|w| w.contains("Drafted over ACP.")));
    assert!(ui.ports.agent_log().contains("permission allow_once"));

    // Recorded as a job, driver `acp`, with the events as its log.
    flush_recorders();
    let jobs = list_jobs(ui.ports.path());
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].driver, "acp");
    assert_eq!(jobs[0].status, JobStatus::Succeeded);
    ui.char('q');
    ui.ctrl('j');
    ui.expect("book-rooms/proposal");
    ui.expect("? permission asked: Write openspec/changes/book-rooms/proposal.md");
    ui.expect("→ allowed once");
    ui.expect("cost: $0.01 for the session so far");
}

#[test]
fn a_denied_write_is_not_written_and_says_so() {
    let mut ui = drafting("draft");
    ui.wait_until("the permission request", |app| {
        app.acp.as_ref().is_some_and(|a| !a.permissions.is_empty())
    });
    ui.char('3');
    ui.wait_until("the turn to end", |app| {
        app.acp.as_ref().is_some_and(|a| !a.turn)
    });
    ui.expect(
        "You denied it (write openspec/changes/book-rooms/proposal.md) — Fake agent stopped \
         without writing the proposal",
    );
    assert_eq!(ui.app.screen, Screen::Overview);
    // The turn's record is still being written: it must not come back as
    // a job-shaped "running" block meanwhile.
    ui.expect_not("is drafting");
    assert!(written(&ui).is_none());
    assert!(ui.ports.agent_log().contains("permission reject_once"));
    // The step is still to draft it.
    ui.expect("✦ Let an agent draft it");
}

#[test]
fn numbers_typed_into_a_prompt_are_text_and_the_overlay_waits() {
    let mut ui = drafting("draft");
    ui.wait_until("the permission request", |app| {
        app.acp.as_ref().is_some_and(|a| !a.permissions.is_empty())
    });
    ui.char('n');
    ui.type_text("12 rooms");
    ui.expect("› 12 rooms▏");
    ui.expect("you are typing — click an option, or answer from the overview");
    assert!(asking(&ui), "a typed number answered the agent");
    ui.ctrl('c');
    ui.char('2');
    ui.wait_until("the draft to open", |app| app.screen == Screen::Document);
    assert!(ui.ports.agent_log().contains("permission allow_always"));
}

#[test]
fn x_cancels_the_turn_through_the_session() {
    let mut ui = drafting("slow");
    ui.wait_until("the agent to start talking", |app| {
        app.acp.as_ref().is_some_and(|a| !a.text.is_empty())
    });
    ui.expect("Thinking about it for a long time.");
    ui.char('x');
    ui.expect("Cancelling — Fake agent is stopping…");
    ui.expect("cancelling…");
    ui.wait_until("the turn to end", |app| {
        app.acp.as_ref().is_some_and(|a| !a.turn)
    });
    ui.expect("Cancelled — Fake agent stopped working on the proposal");
    assert!(ui.ports.agent_log().contains("cancel fake-session-"));
    flush_recorders();
    assert_eq!(list_jobs(ui.ports.path())[0].status, JobStatus::Cancelled);
    // The session outlives the cancelled turn.
    assert!(ui.app.acp.as_ref().is_some_and(|a| a.alive()));
}

#[test]
fn cancel_is_a_button_too_and_the_job_pane_cancels_through_the_session() {
    let mut ui = drafting("slow");
    ui.wait_until("the agent to start talking", |app| {
        app.acp.as_ref().is_some_and(|a| !a.text.is_empty())
    });
    let (x, y) = ui.find("Cancel  x");
    ui.click(x + 1, y);
    ui.wait_until("the turn to end", |app| {
        app.acp.as_ref().is_some_and(|a| !a.turn)
    });
    ui.expect("Cancelled — Fake agent stopped working on the proposal");

    // Again, from the job pane: `x`, then `y`.
    ui.press(KeyCode::Enter);
    ui.wait_until("the second turn to talk", |app| {
        app.acp
            .as_ref()
            .is_some_and(|a| a.turn && !a.text.is_empty())
    });
    ui.ctrl('j');
    ui.wait_until("the running turn in the pane", |app| {
        app.jobs.iter().any(|j| j.status == JobStatus::Running)
    });
    let running = ui
        .app
        .jobs
        .iter()
        .position(|j| j.status == JobStatus::Running)
        .expect("a running job");
    ui.app.job_index = running;
    ui.char('x');
    ui.char('y');
    ui.wait_until("the turn to end", |app| {
        app.acp.as_ref().is_some_and(|a| !a.turn)
    });
    assert!(
        ui.ports.cancelled().is_empty(),
        "the agent was killed, not asked"
    );
    assert_eq!(
        ui.ports.agent_log().matches("cancel fake-session-").count(),
        2
    );
}

#[test]
fn a_redraft_is_the_next_prompt_on_the_same_session() {
    let mut ui = drafting("draft");
    ui.wait_until("the permission request", |app| {
        app.acp.as_ref().is_some_and(|a| !a.permissions.is_empty())
    });
    // Answered by click, and for the session: the redraft does not ask.
    // The button, not the hint line above it.
    let (x, y) = ui.find("│  2 allow always");
    ui.click(x + 3, y);
    ui.wait_until("the draft to open", |app| app.screen == Screen::Document);

    ui.char('f');
    ui.type_text("mention cancellations");
    ui.press(KeyCode::Enter);
    assert_eq!(ui.app.screen, Screen::Overview);
    ui.expect("same session (fake-session");
    ui.wait_until("the redraft to open", |app| {
        app.screen == Screen::Document && app.acp.as_ref().is_some_and(|a| !a.turn)
    });
    ui.expect("mention cancellations");
    assert!(written(&ui).is_some_and(|w| w.contains("## Revised")));

    // One agent, one session, two prompts; `start_acp` only the once.
    assert_eq!(ui.ports.dispatched(), ["acp book-rooms/proposal"]);
    let sessions = prompted_sessions(&ui);
    assert_eq!(sessions.len(), 2, "{}", ui.ports.agent_log());
    assert_eq!(sessions[0], sessions[1]);
    assert_eq!(ui.ports.agent_log().matches("initialize").count(), 1);
    flush_recorders();
    let jobs = list_jobs(ui.ports.path());
    assert_eq!(jobs.len(), 2);
    assert!(jobs.iter().all(|j| j.status == JobStatus::Succeeded));
}

#[test]
fn a_redraft_after_the_agent_is_gone_starts_a_session_with_the_feedback() {
    let mut ui = drafting("draft");
    ui.wait_until("the permission request", |app| {
        app.acp.as_ref().is_some_and(|a| !a.permissions.is_empty())
    });
    ui.char('2');
    ui.wait_until("the draft to open", |app| app.screen == Screen::Document);
    // The agent goes away between turns.
    ui.app.shutdown();
    ui.char('f');
    ui.type_text("shorter");
    ui.press(KeyCode::Enter);
    assert_eq!(
        ui.ports.dispatched(),
        [
            "acp book-rooms/proposal",
            "acp book-rooms/proposal (shorter)"
        ]
    );
    ui.wait_until("the new session's question", |app| {
        app.acp.as_ref().is_some_and(|a| !a.permissions.is_empty())
    });
    ui.expect("Fake agent is redrafting the proposal");
    let sessions = prompted_sessions(&ui);
    assert_eq!(sessions.len(), 2);
    assert_ne!(sessions[0], sessions[1]);
}

#[test]
fn w_waits_while_the_session_is_mid_turn() {
    let mut ui = drafting("slow");
    ui.wait_until("the agent to start talking", |app| {
        app.acp.as_ref().is_some_and(|a| !a.text.is_empty())
    });
    ui.char('w');
    ui.expect("An agent is already working on book-rooms");
    assert_eq!(ui.ports.dispatched().len(), 1);
}

#[test]
fn quitting_mid_turn_asks_once_then_ends_the_session() {
    let mut ui = drafting("slow");
    ui.wait_until("the agent to start talking", |app| {
        app.acp.as_ref().is_some_and(|a| !a.text.is_empty())
    });
    let pid = ui
        .app
        .acp
        .as_ref()
        .and_then(|a| a.run.as_ref())
        .and_then(crate::agent::acp::run::AcpRun::pid)
        .expect("the agent's pid");
    ui.char('q');
    assert!(!ui.app.quit);
    ui.expect("q again quits and cancels it");
    ui.char('j'); // anything else keeps it
    ui.char('q');
    assert!(!ui.app.quit);
    ui.char('q');
    assert!(ui.app.quit);

    // What the event loop does on its way out.
    ui.app.shutdown();
    assert!(ui.app.acp.is_none());
    let gone = (0..200).any(|_| {
        // Killed is gone: a zombie waiting to be reaped counts.
        let state = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let alive = state
            .rsplit_once(") ")
            .is_some_and(|(_, rest)| !rest.starts_with('Z'));
        if alive {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        !alive
    });
    assert!(gone, "the agent outlived the TUI");
}

#[test]
fn a_crashed_agent_is_reported_and_the_change_is_free_again() {
    let mut ui = drafting("crash");
    ui.wait_until("the agent to go", |app| app.acp.is_none());
    ui.expect("Fake agent stopped:");
    flush_recorders();
    assert_eq!(list_jobs(ui.ports.path())[0].status, JobStatus::Failed);
}

#[test]
fn jobs_mode_dispatches_a_detached_job() {
    let ports = FakePorts::with_baseline();
    ports.use_acp("draft");
    *ports.draft_mode.lock().expect("mode") = DraftMode::Jobs { why: None };
    let mut ui = Ui::ready_for_first_change(ports);
    create_and_draft(&mut ui);
    assert_eq!(ui.ports.dispatched(), ["book-rooms/proposal"]);
    ui.expect("Claude Code is drafting the proposal");
    ui.expect_not("as a background job");
    assert!(ui.ports.agent_log().is_empty());
}

#[test]
fn no_acp_agent_falls_back_to_a_job_and_says_why() {
    let ports = FakePorts::with_baseline();
    *ports.draft_mode.lock().expect("mode") = DraftMode::Jobs {
        why: Some("`claude-agent-acp` is not installed".to_owned()),
    };
    let mut ui = Ui::ready_for_first_change(ports);
    create_and_draft(&mut ui);
    assert_eq!(ui.ports.dispatched(), ["book-rooms/proposal"]);
    ui.expect("(as a background job: `claude-agent-acp` is not installed)");
}

#[test]
fn an_agent_that_will_not_start_falls_back_to_a_job() {
    let ports = FakePorts::with_baseline();
    ports.use_acp("draft");
    *ports.acp.lock().expect("acp") = Some(crate::agent::driver::AgentCommand::new(
        "no-such-acp-agent",
        Vec::<String>::new(),
    ));
    let mut ui = Ui::ready_for_first_change(ports);
    create_and_draft(&mut ui);
    ui.wait_until("the fall-back job", |app| app.acp.is_none());
    assert_eq!(
        ui.ports.dispatched(),
        ["acp book-rooms/proposal", "book-rooms/proposal"]
    );
    ui.expect("(as a background job: the ACP agent did not start: `no-such-acp-agent`");
    ui.expect("Claude Code is drafting the proposal");
}
