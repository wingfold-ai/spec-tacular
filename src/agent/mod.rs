//! Coding agents, and the registry that picks one.
//!
//! `driver` defines the trait, `claude` and `opencode` implement it, and
//! `structured` is the one-shot request the TUI makes when it needs an answer
//! rather than a job. Nothing above this module names a vendor: commands ask
//! the registry for an id and get back something that builds a command line
//! and renders its output.

pub mod claude;
pub mod driver;
pub mod opencode;
pub mod structured;

use driver::DriverRegistry;

/// The drivers this build ships with.
///
/// A fixed registry rather than a plugin mechanism: two agents is what there
/// is, and the seam that matters — not naming a vendor above this module — is
/// already paid for by the trait.
pub fn default_registry() -> DriverRegistry {
    DriverRegistry::new()
        .register(Box::new(claude::ClaudeDriver))
        .register(Box::new(opencode::OpencodeDriver))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_both_drivers() {
        assert_eq!(default_registry().ids(), ["claude", "opencode"]);
    }

    #[test]
    fn a_driver_is_reachable_by_id_with_its_label() {
        let registry = default_registry();
        assert_eq!(registry.get("claude").expect("claude").label(), "Claude Code");
        assert_eq!(
            registry.get("opencode").expect("opencode").label(),
            "opencode"
        );
    }
}
