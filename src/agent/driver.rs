//! Agent drivers.
//!
//! spec-tacular does not talk to a model. It builds a prompt and hands it to
//! whichever coding agent you already use, as a subprocess. Keeping that behind
//! a trait is deliberate: hardcoding one vendor would make the tool useless to
//! anyone using another, and the whole point of building on OpenSpec is that it
//! works with the tools you have.
//!
//! Building the command is separate from running it, in both directions: a
//! driver is tested by reading the argv it produces, and the job runner is
//! tested with a command that is not an agent at all.

use std::collections::BTreeMap;

/// What an agent is being asked to do.
///
/// `cwd` is carried although neither shipped driver reads it: an agent that
/// takes its working directory as an argument rather than inheriting it —
/// which the ACP integration in stage 9 does — needs it here, and a request
/// type that has to grow a field later is one every driver has to be touched
/// for.
#[derive(Debug, Clone)]
pub struct AgentRequest<'a> {
    /// The full prompt: OpenSpec's instructions plus the context bundle.
    pub prompt: &'a str,
    #[allow(dead_code)]
    pub cwd: &'a str,
}

/// How hard a one-shot structured request is allowed to work.
///
/// `Research` may look things up on the web (current versions); `Think`
/// reasons with no tools; `Quick` is a small offline task on a fast model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StructuredMode {
    /// The Foundation advisor: follow-ups, options, help.
    #[default]
    Research,
    /// Reasoning with no tools: the vision interview.
    Think,
    /// A small offline task on a fast model: proposing a change's name.
    Quick,
}

/// A structured request: a prompt, plus the JSON schema its answer must match.
#[derive(Debug, Clone)]
pub struct StructuredRequest<'a> {
    pub prompt: &'a str,
    /// As in [`AgentRequest`]: carried for the driver that will need it.
    #[allow(dead_code)]
    pub cwd: &'a str,
    pub schema: &'a serde_json::Value,
    pub mode: StructuredMode,
}

/// A command line, ready to run. `args` are argv entries, never a shell string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommand {
    pub command: String,
    pub args: Vec<String>,
}

impl AgentCommand {
    /// Builds one from anything string-shaped, which is most of the call sites.
    pub fn new<A: Into<String>>(
        command: impl Into<String>,
        args: impl IntoIterator<Item = A>,
    ) -> Self {
        AgentCommand {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }
}

/// A one-shot request answered as JSON matching a schema — for the advisor,
/// not for writing artifacts. A driver without one simply means no AI
/// suggestions during setup.
pub trait StructuredDriver: Send + Sync {
    fn build(&self, request: &StructuredRequest<'_>) -> AgentCommand;
    /// The structured value from the command's stdout.
    fn parse(&self, stdout: &str) -> Result<serde_json::Value, String>;
}

/// One coding agent spec-tacular knows how to drive.
pub trait AgentDriver: Send + Sync {
    fn id(&self) -> &'static str;
    /// Human-readable name for the job pane.
    fn label(&self) -> &'static str;
    /// The command to run. Building it is separate from running it so it is
    /// testable.
    fn build(&self, request: &AgentRequest<'_>) -> AgentCommand;
    /// Renders one line of the agent's stdout for display, or `None` to drop
    /// it. Agents emit a lot of protocol noise that nobody wants tailing past.
    fn format_line(&self, line: &str) -> Option<String>;
    /// The driver's structured mode, when it has one.
    fn structured(&self) -> Option<&dyn StructuredDriver> {
        None
    }
}

/// Passes stdout through unchanged. The right default for a plain-text agent.
pub fn passthrough(line: &str) -> Option<String> {
    (!line.trim().is_empty()).then(|| line.to_owned())
}

/// A driver id nobody registered.
#[derive(Debug, Clone)]
pub struct DriverNotFoundError {
    pub id: String,
    pub known: Vec<String>,
}

impl std::fmt::Display for DriverNotFoundError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Unknown agent driver '{}'. Known drivers: {}.",
            self.id,
            self.known.join(", ")
        )
    }
}

impl std::error::Error for DriverNotFoundError {}

/// The drivers this build knows.
///
/// Ordered, because the error message lists them and a set that reordered
/// itself between runs would make that message unquotable.
#[derive(Default)]
pub struct DriverRegistry {
    drivers: BTreeMap<&'static str, Box<dyn AgentDriver>>,
}

impl DriverRegistry {
    pub fn new() -> Self {
        DriverRegistry::default()
    }

    pub fn register(mut self, driver: Box<dyn AgentDriver>) -> Self {
        self.drivers.insert(driver.id(), driver);
        self
    }

    pub fn get(&self, id: &str) -> Result<&dyn AgentDriver, DriverNotFoundError> {
        match self.drivers.get(id) {
            Some(driver) => Ok(driver.as_ref()),
            None => Err(DriverNotFoundError {
                id: id.to_owned(),
                known: self.ids(),
            }),
        }
    }

    pub fn ids(&self) -> Vec<String> {
        self.drivers.keys().map(|id| (*id).to_owned()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_drops_blank_lines_only() {
        assert_eq!(passthrough("hello").as_deref(), Some("hello"));
        assert_eq!(passthrough("  "), None);
        assert_eq!(passthrough(""), None);
    }

    #[test]
    fn an_unknown_driver_names_the_ones_that_exist() {
        let registry = crate::agent::default_registry();
        let Err(err) = registry.get("nope") else {
            panic!("an unregistered id must not resolve");
        };
        assert!(err.to_string().contains("claude, opencode"), "{err}");
    }
}
