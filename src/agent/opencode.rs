//! opencode driver.
//!
//! `opencode run <prompt>` is its non-interactive entry point. Its output is
//! already human-readable, so nothing is reinterpreted here.

use super::driver::{passthrough, AgentCommand, AgentDriver, AgentRequest};

/// The opencode driver.
pub struct OpencodeDriver;

impl AgentDriver for OpencodeDriver {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn label(&self) -> &'static str {
        "opencode"
    }

    fn build(&self, request: &AgentRequest<'_>) -> AgentCommand {
        AgentCommand::new("opencode", ["run".to_owned(), request.prompt.to_owned()])
    }

    fn format_line(&self, line: &str) -> Option<String> {
        passthrough(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_its_non_interactive_run_subcommand() {
        let built = OpencodeDriver.build(&AgentRequest {
            prompt: "go",
            cwd: "/p",
        });
        assert_eq!(built, AgentCommand::new("opencode", ["run", "go"]));
    }

    #[test]
    fn passes_output_through_unchanged() {
        assert_eq!(
            OpencodeDriver.format_line("hello").as_deref(),
            Some("hello")
        );
        assert_eq!(OpencodeDriver.format_line("  "), None);
    }

    #[test]
    fn cannot_advise() {
        assert!(OpencodeDriver.structured().is_none());
    }
}
