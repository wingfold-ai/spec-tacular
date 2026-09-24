//! ACP — the Agent Client Protocol — as the TUI's interactive agent layer.
//!
//! A job (`core::jobs`) hands an agent a prompt and reads its output back
//! from a file: one-way, headless, pre-approved. ACP is a conversation over
//! the agent's stdio instead: its reply streams as it is written, its tool
//! calls arrive as structured events with the diff they make, it asks before
//! it writes and the answer comes from a person, and the session stays open,
//! so a redraft is a follow-up in the same conversation rather than a
//! stranger starting over.
//!
//! - [`events`] — the protocol's updates as the few things the TUI shows;
//! - [`client`] — one agent process and its session ([`AcpSession`]);
//! - [`run`] — a session drafting one change, each turn recorded as a job
//!   ([`AcpRun`]);
//! - this module — which agent to talk to, and whether to use ACP at all.
//!
//! The TUI uses ACP when it can and jobs otherwise; `spectacular run` always
//! dispatches a job, because a job outlives the process that started it and
//! an ACP session, being a conversation, does not.

pub mod client;
pub mod events;
pub mod run;

use super::driver::AgentCommand;
use super::structured::on_path_in;

/// Chooses the agent layer: `acp` or `jobs`.
pub const AGENT_MODE_ENV: &str = "SPECTACULAR_AGENT_MODE";
/// The ACP agent's command line, instead of the driver's default.
pub const ACP_COMMAND_ENV: &str = "SPECTACULAR_ACP_COMMAND";

/// The npm package of Claude Code's ACP adapter.
pub const CLAUDE_ADAPTER: &str = "@agentclientprotocol/claude-agent-acp";

/// How the TUI's agent work runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentMode {
    /// Over ACP, with this agent command.
    Acp(AgentCommand),
    /// As detached jobs. `Some` says why ACP is not used when it would have
    /// been — the command could not be found; `None` means jobs were asked
    /// for.
    Jobs(Option<String>),
}

/// The ACP command for `driver`, found on `path`.
///
/// `opencode` speaks ACP itself (`opencode acp`). Claude Code needs its
/// adapter: `claude-agent-acp` when installed, else through `npx
/// --no-install`, which runs it only if it is already in npm's cache — a
/// TUI must not download packages behind your back.
fn default_command(driver: &str, path: &str) -> Result<AgentCommand, String> {
    match driver {
        "opencode" => {
            if on_path_in("opencode", path) {
                Ok(AgentCommand::new("opencode", ["acp"]))
            } else {
                Err("`opencode` is not installed".to_owned())
            }
        }
        "claude" => {
            if on_path_in("claude-agent-acp", path) {
                Ok(AgentCommand::new("claude-agent-acp", Vec::<String>::new()))
            } else if on_path_in("npx", path) {
                Ok(AgentCommand::new("npx", ["--no-install", CLAUDE_ADAPTER]))
            } else {
                Err(format!(
                    "Claude Code's ACP adapter is not installed (npm install -g {CLAUDE_ADAPTER})"
                ))
            }
        }
        other => Err(format!("no ACP agent is known for the {other} driver")),
    }
}

/// Which agent layer to use, from the driver, the two environment variables'
/// values and a search path — passed in, so this is testable without
/// touching the process environment.
///
/// `SPECTACULAR_AGENT_MODE=jobs` means jobs. Otherwise (`acp`, or unset)
/// ACP, when a command can be found: `SPECTACULAR_ACP_COMMAND` split on
/// whitespace, else the driver's default. When none can, jobs — with the
/// reason, for the notice.
pub fn resolve_mode(
    driver: &str,
    mode: Option<&str>,
    command: Option<&str>,
    path: &str,
) -> AgentMode {
    if mode.is_some_and(|m| m.trim().eq_ignore_ascii_case("jobs")) {
        return AgentMode::Jobs(None);
    }
    if let Some(command) = command.filter(|c| !c.trim().is_empty()) {
        let mut words = command.split_whitespace().map(str::to_owned);
        if let Some(program) = words.next() {
            if on_path_in(&program, path) {
                return AgentMode::Acp(AgentCommand::new(program, words));
            }
            return AgentMode::Jobs(Some(format!("`{program}` is not installed")));
        }
    }
    match default_command(driver, path) {
        Ok(command) => AgentMode::Acp(command),
        Err(why) => AgentMode::Jobs(Some(why)),
    }
}

/// [`resolve_mode`] over this process's environment.
pub fn agent_mode(driver: &str) -> AgentMode {
    resolve_mode(
        driver,
        std::env::var(AGENT_MODE_ENV).ok().as_deref(),
        std::env::var(ACP_COMMAND_ENV).ok().as_deref(),
        &std::env::var("PATH").unwrap_or_default(),
    )
}

/// The scripted agent the tests talk to (`tests/support/fake_acp_agent.rs`),
/// run with `args`. Cargo builds it next to the test binary's directory
/// whenever the package's tests are built.
#[cfg(test)]
pub fn fake_agent(args: &[&str]) -> AgentCommand {
    let exe = std::env::current_exe().expect("the test binary's path");
    // target/<triple>/debug/deps/spectacular-… → target/<triple>/debug/
    let dir = exe
        .parent()
        .and_then(std::path::Path::parent)
        .expect("the build directory");
    let fake = dir.join("fake-acp-agent");
    assert!(
        fake.exists(),
        "{} is missing — run the tests with plain `cargo test`, which builds it",
        fake.display()
    );
    AgentCommand::new(fake.display().to_string(), args.iter().copied())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// A directory holding executables named `names`, as a search path.
    fn bin(names: &[&str]) -> (TempDir, String) {
        let dir = TempDir::new().expect("dir");
        for name in names {
            fs::write(dir.path().join(name), "").expect("bin");
        }
        let path = dir.path().display().to_string();
        (dir, path)
    }

    #[test]
    fn opencode_speaks_acp_itself() {
        let (_dir, path) = bin(&["opencode"]);
        assert_eq!(
            resolve_mode("opencode", None, None, &path),
            AgentMode::Acp(AgentCommand::new("opencode", ["acp"]))
        );
    }

    #[test]
    fn claude_prefers_the_installed_adapter_then_npx_without_installing() {
        let (_dir, path) = bin(&["claude-agent-acp", "npx"]);
        assert_eq!(
            resolve_mode("claude", Some("acp"), None, &path),
            AgentMode::Acp(AgentCommand::new("claude-agent-acp", Vec::<String>::new()))
        );
        let (_dir, path) = bin(&["npx"]);
        assert_eq!(
            resolve_mode("claude", None, None, &path),
            AgentMode::Acp(AgentCommand::new("npx", ["--no-install", CLAUDE_ADAPTER]))
        );
    }

    #[test]
    fn jobs_when_asked_for_without_a_reason() {
        let (_dir, path) = bin(&["opencode"]);
        assert_eq!(
            resolve_mode("opencode", Some("jobs"), None, &path),
            AgentMode::Jobs(None)
        );
    }

    #[test]
    fn jobs_with_the_reason_when_no_agent_command_is_found() {
        let (_dir, path) = bin(&[]);
        let AgentMode::Jobs(Some(why)) = resolve_mode("claude", None, None, &path) else {
            panic!("no adapter and no npx must fall back to jobs");
        };
        assert!(why.contains("npm install -g"), "{why}");
        assert_eq!(
            resolve_mode("opencode", None, None, &path),
            AgentMode::Jobs(Some("`opencode` is not installed".to_owned()))
        );
    }

    #[test]
    fn the_override_is_a_command_line_that_must_exist() {
        let (_dir, path) = bin(&["my-agent"]);
        assert_eq!(
            resolve_mode("claude", None, Some("my-agent --acp -v"), &path),
            AgentMode::Acp(AgentCommand::new("my-agent", ["--acp", "-v"]))
        );
        assert_eq!(
            resolve_mode("claude", None, Some("missing-agent"), &path),
            AgentMode::Jobs(Some("`missing-agent` is not installed".to_owned()))
        );
    }
}
