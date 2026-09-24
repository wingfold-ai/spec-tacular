//! Claude Code driver.
//!
//! `claude -p` is the non-interactive mode. `stream-json` is used rather than
//! plain text because it arrives incrementally — a job pane that only fills in
//! once the agent finishes is not a job pane.
//!
//! Lands in stage 4.
