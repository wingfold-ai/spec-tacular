//! Coding agents, and the registry that picks one.
//!
//! `driver` defines the interface, `claude` and `opencode` implement it, and
//! `structured` is the one-shot request the TUI makes when it needs an answer
//! rather than a job. Nothing above this module names a vendor.
//!
//! Lands in stage 4.

pub mod claude;
pub mod driver;
pub mod opencode;
pub mod structured;
